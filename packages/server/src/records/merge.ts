import type { MergeResult, MergeSuggestionDecision } from '@retainer/shared';
import { FieldValueError, MULTI_VALUE_TYPES } from '@retainer/shared';
import { z } from 'zod';
import { RecordId } from '../db/cbor.js';
import { fieldColumn, isUuid, publicId } from '../db/names.js';
import { AppError, notFound, requireUser } from '../errors.js';
import { addDirectAttachments, removeDirectAttachments } from '../memory/attachments.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import { type FieldState, relationTargetIds } from '../schema-engine/types.js';
import { deleteSearchDocuments } from './search-docs.js';
import { normalizeFieldValue, prepareValues } from './values.js';
import { sameValue } from './winner.js';
import {
  type AssertionRow,
  closeSuggestionsFor,
  entriesOf,
  fromStored,
  lockRecordsForUpdate,
  objectOf,
  planState,
  recomputeFields,
  releaseIdentifiers,
  resolveRecordId,
  type StoredAssertion,
  syncEdges,
  updateAssertion,
  type WriteContext,
  writeFields,
} from './write.js';

/**
 * Merging duplicate records (4.2). Only a `user` actor merges: an agent's
 * key scope is not human approval (3). The consolidator only suggests.
 */

export const mergeInputSchema = z.strictObject({
  /** The record to merge into the one in the path; it is soft-deleted. */
  recordId: z.uuid(),
  /**
   * Values the survivor should end with, by field name, written as the
   * merging user. They replace the defaults below for those fields.
   */
  values: z.record(z.string(), z.unknown()).optional(),
});
export type MergeInput = z.infer<typeof mergeInputSchema>;

/** A record changed between resolving and locking it; the caller retries the transaction. */
export class MergeRaceError extends Error {
  constructor() {
    super('a record was merged or deleted while this merge was starting');
  }
}

type MultiValue = { primary: unknown; additional?: unknown[] };

/**
 * The default for an `emails`, `phones` or `links` field (4.2): both
 * current winners combined and deduplicated, A's primary kept if present
 * (otherwise B's), the rest in `additional`. With only one value, that one.
 * Too many values for the field's `maxValues` fails, so nothing is
 * silently dropped.
 */
export function combineMultiValues(field: FieldState, survivor: unknown, merged: unknown): unknown {
  const a = survivor as MultiValue | null | undefined;
  const b = merged as MultiValue | null | undefined;
  if (!b) return a ?? null;
  if (!a) return b;
  const all = [a.primary, ...(a.additional ?? []), b.primary, ...(b.additional ?? [])].filter(
    (v) => v !== null && v !== undefined,
  );
  const primary = a.primary ?? b.primary ?? null;
  // Duplicates of the primary and of each other are dropped by normalizing.
  const additional = all.filter((v) => v !== primary);
  try {
    return normalizeFieldValue(field, { primary, additional });
  } catch (error) {
    if (!(error instanceof FieldValueError)) throw error;
    throw new AppError(
      422,
      'too_many_values',
      `the combined ${field.name} of both records do not fit the field: ${error.message}. ` +
        `Pass values.${field.name} with the ones to keep`,
      { field: field.name, maxValues: field.settings.maxValues ?? null },
    );
  }
}

/** Relation fields, on any object, whose target is this object. */
export function inboundRelationFields(schema: CompiledSchema, object: CompiledObject): string[] {
  return schema.state.objects.flatMap((o) =>
    o.fields
      .filter(
        (f) =>
          f.type === 'relation' &&
          !f.settings.isInverse &&
          relationTargetIds(f.settings).includes(object.state.universalId),
      )
      .map((f) => f.id as string),
  );
}

