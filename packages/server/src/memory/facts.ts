import type { Actor, PresentedFact } from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError, invalid, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { searchVector, textVector } from '../records/search-sql.js';
import { lockRecord, resolveRecordId, type WriteContext } from '../records/write.js';
import { type CitedSource, lockSource, NOTE_CHANNEL } from './interactions.js';

/**
 * Facts (1.3): plain-language claims about a record, each citing the
 * interaction it rests on (rule 2.1). Valid from the source's
 * `occurred_at` (rule 2.6). A fact is current while it is not retracted or
 * superseded and at least one of its sources is live (2.1).
 */

export const rememberInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(5_000),
  source: z.uuid().optional(),
  quote: z.string().trim().min(1).max(5_000).optional(),
});
export type RememberInput = z.infer<typeof rememberInputSchema>;

export type { PresentedFact } from '@retainer/shared';

/** What `remember` returns (6.2). */
export type RememberResult = { fact: PresentedFact; noteInteraction: string | null };

type FactRow = {
  id: string;
  record_id: string;
  content: string;
  kind: 'stated' | 'inferred';
  valid_from: Date;
  valid_to: Date | null;
  actor: Actor;
};

/** The hash a `remember` idempotency key is bound to. */
export function rememberRequestHash(recordId: string, input: RememberInput): string {
  return requestHash({
    record: recordId,
    text: input.text,
    source: input.source ?? null,
    quote: input.quote ?? null,
  });
}

/**
 * Writes one `stated` fact about a record (6.2). With `source`, the fact
 * cites that interaction and is valid from its `occurred_at`. Without one,
 * a `note` interaction is created for it to cite, and it is valid from the
 * write time. Lock order matches retraction: the source, then the record.
 */
export async function rememberFact(
  tx: Tx,
  context: WriteContext,
  recordId: string,
  input: RememberInput,
): Promise<RememberResult> {
  if (input.quote !== undefined && input.source === undefined) {
    throw invalid('quote needs a source: pass the interaction the quote comes from');
  }
  let source: CitedSource | undefined;
  if (input.source) source = await lockSource(tx, context.workspaceId, input.source);
  const record = await lockRecord(tx, context.workspaceId, recordId);

  let noteInteraction: string | null = null;
  if (!source) {
    const [note] = await tx<{ id: string; occurred_at: Date }[]>`
      insert into interactions (workspace_id, kind, channel, occurred_at, summary, search,
        created_by)
      values (${context.workspaceId}, 'note', ${NOTE_CHANNEL}, clock_timestamp(), ${input.text},
        ${searchVector(tx, null, input.text)}, ${tx.json(context.actor)})
      returning id, occurred_at`;
    const created = note as { id: string; occurred_at: Date };
    await tx`
      insert into interaction_participants (workspace_id, interaction_id, position, record_id,
        link)
      values (${context.workspaceId}, ${created.id}, 0, ${record.id}, 'about')`;
    noteInteraction = created.id;
    source = { id: created.id, occurredAt: created.occurred_at };
  }

  const [inserted] = await tx<FactRow[]>`
    insert into facts (workspace_id, record_id, content, kind, valid_from, search, actor)
    values (${context.workspaceId}, ${record.id}, ${input.text}, 'stated', ${source.occurredAt},
      ${textVector(tx, input.text)}, ${tx.json(context.actor)})
    returning id, record_id, content, kind, valid_from, valid_to, actor`;
  const fact = inserted as FactRow;
  await tx`
    insert into fact_sources (workspace_id, fact_id, interaction_id, quote)
    values (${context.workspaceId}, ${fact.id}, ${source.id}, ${input.quote ?? null})`;

  return {
    fact: presentFact(fact, [{ interaction: source.id, quote: input.quote ?? null }]),
    noteInteraction,
  };
}

function presentFact(row: FactRow, sources: PresentedFact['sources']): PresentedFact {
  return {
    id: row.id,
    record: row.record_id,
    content: row.content,
    kind: row.kind,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    writtenBy: row.actor,
    sources,
  };
}

export type FactList = { record: string; facts: PresentedFact[] };

/**
 * A live record's current facts, newest `validFrom` first: not retracted,
 * not superseded, and resting on at least one live interaction (2.1, 5).
 * Only live sources are listed.
 */
export async function listFacts(
  tx: Tx,
  workspaceId: string,
  recordId: string,
  limit: number,
): Promise<FactList> {
  const canonical = await resolveRecordId(tx, workspaceId, recordId);
  const [record] = await tx<{ deleted_at: Date | null }[]>`
    select deleted_at from records where id = ${canonical} and workspace_id = ${workspaceId}`;
  if (record?.deleted_at) {
    throw new AppError(404, 'record_deleted', `record ${canonical} was deleted`, {
      recordId: canonical,
    });
  }
  const rows = await tx<FactRow[]>`
    select f.id, f.record_id, f.content, f.kind, f.valid_from, f.valid_to, f.actor from facts f
    where f.workspace_id = ${workspaceId} and f.record_id = ${canonical}
      and f.deleted_at is null and f.superseded_by is null and f.valid_to is null
      and exists (
        select 1 from fact_sources s
        join interactions i on i.id = s.interaction_id and i.deleted_at is null
        where s.fact_id = f.id)
    order by f.valid_from desc, f.created_at desc, f.id
    limit ${limit}`;
  const ids = rows.map((r) => r.id);
  const sources =
    ids.length === 0
      ? []
      : await tx<{ fact_id: string; interaction_id: string; quote: string | null }[]>`
          select s.fact_id, s.interaction_id, s.quote from fact_sources s
          join interactions i on i.id = s.interaction_id and i.deleted_at is null
          where s.fact_id = any(${ids}::uuid[])
          order by i.occurred_at, s.id`;
  return {
    record: canonical,
    facts: rows.map((row) =>
      presentFact(
        row,
        sources
          .filter((s) => s.fact_id === row.id)
          .map((s) => ({ interaction: s.interaction_id, quote: s.quote })),
      ),
    ),
  };
}

/** Retracts a fact (soft delete, 2.1). Its sources and history are kept. */
export async function retractFact(
  tx: Tx,
  workspaceId: string,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const [row] = await tx<{ deleted_at: Date | null }[]>`
    select deleted_at from facts where id = ${id} and workspace_id = ${workspaceId} for update`;
  if (!row) throw notFound('fact', { id });
  if (row.deleted_at) {
    throw new AppError(409, 'fact_deleted', `fact ${id} is already retracted`, { id });
  }
  await tx`update facts set deleted_at = clock_timestamp() where id = ${id}`;
  return { id, deleted: true };
}
