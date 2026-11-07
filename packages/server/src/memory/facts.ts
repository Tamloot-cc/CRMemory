import type { Actor, FactSource, PresentedFact } from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError, invalid, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { textVector } from '../records/search-sql.js';
import {
  insertRecord,
  lockRecord,
  objectOf,
  resolveRecordId,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { CompiledSchema } from '../schema/compiled.js';
import { type CitedSource, liveFactSource, lockSource, NOTE_CHANNEL } from './events.js';

/**
 * Facts (1.3): plain-language claims about a record, each citing the event
 * it rests on (rule 2.1). Valid from the source's `occurred_at` (rule 2.6).
 * A fact is current while it is not retracted or superseded and at least
 * one of its sources is live (2.1).
 */

export const rememberInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(5_000),
  source: z.uuid().optional(),
  quote: z.string().trim().min(1).max(5_000).optional(),
});
export type RememberInput = z.infer<typeof rememberInputSchema>;

export type { PresentedFact } from '@retainer/shared';

/** What `remember` returns (6.2). */
export type RememberResult = { fact: PresentedFact };

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
 * Creates the internal note `remember` cites when it is given no source
 * (6.4): an event of the hidden internal-note type, with channel `retainer`,
 * the fact's text as its summary and the record as its one `about` link.
 * Nothing but this lifecycle reads, edits or deletes it.
 */
async function createInternalNote(
  tx: Tx,
  context: WriteContext,
  recordId: string,
  text: string,
): Promise<CitedSource> {
  const object = context.schema.internalNote;
  if (!object?.core) {
    throw new AppError(500, 'internal', 'this workspace has no internal-note type');
  }
  const note = await insertRecord(tx, context, object);
  const [created] = await tx<{ occurred_at: Date }[]>`
    insert into event_records (workspace_id, record_id, occurred_at, channel)
    values (${context.workspaceId}, ${note.id}, clock_timestamp(), ${NOTE_CHANNEL})
    returning occurred_at`;
  const occurredAt = (created as { occurred_at: Date }).occurred_at;
  await writeFields(tx, context, object, note, new Map([[object.core.summary, text]]), {
    sourceRecordId: note.id,
    observedAt: occurredAt,
    isInitial: true,
  });
  await tx`
    insert into event_links (workspace_id, event_id, position, record_id, link)
    values (${context.workspaceId}, ${note.id}, 0, ${recordId}, 'about')`;
  return { id: note.id, occurredAt };
}

/**
 * Writes one `stated` fact about a record (6.2). With `source`, the fact
 * cites that event and is valid from its `occurred_at`. Without one, an
 * internal note is created for it to cite, and it is valid from the write
 * time. Lock order matches deletion: the source, then the record.
 */
export async function rememberFact(
  tx: Tx,
  context: WriteContext,
  recordId: string,
  input: RememberInput,
): Promise<RememberResult> {
  if (input.quote !== undefined && input.source === undefined) {
    throw invalid('quote needs a source: pass the event the quote comes from');
  }
  let source: CitedSource | undefined;
  if (input.source) source = await lockSource(tx, context, input.source);
  const record = await lockRecord(tx, context.workspaceId, recordId);
  objectOf(context.schema, record);

  const internal = !source;
  if (!source) source = await createInternalNote(tx, context, record.id, input.text);

  const [inserted] = await tx<FactRow[]>`
    insert into facts (workspace_id, record_id, content, kind, valid_from, search, actor)
    values (${context.workspaceId}, ${record.id}, ${input.text}, 'stated', ${source.occurredAt},
      ${textVector(tx, input.text)}, ${tx.json(context.actor)})
    returning id, record_id, content, kind, valid_from, valid_to, actor`;
  const fact = inserted as FactRow;
  await tx`
    insert into fact_sources (workspace_id, fact_id, source_record_id, quote)
    values (${context.workspaceId}, ${fact.id}, ${source.id}, ${input.quote ?? null})`;

  return {
    fact: presentFact(fact, [
      internal
        ? { event: null, internal: true, quote: null }
        : { event: source.id, quote: input.quote ?? null },
    ]),
  };
}

export function presentFact(
  row: FactRow & { status?: PresentedFact['status'] },
  sources: FactSource[],
): PresentedFact {
  return {
    id: row.id,
    ...(row.status ? { status: row.status } : {}),
    record: row.record_id,
    content: row.content,
    kind: row.kind,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    writtenBy: row.actor,
    sources,
  };
}

/**
 * The live sources of facts, in order of occurrence, presented: an event's
 * ID and quote, or an internal note marked as such, never its ID (6.4).
 */
export async function factSources(
  tx: Tx,
  schema: CompiledSchema,
  factIds: readonly string[],
): Promise<Map<string, FactSource[]>> {
  const sources = new Map<string, FactSource[]>(factIds.map((id) => [id, []]));
  if (factIds.length === 0) return sources;
  const rows = await tx<
    { fact_id: string; source_record_id: string; object_type_id: string; quote: string | null }[]
  >`
    select s.fact_id, s.source_record_id, src.object_type_id, s.quote from fact_sources s
    join records src on src.id = s.source_record_id and src.deleted_at is null
    join event_records e on e.record_id = src.id
    where s.fact_id = any(${[...factIds]}::uuid[])
    order by e.occurred_at, s.id`;
  for (const row of rows) {
    const internal = schema.objectsById.get(row.object_type_id)?.hidden;
    sources
      .get(row.fact_id)
      ?.push(
        internal
          ? { event: null, internal: true, quote: null }
          : { event: row.source_record_id, quote: row.quote },
      );
  }
  return sources;
}

export type FactList = { record: string; facts: PresentedFact[] };

/**
 * A live record's current facts, newest `validFrom` first: not retracted,
 * not superseded, and resting on at least one live event (2.1, 5). Only
 * live sources are listed.
 */
export async function listFacts(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<FactList> {
  const canonical = await resolveRecordId(tx, workspaceId, recordId);
  const [record] = await tx<{ deleted_at: Date | null; object_type_id: string }[]>`
    select deleted_at, object_type_id from records
    where id = ${canonical} and workspace_id = ${workspaceId}`;
  if (!record || schema.objectsById.get(record.object_type_id)?.hidden) {
    throw notFound('record', { id: recordId });
  }
  if (record.deleted_at) {
    throw new AppError(404, 'record_deleted', `record ${canonical} was deleted`, {
      recordId: canonical,
    });
  }
  const rows = await tx<FactRow[]>`
    select f.id, f.record_id, f.content, f.kind, f.valid_from, f.valid_to, f.actor from facts f
    where f.workspace_id = ${workspaceId} and f.record_id = ${canonical}
      and f.deleted_at is null and f.superseded_by is null and f.valid_to is null
      and exists (${liveFactSource(tx, tx`f.id`)})
    order by f.valid_from desc, f.created_at desc, f.id
    limit ${limit}`;
  const sources = await factSources(
    tx,
    schema,
    rows.map((r) => r.id),
  );
  return {
    record: canonical,
    facts: rows.map((row) => presentFact(row, sources.get(row.id) ?? [])),
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