/** Assertions whose relation value points at a record, as this plan sees them. */
async function assertionsPointingAt(
  context: WriteContext,
  recordId: string,
): Promise<AssertionRow[]> {
  const stored = await context.op.rows<StoredAssertion>(
    'SELECT * FROM field_assertions WHERE refs CONTAINS $record;',
    { record: recordId },
  );
  const rows = new Map(stored.map((row) => [publicId(row.id), fromStored(row)]));
  const pointsAt = (value: unknown) =>
    value === recordId || (Array.isArray(value) && value.includes(recordId));
  for (const [id, row] of planState(context.op).assertions) {
    if (pointsAt(row.value)) rows.set(id, row);
    else rows.delete(id);
  }
  return [...rows.values()];
}

/** The merged result the plan returns; the survivor is presented after commit. */
export type MergeOutcome = Omit<MergeResult, 'record'>;

type LinkRow = {
  id: RecordId;
  event: string;
  position: number;
  record?: string | null;
  link: 'participant' | 'about';
};

/**
 * Merges record `input.recordId` (B) into `survivorId` (A), in one
 * operation (4.2). The write protocol serializes it with every other write
 * in the workspace, so no relation write or logging interleaves:
 *
 * 1. Resolve both to canonical IDs. B already merged into A is a no-op.
 * 2. Point inbound relation assertions at A, keeping provenance, and
 *    recompute those fields, which moves their edges and attachments.
 * 3. Move B's assertions, facts and event links to A; release B's
 *    identifiers and edges, then recompute the moved fields of A with the
 *    normal rules, which rebuilds identifiers and revalidates unique claims.
 * 4. For `emails`, `phones` and `links`, write the combined current winners
 *    as the merging user; `values` overrides any field.
 * 5. Soft-delete B with `merged_into = A`, point records merged into B at
 *    A so chains stay one hop, accept the pair's suggestion and close B's
 *    others.
 */
