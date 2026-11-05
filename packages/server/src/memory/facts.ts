import type { Actor, FactSource, PresentedFact } from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { isUuid, publicId } from '../db/names.js';
import type { Operation } from '../db/protocol.js';
import { AppError, invalid, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { deleteSearchDocuments, factDocument } from '../records/search-docs.js';
import { directoryEntries } from '../records/store.js';
import {
  insertRecord,
  lockRecord,
  objectOf,
  resolveRecordIdIn,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';
import { addDirectAttachments } from './attachments.js';
import { type CitedSource, liveFactSources, lockSource, NOTE_CHANNEL } from './events.js';

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

export type FactRow = {
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
  context: WriteContext,
  recordId: string,
  text: string,
): Promise<CitedSource> {
  const object = context.schema.internalNote;
  if (!object?.core) {
    throw new AppError(500, 'internal', 'this workspace has no internal-note type');
  }
  const { op } = context;
  const occurredAt = op.now;
  const note = await insertRecord(context, object, { occurredAt });
  op.batch.create('event_identity', note.id, {
    object_type_id: object.id,
    occurred_at: occurredAt,
    channel: NOTE_CHANNEL,
    created_at: op.now,
  });
  await writeFields(context, object, note, new Map([[object.core.summary, text]]), {
    sourceRecordId: note.id,
    observedAt: occurredAt,
    isInitial: true,
  });
  const linkId = op.newId();
  op.batch.create('event_links', linkId, {
    event: note.id,
    position: 0,
    record: recordId,
    link: 'about',
  });
  await addDirectAttachments(context, [
    { event: note.id, target: recordId, via: 'about', linkId },
  ]);
  return { id: note.id, occurredAt };
}

/**
 * Writes one `stated` fact about a record (6.2). With `source`, the fact
 * cites that event and is valid from its `occurred_at`. Without one, an
 * internal note is created for it to cite, and it is valid from the write
 * time.
 */
export async function rememberFact(
  context: WriteContext,
  recordId: string,
  input: RememberInput,
): Promise<RememberResult> {
  if (input.quote !== undefined && input.source === undefined) {
    throw invalid('quote needs a source: pass the event the quote comes from');
  }
  let source: CitedSource | undefined;
  if (input.source) source = await lockSource(context, input.source);
  const record = await lockRecord(context, recordId);
  const object = objectOf(context.schema, record);

  const internal = !source;
  if (!source) source = await createInternalNote(context, record.id, input.text);

  const { op } = context;
  const fact: FactRow = {
    id: op.newId(),
    record_id: record.id,
    content: input.text,
    kind: 'stated',
    valid_from: source.occurredAt,
    valid_to: null,
    actor: context.actor,
  };
  op.batch.create('facts', fact.id, {
    record: fact.record_id,
    content: fact.content,
    kind: fact.kind,
    confidence: 1,
    valid_from: fact.valid_from,
    actor: fact.actor,
    created_at: op.now,
  });
  op.batch.create('fact_sources', op.newId(), {
    fact: fact.id,
    source: source.id,
    quote: input.quote ?? null,
  });
  op.batch.upsert(
    'search_documents',
    fact.id,
    factDocument({ id: fact.id, record: record.id, content: fact.content }, object.id, op.now),
  );

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
  db: Db,
  schema: CompiledSchema,
  factIds: readonly string[],
): Promise<Map<string, FactSource[]>> {
  const live = await liveFactSources(db, factIds);
  const sources = new Map<string, FactSource[]>();
  for (const id of factIds) {
    sources.set(
      id,
      (live.get(id) ?? []).map((row) =>
        schema.objectsById.get(row.objectTypeId)?.hidden
          ? { event: null, internal: true, quote: null }
          : { event: row.source, quote: row.quote },
      ),
    );
  }
  return sources;
}

export type FactList = { record: string; facts: PresentedFact[] };

type StoredFact = {
  id: RecordId;
  record: string;
  content: string;
  kind: 'stated' | 'inferred';
  valid_from: Date;
  valid_to?: Date | null;
  superseded_by?: string | null;
  actor: Actor;
  created_at: Date;
  deleted_at?: Date | null;
};

export const factFromStored = (row: StoredFact): FactRow => ({
  id: publicId(row.id),
  record_id: row.record,
  content: row.content,
  kind: row.kind,
  valid_from: row.valid_from,
  valid_to: row.valid_to ?? null,
  actor: row.actor,
});

/**
 * A live record's current facts, newest `validFrom` first: not retracted,
 * not superseded, and resting on at least one live event (2.1, 5). Only
 * live sources are listed.
 */
export async function listFacts(
  db: Db,
  _workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<FactList> {
  const canonical = await resolveRecordIdIn(db, recordId);
  const entry = (await directoryEntries(db, [canonical])).get(canonical);
  if (!entry || schema.objectsById.get(entry.object_type_id)?.hidden) {
    throw notFound('record', { id: recordId });
  }
  if (entry.deleted_at) {
    throw new AppError(404, 'record_deleted', `record ${canonical} was deleted`, {
      recordId: canonical,
    });
  }
  const stored = await db.rows<StoredFact>(
    'SELECT * FROM facts WHERE record = $record ORDER BY valid_from DESC, created_at DESC, id;',
    { record: canonical },
  );
  const current = stored.filter((f) => !f.deleted_at && !f.superseded_by && !f.valid_to);
  const sources = await factSources(
    db,
    schema,
    current.map((f) => publicId(f.id)),
  );
  const facts = current
    .map(factFromStored)
    .filter((f) => (sources.get(f.id)?.length ?? 0) > 0)
    .slice(0, limit);
  return {
    record: canonical,
    facts: facts.map((row) => presentFact(row, sources.get(row.id) ?? [])),
  };
}

/** Retracts a fact (soft delete, 2.1). Its sources and history are kept. */
export async function retractFact(op: Operation, id: string): Promise<{ id: string; deleted: true }> {
  const [row] = isUuid(id)
    ? await op.rows<{ deleted_at?: Date | null }>('SELECT deleted_at FROM $id;', {
        id: new RecordId('facts', id),
      })
    : [];
  if (!row) throw notFound('fact', { id });
  if (row.deleted_at) {
    throw new AppError(409, 'fact_deleted', `fact ${id} is already retracted`, { id });
  }
  op.batch.update('facts', id, { deleted_at: op.now });
  deleteSearchDocuments({ op }, [id]);
  return { id, deleted: true };
}