export async function mergeRecords(
  context: WriteContext,
  survivorId: string,
  input: MergeInput,
): Promise<MergeOutcome> {
  requireUser(context.actor, 'merge records');
  const { op } = context;
  if (survivorId === input.recordId) {
    throw new AppError(422, 'invalid_merge', 'a record cannot be merged into itself');
  }
  const a = await resolveRecordId(op, survivorId);
  const b = await resolveRecordId(op, input.recordId);
  if (a === b) {
    if (a !== survivorId) {
      throw new AppError(
        409,
        'record_merged',
        `record ${survivorId} was merged into ${a}; merge into ${a} instead`,
        { recordId: a },
      );
    }
    return { id: a, mergedId: input.recordId, merged: false, recomputedRecordIds: [] };
  }

  const pair = [a, b].sort() as [string, string];
  const locked = await lockRecordsForUpdate(context, pair);
  const survivor = locked.find((r) => r.id === a);
  const merged = locked.find((r) => r.id === b);
  if (!survivor || !merged || survivor.merged_into_id || merged.merged_into_id) {
    throw new MergeRaceError();
  }
  for (const record of [survivor, merged]) {
    if (record.deleted_at) {
      throw new AppError(409, 'record_deleted', `record ${record.id} is deleted`, {
        recordId: record.id,
      });
    }
  }
  const object = objectOf(context.schema, survivor);
  if (object.isEvent) {
    throw new AppError(
      422,
      'invalid_merge',
      'events cannot be merged: each is something that happened, logged from its own source. ' +
        'Delete a duplicate event instead',
    );
  }
  if (merged.object_type_id !== survivor.object_type_id) {
    throw new AppError(
      422,
      'wrong_object',
      `record ${b} is a ${objectOf(context.schema, merged).name}, not a ${object.name}; ` +
        'only records of the same object can be merged',
    );
  }
  const overrides = prepareValues(object, input.values ?? {}, 'update');
  const before = { ...survivor.data };

  // Move B's own claims to A first, so recomputing inbound records below
  // never sees B's edges or identifiers as current.
  const ownFields = object.state.fields;
  await releaseIdentifiers(context, b, ownFields);
  for (const field of ownFields) {
    if (field.type === 'relation' && !field.settings.isInverse) {
      await syncEdges(context, object, field, b, [], { assertion: null, actor: context.actor });
    }
  }
  const own = await (async () => {
    const stored = await op.rows<StoredAssertion>(
      'SELECT * FROM field_assertions WHERE record = $record;',
      { record: b },
    );
    const rows = new Map(stored.map((row) => [publicId(row.id), fromStored(row)]));
    for (const [id, row] of planState(op).assertions) if (row.record === b) rows.set(id, row);
    return [...rows.values()].filter((row) => row.record === b);
  })();
  for (const row of own) updateAssertion(context, row, { record: a });
  const movedFieldIds = [...new Set(own.map((row) => row.field_id))];

  // Inbound relations: B becomes A in every value that points at it. In a
  // set, B becomes A once: membership is deduplicated and kept in ID order.
  const inboundFields = new Set(inboundRelationFields(context.schema, object));
  const inbound = (await assertionsPointingAt(context, b)).filter(
    (row) => inboundFields.has(row.field_id) && !pair.includes(row.record),
  );
  const inboundByRecord = new Map<string, Set<string>>();
  for (const row of inbound) {
    const value = Array.isArray(row.value)
      ? [...new Set((row.value as string[]).map((v) => (v === b ? a : v)))].sort()
      : a;
    updateAssertion(context, row, { value });
    const fields = inboundByRecord.get(row.record) ?? new Set();
    fields.add(row.field_id);
    inboundByRecord.set(row.record, fields);
  }
  const inboundIds = [...inboundByRecord.keys()].sort();
  for (const record of await lockRecordsForUpdate(context, inboundIds)) {
    const owner = context.schema.objectsById.get(record.object_type_id);
    if (owner) {
      await recomputeFields(context, owner, record, [
        ...(inboundByRecord.get(record.id) ?? []),
      ]);
    }
  }

  // Facts move with their search documents.
  const facts = await op.rows<{ id: RecordId }>('SELECT id FROM facts WHERE record = $record;', {
    record: b,
  });
  for (const fact of facts) {
    op.batch.update('facts', publicId(fact.id), { record: a });
    op.batch.write(
      `UPDATE ${op.batch.v(new RecordId('search_documents', publicId(fact.id)))} SET owner = ${op.batch.v(a)} RETURN id`,
      { min: 0, max: 1 },
      'search_documents',
    );
  }

  // Event links and their attachments move to A. An event is about a
  // record once: an about link that now repeats another link to the
  // survivor is dropped (1.3).
  const linksOfB = await op.rows<LinkRow>('SELECT * FROM event_links WHERE record = $record;', {
    record: b,
  });
  const linksOfA = await op.rows<LinkRow>('SELECT * FROM event_links WHERE record = $record;', {
    record: a,
  });
  const byEvent = new Map<string, LinkRow[]>();
  for (const link of [...linksOfA, ...linksOfB]) {
    byEvent.set(link.event, [...(byEvent.get(link.event) ?? []), link]);
  }
  const dropped = new Set<string>();
  for (const links of byEvent.values()) {
    const sorted = [...links].sort(
      (x, y) =>
        (x.link === 'participant' ? 0 : 1) - (y.link === 'participant' ? 0 : 1) ||
        x.position - y.position,
    );
    const keep = sorted[0];
    for (const link of sorted.slice(1)) {
      if (link.link === 'about' && link !== keep) dropped.add(publicId(link.id));
    }
  }
  for (const link of linksOfB) {
    const linkId = publicId(link.id);
    await removeDirectAttachments(context, [
      { event: link.event, target: b, via: link.link, linkId },
    ]);
    if (dropped.has(linkId)) {
      op.batch.deleteIds('event_links', [linkId]);
      continue;
    }
    op.batch.update('event_links', linkId, { record: a });
    await addDirectAttachments(context, [{ event: link.event, target: a, via: link.link, linkId }]);
  }
  for (const link of linksOfA) {
    const linkId = publicId(link.id);
    if (!dropped.has(linkId)) continue;
    op.batch.deleteIds('event_links', [linkId]);
    await removeDirectAttachments(context, [
      { event: link.event, target: a, via: link.link, linkId },
    ]);
  }

  // The survivor changed even when no field did (it gained B's facts), so
  // the consolidator's next run compares it again.
  op.batch.update(object.table, a, { updated_at: op.now, updated_by: context.actor });
  await recomputeFields(context, object, survivor, movedFieldIds);

  const combined = new Map<FieldState, unknown>();
  for (const field of object.activeFields) {
    if (!MULTI_VALUE_TYPES.has(field.type) || overrides.has(field)) continue;
    const value = combineMultiValues(field, before[field.key], merged.data[field.key]);
    if (!sameValue(value, survivor.data[field.key] ?? null)) combined.set(field, value);
  }
  // B's handles were released above, but both records held them while
  // live: they are not coming back, so they skip the suppression check.
  if (combined.size > 0) {
    await writeFields(context, object, survivor, combined, { skipSuppressionCheck: true });
  }
  if (overrides.size > 0) await writeFields(context, object, survivor, overrides);

  // B is gone: no values, label or search document, and it resolves to A.
  const cleared: Record<string, unknown> = {
    merged_into: a,
    deleted_at: op.now,
    updated_at: op.now,
    updated_by: context.actor,
    label: undefined,
  };
  for (const field of object.state.fields) {
    if (field.type !== 'relation') cleared[fieldColumn(field.key)] = undefined;
  }
  op.batch.update(object.table, b, cleared);
  op.batch.update('record_directory', b, { merged_into: a, deleted_at: op.now, updated_at: op.now });
  const entryOfB = (await entriesOf(op, [b])).get(b);
  if (entryOfB) {
    planState(op).directory.set(b, { ...entryOfB, merged_into: a, deleted_at: op.now });
  }
  merged.merged_into_id = a;
  merged.deleted_at = op.now;
  deleteSearchDocuments(context, [b]);

  const chained = await op.rows<{ id: RecordId; tb: string }>(
    'SELECT id, tb FROM record_directory WHERE merged_into = $record;',
    { record: b },
  );
  for (const row of chained) {
    const id = publicId(row.id);
    op.batch.update('record_directory', id, { merged_into: a });
    op.batch.update(row.tb, id, { merged_into: a });
    const entry = (await entriesOf(op, [id])).get(id);
    if (entry) planState(op).directory.set(id, { ...entry, merged_into: a });
  }

  const [suggestion] = await op.rows<{ id: RecordId }>(
    "SELECT id FROM merge_suggestions WHERE record_a = $a AND record_b = $b AND status = 'pending';",
    { a: pair[0], b: pair[1] },
  );
  if (suggestion) {
    op.batch.update('merge_suggestions', publicId(suggestion.id), {
      status: 'accepted',
      decided_by: context.actor,
      decided_at: op.now,
    });
  }
  await closeSuggestionsFor(context, [b]);

  return { id: a, mergedId: b, merged: true, recomputedRecordIds: inboundIds };
}

/** Dismisses a suggested merge; the consolidator never suggests the pair again. */
export async function dismissMergeSuggestion(
  context: WriteContext,
  id: string,
): Promise<MergeSuggestionDecision> {
  requireUser(context.actor, 'decide merge suggestions');
  const [row] = isUuid(id)
    ? await context.op.rows<{ status: string }>('SELECT status FROM $id;', {
        id: new RecordId('merge_suggestions', id),
      })
    : [];
  if (!row) throw notFound('merge suggestion', { id });
  if (row.status !== 'pending') {
    throw new AppError(409, 'not_pending', `merge suggestion is ${row.status}, not pending`);
  }
  context.op.batch.update('merge_suggestions', id, {
    status: 'dismissed',
    decided_by: context.actor,
    decided_at: context.op.now,
  });
  return { id, status: 'dismissed' };
}
