import type { Actor, ActorType } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { fieldColumn, publicId, relationTable } from '../db/names.js';
import { toColumn } from '../db/physical.js';
import type { Operation } from '../db/protocol.js';
import { ident } from '../db/surreal.js';
import type { AssertionStatus, ReviewReason } from '../db/types.js';
import { AppError, notFound } from '../errors.js';
import { edgesChanged } from '../memory/attachments.js';
import { isSuppressed, suppressedOf, suppressibleHandles } from '../privacy/suppression.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import { type FieldState, relationTargetIds } from '../schema-engine/types.js';
import { type Identifier, identifiersFor } from './derive.js';
import { deleteSearchDocuments, writeRecordSearch } from './search-docs.js';
import {
  type DirEntry,
  directoryEntries,
  edgeTargets,
  fetchRows,
  type RecordRow,
} from './store.js';
import { compareAssertions, pickWinner, type RankedAssertion, reviewReason } from './winner.js';

/**
 * The record write path (rules 2.2–2.5) on the write protocol (spec
 * section 6). A plan reads what it needs, decides every effect in
 * TypeScript and adds it to the operation's batch; nothing is written until
 * the commit. Later steps of one operation read through the plan state
 * below, so a merge or a retraction that touches a record twice sees its
 * own earlier decisions.
 */

/** Everything a write needs: who, where, the schema it validated against and the plan. */
export type WriteContext = {
  op: Operation;
  workspaceId: string;
  actor: Actor;
  schema: CompiledSchema;
  /** Agent assertions below this confidence wait for review (rule 2.3). */
  confidenceThreshold: number;
};

export type WriteOptions = {
  /** The event record the values come from; kept as provenance. */
  sourceRecordId?: string | null;
  /**
   * When the claim was true at the source: the cited event's `occurred_at`.
   * Without it, the server's clock at write time (rule 2.2).
   */
  observedAt?: Date | null;
  /** `log_event` writing an event's own initial values (6.2). */
  isInitial?: boolean;
  /** 0..1; direct writes are 1. */
  confidence?: number;
  /** Rejects the write if the record changed since (rule 2.5). */
  expectedUpdatedAt?: string;
  /**
   * Skips the suppression check (2.1). Only for values live records already
   * hold, such as the combined emails a merge writes.
   */
  skipSuppressionCheck?: boolean;
};

/** What happened to each written field (6.2). */
export type FieldWriteStatus = 'applied' | 'pending_review' | 'superseded';

export type LockedRecord = {
  id: string;
  object_type_id: string;
  data: Record<string, unknown>;
  label: string | null;
  updated_at: Date;
  deleted_at: Date | null;
  merged_into_id: string | null;
  created_at: Date;
  created_by: Actor;
  occurred_at: Date | null;
};

/** Another record already holds a unique value (1.2). */
export class UniqueConflictError extends AppError {
  constructor(
    readonly field: FieldState,
    readonly value: string,
    readonly recordId: string,
  ) {
    super(
      409,
      'unique_conflict',
      `${field.name} value ${value} already belongs to record ${recordId}`,
      {
        field: field.name,
        value,
        recordId,
        candidates: [recordId],
        errors: [{ field: field.name, message: 'already belongs to another record' }],
      },
    );
  }
}

export type AssertionRow = {
  id: string;
  record: string;
  field_id: string;
  value: unknown;
  actor: Actor;
  source: string | null;
  is_initial: boolean;
  confidence: number;
  status: AssertionStatus;
  review_reason: ReviewReason | null;
  observed_at: Date;
  reviewed_by: Actor | null;
  reviewed_at: Date | null;
  created_at: Date;
};

export const toRanked = (row: AssertionRow): RankedAssertion => ({
  id: row.id,
  actorType: row.actor.type,
  observedAt: row.observed_at,
  createdAt: row.created_at,
  status: row.status,
  value: row.value,
});

/** Fields whose values become identifier lookups (1.2). */
const hasIdentifiers = (field: FieldState) =>
  field.isUnique || field.type === 'emails' || field.type === 'phones' || field.type === 'links';

/**
 * Merges flatten chains (4.2), so a merged ID is one hop from its survivor;
 * the limit only stops a corrupt cycle.
 */
export const MAX_MERGE_HOPS = 16;

// ---------------------------------------------------------------------------
// Plan state
// ---------------------------------------------------------------------------

type IdentifierRow = { id: string; kind: string; value: string };
type ClaimRow = { id: string; value: string };

type PlanState = {
  directory: Map<string, DirEntry | null>;
  records: Map<string, LockedRecord>;
  /** Assertions this plan created or changed. */
  assertions: Map<string, AssertionRow>;
  /** `record\nfield` → identifier lookups after this plan. */
  identifiers: Map<string, IdentifierRow[]>;
  /** `record\nfield` → unique claims after this plan. */
  claims: Map<string, ClaimRow[]>;
  /** `field\nvalue` → the record holding the claim after this plan, or null if released. */
  holders: Map<string, string | null>;
  /** `field\nsource` → edge targets after this plan. */
  edges: Map<string, string[]>;
};

export function planState(op: Operation): PlanState {
  let state = op.cache.get('records') as PlanState | undefined;
  if (!state) {
    state = {
      directory: new Map(),
      records: new Map(),
      assertions: new Map(),
      identifiers: new Map(),
      claims: new Map(),
      holders: new Map(),
      edges: new Map(),
    };
    op.cache.set('records', state);
  }
  return state;
}

const pair = (a: string, b: string) => `${a}\n${b}`;

/** Directory entries as this plan sees them. */
export async function entriesOf(
  op: Operation,
  ids: readonly string[],
): Promise<Map<string, DirEntry>> {
  const state = planState(op);
  const missing = [...new Set(ids)].filter((id) => !state.directory.has(id));
  if (missing.length > 0) {
    const found = await directoryEntries(op.db, missing);
    for (const id of missing) state.directory.set(id, found.get(id) ?? null);
  }
  const result = new Map<string, DirEntry>();
  for (const id of ids) {
    const entry = state.directory.get(id);
    if (entry) result.set(id, entry);
  }
  return result;
}

function setEntry(op: Operation, entry: DirEntry): void {
  planState(op).directory.set(entry.id, entry);
}

/** Follows `merged_into` to the surviving record (4.2), as this plan sees it. */
export async function resolveRecordId(op: Operation, id: string): Promise<string> {
  let current = id;
  for (let hops = 0; hops < MAX_MERGE_HOPS; hops++) {
    const entry = (await entriesOf(op, [current])).get(current);
    if (!entry) throw notFound('record', { id });
    if (!entry.merged_into) return current;
    current = entry.merged_into;
  }
  throw new AppError(409, 'merge_cycle', `record ${id} has a merge chain that does not end`);
}

/** Follows merges outside a plan (reads). */
export async function resolveRecordIdIn(db: Db, id: string): Promise<string> {
  let current = id;
  for (let hops = 0; hops < MAX_MERGE_HOPS; hops++) {
    const entry = (await directoryEntries(db, [current])).get(current);
    if (!entry) throw notFound('record', { id });
    if (!entry.merged_into) return current;
    current = entry.merged_into;
  }
  throw new AppError(409, 'merge_cycle', `record ${id} has a merge chain that does not end`);
}

const lockedFromRow = (row: RecordRow): LockedRecord => ({
  id: row.id,
  object_type_id: row.object_type_id,
  data: row.data,
  label: row.label,
  updated_at: row.updated_at,
  deleted_at: row.deleted_at,
  merged_into_id: row.merged_into_id,
  created_at: row.created_at,
  created_by: row.created_by,
  occurred_at: row.occurred_at,
});

/** Records as this plan sees them, by public ID (unknown IDs absent). */
export async function loadRecords(
  context: WriteContext,
  ids: readonly string[],
): Promise<Map<string, LockedRecord>> {
  const state = planState(context.op);
  const missing = [...new Set(ids)].filter((id) => !state.records.has(id));
  if (missing.length > 0) {
    const entries = await entriesOf(context.op, missing);
    const rows = await fetchRows(
      context.op.db,
      context.workspaceId,
      context.schema,
      entries.values(),
    );
    for (const [id, row] of rows) state.records.set(id, lockedFromRow(row));
  }
  const result = new Map<string, LockedRecord>();
  for (const id of ids) {
    const record = state.records.get(id);
    if (record) result.set(id, record);
  }
  return result;
}

/**
 * A live record to write (rule 2.5). A merged ID resolves to the surviving
 * record; a deleted record cannot be written. Concurrent writers are
 * serialized by the workspace queue and the revision check (section 6).
 */
export async function lockRecord(context: WriteContext, id: string): Promise<LockedRecord> {
  const canonical = await resolveRecordId(context.op, id);
  const record = (await loadRecords(context, [canonical])).get(canonical);
  if (!record) throw notFound('record', { id });
  if (record.deleted_at) {
    throw new AppError(409, 'record_deleted', `record ${canonical} is deleted`, {
      recordId: canonical,
    });
  }
  return record;
}

/**
 * The object of a record a caller writes. The hidden internal-note type
 * (6.4) resolves as not found: its records change only through `remember`
 * and the fact and privacy lifecycle.
 */
export function objectOf(
  schema: CompiledSchema,
  record: { id?: string; object_type_id: string },
): CompiledObject {
  const object = schema.objectsById.get(record.object_type_id);
  if (object?.hidden) throw notFound('record', record.id ? { id: record.id } : undefined);
  if (object?.state.status !== 'active') {
    throw new AppError(409, 'object_deleted', 'the object of this record was deleted');
  }
  return object;
}

type TargetRow = {
  id: string;
  object_type_id: string;
  deleted_at: Date | null;
};

/** Relation targets after following merges (4.2); a missing one is undefined. */
export async function lockTargets(
  context: WriteContext,
  ids: readonly string[],
): Promise<Map<string, TargetRow | undefined>> {
  const targets = new Map<string, TargetRow | undefined>();
  for (const id of ids) {
    let resolved: string | undefined;
    try {
      resolved = await resolveRecordId(context.op, id);
    } catch {
      resolved = undefined;
    }
    const entry = resolved ? (await entriesOf(context.op, [resolved])).get(resolved) : undefined;
    targets.set(
      id,
      entry
        ? { id: entry.id, object_type_id: entry.object_type_id, deleted_at: entry.deleted_at }
        : undefined,
    );
  }
  return targets;
}

/**
 * Relation values must point at a live record of the target object, in this
 * workspace. A merged ID is replaced by its surviving record, as for any ID
 * a caller passes.
 */
async function checkRelationTargets(
  context: WriteContext,
  object: CompiledObject,
  writes: Map<FieldState, unknown>,
): Promise<void> {
  const relations = [...writes].filter(
    (entry): entry is [FieldState, string | string[]] =>
      entry[0].type === 'relation' && entry[1] !== null,
  );
  if (relations.length === 0) return;
  const byId = await lockTargets(context, [
    ...new Set(relations.flatMap(([, value]) => (Array.isArray(value) ? value : [value]))),
  ]);
  const errors = [];
  for (const [field, value] of relations) {
    const allowed = relationTargetIds(field.settings).flatMap((id) => {
      const target = context.schema.objectsByUniversalId.get(id);
      return target ? [target] : [];
    });
    const resolved: string[] = [];
    for (const targetId of Array.isArray(value) ? value : [value]) {
      const target = byId.get(targetId);
      if (!target || target.deleted_at) {
        errors.push({ field: field.name, message: `no live record ${targetId}` });
      } else if (!allowed.some((o) => o.id === target.object_type_id)) {
        errors.push({
          field: field.name,
          message: `record ${targetId} is not a ${allowed.map((o) => o.name).join(' or ') || 'valid target'}`,
        });
      } else resolved.push(target.id);
    }
    // A merged ID is replaced by its survivor; a set is normalized again,
    // since two IDs may now name one record.
    writes.set(
      field,
      Array.isArray(value) ? [...new Set(resolved)].sort() : (resolved[0] ?? value),
    );
  }
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_values', `invalid values for ${object.name}`, { errors });
  }
}

/**
 * Emails and phones erased by `forget` cannot be written again (2.1). A
 * handle the record already holds is not new: another live record can
 * share a phone with the forgotten person and keeps it. `forget` and every
 * write are serialized by the write protocol. The error names the field,
 * never the value.
 */
async function checkSuppressed(
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  writes: Map<FieldState, unknown>,
): Promise<void> {
  const handles = [...writes].flatMap(([field, value]) =>
    suppressibleHandles(field, value).map((handle) => ({ field, handle })),
  );
  const suppressed = await suppressedOf(
    context.op.db,
    context.workspaceId,
    handles.map((h) => h.handle),
  );
  const hits = handles.filter((h) => isSuppressed(suppressed, h.handle));
  if (hits.length === 0) return;
  const held = new Set<string>();
  for (const field of object.state.fields) {
    if (field.type !== 'emails' && field.type !== 'phones') continue;
    for (const row of await identifierRows(context, record.id, field)) {
      if (row.kind === 'email' || row.kind === 'phone') held.add(row.value);
    }
  }
  const hit = hits.find((h) => !held.has(h.handle.value));
  if (hit) {
    throw new AppError(
      409,
      'suppressed',
      `a value of ${hit.field.name} was erased by a privacy request and cannot be stored again`,
      {
        field: hit.field.name,
        errors: [
          {
            field: hit.field.name,
            message: 'was erased by a privacy request and cannot be stored again',
          },
        ],
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export type StoredAssertion = Omit<AssertionRow, 'id'> & { id: RecordId; refs?: string[] };

export const fromStored = ({ refs: _refs, ...row }: StoredAssertion): AssertionRow => ({
  ...row,
  id: publicId(row.id),
  source: row.source ?? null,
  review_reason: row.review_reason ?? null,
  reviewed_by: row.reviewed_by ?? null,
  reviewed_at: row.reviewed_at ?? null,
});

/**
 * A record's assertions for some fields with the given statuses, as this
 * plan sees them: stored rows overlaid with the plan's own changes.
 */
export async function assertionsOf(
  context: WriteContext,
  recordId: string,
  fieldIds: readonly string[] | null,
  statuses: readonly AssertionStatus[],
): Promise<AssertionRow[]> {
  const stored = await context.op.rows<StoredAssertion>(
    fieldIds
      ? 'SELECT * FROM field_assertions WHERE record = $record AND field_id IN $fields;'
      : 'SELECT * FROM field_assertions WHERE record = $record;',
    { record: recordId, fields: fieldIds ?? [] },
  );
  const overlay = planState(context.op).assertions;
  const rows = new Map(stored.map((row) => [publicId(row.id), fromStored(row)]));
  for (const [id, row] of overlay) {
    if (row.record === recordId && (!fieldIds || fieldIds.includes(row.field_id))) {
      rows.set(id, row);
    }
  }
  return [...rows.values()].filter((row) => statuses.includes(row.status));
}

/** Adds a new assertion to the plan. */
/** The record IDs a relation assertion's value points at (the `refs` index). */
export function refsOf(schema: CompiledSchema, fieldId: string, value: unknown): string[] {
  const field = schema.fieldOwners.get(fieldId)?.fieldsById.get(fieldId);
  if (field?.type !== 'relation') return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return [...new Set(value.filter((v) => typeof v === 'string'))];
  return [];
}

export function insertAssertion(context: WriteContext, row: AssertionRow): void {
  planState(context.op).assertions.set(row.id, row);
  const { id, ...content } = row;
  context.op.batch.create('field_assertions', id, {
    ...content,
    refs: refsOf(context.schema, row.field_id, row.value),
  });
}

/** Changes stored or planned assertions; the plan sees the new values. */
export function updateAssertion(
  context: WriteContext,
  row: AssertionRow,
  changes: Partial<Omit<AssertionRow, 'id'>>,
): AssertionRow {
  const next = { ...row, ...changes };
  planState(context.op).assertions.set(row.id, next);
  context.op.batch.update(
    'field_assertions',
    row.id,
    'value' in changes
      ? { ...changes, refs: refsOf(context.schema, next.field_id, next.value) }
      : changes,
  );
  return next;
}

/**
 * The write path (rules 2.2–2.5): one assertion per field, the touched
 * fields' winners recomputed, then the record's columns, edges,
 * identifiers, label and search document follow, all in the commit.
 */
export async function writeFields(
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  writes: Map<FieldState, unknown>,
  options: WriteOptions = {},
): Promise<Record<string, FieldWriteStatus>> {
  if (
    options.expectedUpdatedAt !== undefined &&
    record.updated_at.getTime() !== new Date(options.expectedUpdatedAt).getTime()
  ) {
    throw new AppError(412, 'stale_write', 'the record changed since expectedUpdatedAt', {
      updatedAt: record.updated_at.toISOString(),
    });
  }
  await checkRelationTargets(context, object, writes);
  if (!options.skipSuppressionCheck) await checkSuppressed(context, object, record, writes);

  const fields = [...writes.keys()];
  const observedAt = options.observedAt ?? context.op.now;
  const confidence = options.confidence ?? 1;
  const actorType: ActorType = context.actor.type;

  const existing = await assertionsOf(
    context,
    record.id,
    fields.map((f) => f.id as string),
    ['active', 'superseded'],
  );

  const statuses: Record<string, FieldWriteStatus> = {};
  const winners = new Map<FieldState, AssertionRow | undefined>();

  for (const field of fields) {
    const value = writes.get(field);
    const current = existing.filter((a) => a.field_id === field.id);
    const currentWinner = pickWinner(current.map(toRanked));
    const reason: ReviewReason | null = reviewReason(
      { actorType, value, observedAt, confidence },
      currentWinner,
      context.confidenceThreshold,
    );

    const assertion: AssertionRow = {
      id: context.op.newId(),
      record: record.id,
      field_id: field.id as string,
      value: value ?? null,
      actor: context.actor,
      source: options.sourceRecordId ?? null,
      is_initial: options.isInitial ?? false,
      confidence,
      status: reason ? 'pending_review' : 'active',
      review_reason: reason,
      observed_at: observedAt,
      reviewed_by: null,
      reviewed_at: null,
      created_at: context.op.tick(),
    };

    if (reason) {
      insertAssertion(context, assertion);
      statuses[field.name] = 'pending_review';
      continue;
    }

    const candidates = [...current, assertion];
    const winnerId = pickWinner(candidates.map(toRanked))?.id as string;
    if (winnerId !== assertion.id) assertion.status = 'superseded';
    insertAssertion(context, assertion);
    for (const row of current) {
      const status = row.id === winnerId ? 'active' : 'superseded';
      if (row.status !== status) updateAssertion(context, row, { status });
    }
    statuses[field.name] = winnerId === assertion.id ? 'applied' : 'superseded';
    winners.set(
      field,
      candidates.find((a) => a.id === winnerId),
    );
  }

  if (winners.size > 0) await applyWinners(context, object, record, winners);
  return statuses;
}

// ---------------------------------------------------------------------------
// Derived state: columns, edges, identifiers, label, search
// ---------------------------------------------------------------------------

/** One field's current edge targets, as this plan sees them. */
export async function currentTargets(
  context: WriteContext,
  object: CompiledObject,
  field: FieldState,
  sourceId: string,
): Promise<string[]> {
  const state = planState(context.op);
  const key = pair(field.id as string, sourceId);
  const planned = state.edges.get(key);
  if (planned) return planned;
  const targets = await edgeTargets(context.op.db, field, { id: sourceId, object });
  state.edges.set(key, targets);
  return targets;
}

/** The table of a record this plan knows. */
async function tableOf(context: WriteContext, id: string): Promise<string> {
  const entry = (await entriesOf(context.op, [id])).get(id);
  const object = entry ? context.schema.objectsById.get(entry.object_type_id) : undefined;
  if (!object) throw new Error(`record ${id} has no known object`);
  return object.table;
}

/**
 * Makes one owning relation field's edges follow its winner: removes the
 * targets that left, relates the new ones, and keeps provenance on the rest.
 */
export async function syncEdges(
  context: WriteContext,
  object: CompiledObject,
  field: FieldState,
  sourceId: string,
  targets: readonly string[],
  provenance: { assertion: string | null; actor: Actor },
): Promise<void> {
  const before = await currentTargets(context, object, field, sourceId);
  const removed = before.filter((t) => !targets.includes(t));
  const added = targets.filter((t) => !before.includes(t));
  const kept = targets.filter((t) => before.includes(t));
  const batch = context.op.batch;
  const table = ident(relationTable(field.universalId));
  const source = new RecordId(object.table, sourceId);
  if (removed.length > 0) {
    const outs = await Promise.all(
      removed.map(async (id) => new RecordId(await tableOf(context, id), id)),
    );
    batch.write(
      `DELETE ${table} WHERE in = ${batch.v(source)} AND out IN ${batch.v(outs)} RETURN BEFORE`,
      removed.length,
      'edges',
    );
  }
  if (kept.length > 0) {
    batch.write(
      `UPDATE ${table} SET assertion = ${batch.v(provenance.assertion ?? undefined)}, created_by = ${batch.v(
        provenance.actor,
      )} WHERE in = ${batch.v(source)} RETURN id`,
      kept.length,
      'edges',
    );
  }
  for (const id of added) {
    const out = new RecordId(await tableOf(context, id), id);
    batch.write(
      `RELATE ${batch.v(source)}->${table}->${batch.v(out)} CONTENT ${batch.v({
        assertion: provenance.assertion ?? undefined,
        created_by: provenance.actor,
        created_at: context.op.now,
      })} RETURN id`,
      1,
      'edge',
    );
  }
  planState(context.op).edges.set(pair(field.id as string, sourceId), [...targets]);
  if (removed.length > 0 || added.length > 0) {
    await edgesChanged(context, object, field, sourceId, added, removed);
  }
}

/** A record's identifier lookups for one field, as this plan sees them. */
async function identifierRows(
  context: WriteContext,
  recordId: string,
  field: FieldState,
): Promise<IdentifierRow[]> {
  const state = planState(context.op);
  const key = pair(recordId, field.id as string);
  const planned = state.identifiers.get(key);
  if (planned) return planned;
  const rows = await context.op.rows<{ id: RecordId; kind: string; value: string }>(
    'SELECT id, kind, value FROM record_identifiers WHERE record = $record AND field_id = $field;',
    { record: recordId, field: field.id },
  );
  const list = rows.map((r) => ({ id: publicId(r.id), kind: r.kind, value: r.value }));
  state.identifiers.set(key, list);
  return list;
}

async function claimRows(
  context: WriteContext,
  recordId: string,
  field: FieldState,
): Promise<ClaimRow[]> {
  const state = planState(context.op);
  const key = pair(recordId, field.id as string);
  const planned = state.claims.get(key);
  if (planned) return planned;
  const rows = await context.op.rows<{ id: RecordId; value: string }>(
    'SELECT id, value FROM unique_claims WHERE record = $record AND field_id = $field;',
    { record: recordId, field: field.id },
  );
  const list = rows.map((r) => ({ id: publicId(r.id), value: r.value }));
  state.claims.set(key, list);
  for (const row of list) state.holders.set(pair(field.id as string, row.value), recordId);
  return list;
}

/** The record holding a unique value, as this plan sees it. */
export async function claimHolder(
  context: WriteContext,
  field: FieldState,
  value: string,
): Promise<string | null> {
  const state = planState(context.op);
  const key = pair(field.id as string, value);
  if (state.holders.has(key)) return state.holders.get(key) ?? null;
  const [row] = await context.op.rows<{ record: string }>(
    'SELECT record FROM unique_claims WHERE field_id = $field AND value = $value LIMIT 1;',
    { field: field.id, value },
  );
  state.holders.set(key, row?.record ?? null);
  return row?.record ?? null;
}

/**
 * Replaces a field's identifier lookups and unique claims with those of a
 * new value, returning the first claim another record holds instead (and
 * changing nothing then), so a caller can try another value.
 */
async function claimIdentifiers(
  context: WriteContext,
  recordId: string,
  field: FieldState,
  value: unknown,
): Promise<{ value: string; recordId: string } | null> {
  const next: Identifier[] = identifiersFor(field, value);
  if (field.isUnique) {
    for (const identifier of next) {
      const holder = await claimHolder(context, field, identifier.value);
      if (holder && holder !== recordId) return { value: identifier.value, recordId: holder };
    }
  }
  const state = planState(context.op);
  const key = pair(recordId, field.id as string);
  const batch = context.op.batch;

  const lookups = await identifierRows(context, recordId, field);
  const sameLookups =
    lookups.length === next.length &&
    next.every((i) => lookups.some((l) => l.kind === i.kind && l.value === i.value));
  if (!sameLookups) {
    batch.deleteIds(
      'record_identifiers',
      lookups.map((l) => l.id),
    );
    const rows = next.map((i) => ({ id: context.op.newId(), kind: i.kind, value: i.value }));
    batch.insert(
      'record_identifiers',
      rows.map((r) => ({
        ...r,
        record: recordId,
        field_id: field.id as string,
        created_at: context.op.now,
      })),
    );
    state.identifiers.set(key, rows);
  }

  if (field.isUnique) {
    const claims = await claimRows(context, recordId, field);
    const values = [...new Set(next.map((i) => i.value))];
    const same =
      claims.length === values.length && values.every((v) => claims.some((c) => c.value === v));
    if (!same) {
      batch.deleteIds(
        'unique_claims',
        claims.map((c) => c.id),
      );
      for (const claim of claims) state.holders.set(pair(field.id as string, claim.value), null);
      const rows = values.map((v) => ({ id: context.op.newId(), value: v }));
      batch.insert(
        'unique_claims',
        rows.map((r) => ({
          ...r,
          record: recordId,
          field_id: field.id as string,
          created_at: context.op.now,
        })),
      );
      for (const row of rows) state.holders.set(pair(field.id as string, row.value), recordId);
      state.claims.set(key, rows);
    }
  }
  return null;
}

/** Releases every lookup and claim a record holds for some fields. */
export async function releaseIdentifiers(
  context: WriteContext,
  recordId: string,
  fields: readonly FieldState[],
): Promise<void> {
  for (const field of fields) {
    if (!hasIdentifiers(field)) continue;
    await claimIdentifiers(context, recordId, field, null);
  }
}

async function replaceIdentifiers(
  context: WriteContext,
  recordId: string,
  field: FieldState,
  value: unknown,
): Promise<void> {
  const conflict = await claimIdentifiers(context, recordId, field, value);
  if (conflict) throw new UniqueConflictError(field, conflict.value, conflict.recordId);
}

/** Writes a record's changed columns, label and search document. */
export async function saveRecord(
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const field of object.state.fields) {
    if (field.type === 'relation') continue;
    const before = record.data[field.key];
    const after = data[field.key];
    if (JSON.stringify(before) === JSON.stringify(after) && Object.hasOwn(record.data, field.key) === Object.hasOwn(data, field.key)) {
      continue;
    }
    set[fieldColumn(field.key)] = Object.hasOwn(data, field.key)
      ? toColumn(field, after)
      : undefined;
  }
  const label = await writeRecordSearch(context, object, record.id, data);
  context.op.batch.update(object.table, record.id, {
    ...set,
    label,
    updated_at: context.op.now,
    updated_by: context.actor,
    ...extra,
  });
  // The directory's `updated_at` is what change scans (the consolidator) read.
  const touched = (context.op.cache.get('directoryTouched') as Set<string> | undefined) ?? new Set();
  context.op.cache.set('directoryTouched', touched);
  if (!touched.has(record.id)) {
    touched.add(record.id);
    context.op.batch.update('record_directory', record.id, { updated_at: context.op.now });
  }
  record.data = data;
  record.label = label;
  record.updated_at = context.op.now;
}

/**
 * Makes the record's columns, edges, identifiers, label and search
 * document follow the given fields' winners (rule 2.4).
 */
async function applyWinners(
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  winners: Map<FieldState, AssertionRow | undefined>,
  identifiersDone: ReadonlySet<FieldState> = new Set(),
): Promise<void> {
  const data = { ...record.data };
  for (const [field, winner] of winners) {
    if (field.type === 'relation') {
      const targets = Array.isArray(winner?.value)
        ? (winner.value as string[])
        : winner?.value
          ? [winner.value as string]
          : [];
      await syncEdges(context, object, field, record.id, targets, {
        assertion: winner?.id ?? null,
        actor: winner?.actor ?? context.actor,
      });
      continue;
    }
    if (winner) data[field.key] = winner.value;
    else delete data[field.key];

    if (hasIdentifiers(field) && !identifiersDone.has(field)) {
      await replaceIdentifiers(context, record.id, field, winner?.value ?? null);
    }
  }
  await saveRecord(context, object, record, data);
}

/**
 * Recomputes fields of a record from their eligible assertions alone (rule
 * 2.4): the winner becomes `active`, the rest `superseded`, and the derived
 * state follows. Used after assertions stop counting, e.g. when their
 * source is retracted.
 *
 * An older value can no longer be restored when another record has since
 * claimed it (1.2). Rather than fail, so that a retraction always takes
 * effect, that candidate waits for review (`unique_conflict`) and the next
 * one wins; accepting it later fails until the claim is released.
 */
export async function recomputeFields(
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  fieldIds: readonly string[],
): Promise<void> {
  const fields = fieldIds
    .map((id) => object.fieldsById.get(id))
    .filter((f): f is FieldState => f !== undefined);
  if (fields.length === 0) return;
  const rows = await assertionsOf(
    context,
    record.id,
    fields.map((f) => f.id as string),
    ['active', 'superseded'],
  );
  const winners = new Map<FieldState, AssertionRow | undefined>();
  const claimed = new Set<FieldState>();
  for (const field of fields) {
    const ranked = rows
      .filter((r) => r.field_id === field.id)
      .sort((a, b) => compareAssertions(toRanked(a), toRanked(b)));
    let winner: AssertionRow | undefined = ranked[0];
    if (field.isUnique) {
      winner = undefined;
      for (const candidate of ranked) {
        const holder = await claimIdentifiers(context, record.id, field, candidate.value);
        if (!holder) {
          winner = candidate;
          break;
        }
        updateAssertion(context, candidate, {
          status: 'pending_review',
          review_reason: 'unique_conflict',
        });
      }
      if (!winner) await claimIdentifiers(context, record.id, field, null);
      claimed.add(field);
    }
    for (const row of ranked) {
      if (row.status === 'pending_review') continue;
      const current = planState(context.op).assertions.get(row.id) ?? row;
      if (current.status === 'pending_review') continue;
      const status = row.id === winner?.id ? 'active' : 'superseded';
      if (current.status !== status) updateAssertion(context, current, { status });
    }
    winners.set(field, winner);
  }
  await applyWinners(context, object, record, winners, claimed);
}

/** Loads records (sorted), for merges, retraction and `forget` (rule 2.5). */
export async function lockRecordsForUpdate(
  context: WriteContext,
  ids: readonly string[],
): Promise<LockedRecord[]> {
  if (ids.length === 0) return [];
  const sorted = [...new Set(ids)].sort();
  const records = await loadRecords(context, sorted);
  return sorted.flatMap((id) => {
    const record = records.get(id);
    return record ? [record] : [];
  });
}

/** An assertion that stopped counting, with the status it had. */
export type RemovedClaim = { record_id: string; field_id: string; status: string };

/**
 * After assertions stop counting (retracted or deleted), recomputes the
 * fields where one of them was winning, on the given records. Every unique
 * claim those winners held is released first, across all records, so a
 * claim from one record cannot block another's previous value from coming
 * back. Returns the IDs of the records recomputed.
 */
export async function releaseAndRecompute(
  context: WriteContext,
  locked: readonly LockedRecord[],
  removed: readonly RemovedClaim[],
): Promise<string[]> {
  const winners = removed.filter((c) => c.status === 'active');
  for (const claim of winners) {
    const record = locked.find((r) => r.id === claim.record_id);
    const object = record ? context.schema.objectsById.get(record.object_type_id) : undefined;
    const field = object?.fieldsById.get(claim.field_id);
    if (field?.isUnique) await claimIdentifiers(context, claim.record_id, field, null);
  }
  const recomputed: string[] = [];
  for (const record of locked) {
    const fieldIds = [
      ...new Set(winners.filter((c) => c.record_id === record.id).map((c) => c.field_id)),
    ];
    const object = context.schema.objectsById.get(record.object_type_id);
    if (fieldIds.length === 0 || !object) continue;
    await recomputeFields(context, object, record, fieldIds);
    recomputed.push(record.id);
  }
  return recomputed;
}

/**
 * Closes pending merge suggestions that involve records which are no
 * longer live (merged or deleted), so review only ever lists live pairs.
 */
export async function closeSuggestionsFor(
  context: WriteContext,
  recordIds: readonly string[],
): Promise<void> {
  if (recordIds.length === 0) return;
  const [a, b] = (await context.op.db.query(
    `SELECT id FROM merge_suggestions WHERE record_a IN $ids AND status = 'pending';
     SELECT id FROM merge_suggestions WHERE record_b IN $ids AND status = 'pending';`,
    { ids: [...recordIds] },
  )) as [{ id: RecordId }[], { id: RecordId }[]];
  const ids = [...new Set([...a, ...b].map((r) => publicId(r.id)))];
  for (const id of ids) {
    context.op.batch.update('merge_suggestions', id, {
      status: 'dismissed',
      decided_by: context.actor,
      decided_at: context.op.now,
    });
  }
}

/** A new, empty record; the caller writes its values with `writeFields`. */
export async function insertRecord(
  context: WriteContext,
  object: CompiledObject,
  extra: { occurredAt?: Date } = {},
): Promise<LockedRecord> {
  const id = context.op.newId();
  const now = context.op.now;
  const batch = context.op.batch;
  batch.create('record_directory', id, {
    object_type_id: object.id,
    tb: object.table,
    is_event: object.isEvent,
    created_at: now,
    updated_at: now,
  });
  batch.create(object.table, id, {
    created_at: now,
    updated_at: now,
    created_by: context.actor,
    updated_by: context.actor,
    label: null,
    ...(extra.occurredAt ? { occurred_at: extra.occurredAt } : {}),
  });
  setEntry(context.op, {
    id,
    object_type_id: object.id,
    tb: object.table,
    is_event: object.isEvent,
    created_at: now,
    deleted_at: null,
    merged_into: null,
  });
  const record: LockedRecord = {
    id,
    object_type_id: object.id,
    data: {},
    label: null,
    updated_at: now,
    deleted_at: null,
    merged_into_id: null,
    created_at: now,
    created_by: context.actor,
    occurred_at: extra.occurredAt ?? null,
  };
  planState(context.op).records.set(id, record);
  // A new record has no edges, identifiers or claims to read.
  const state = planState(context.op);
  for (const field of object.state.fields) {
    if (field.type === 'relation' && !field.settings.isInverse) {
      state.edges.set(pair(field.id as string, id), []);
    }
    if (hasIdentifiers(field)) {
      state.identifiers.set(pair(id, field.id as string), []);
      state.claims.set(pair(id, field.id as string), []);
    }
  }
  return record;
}

/**
 * Recomputes a record's values from its assertions alone (rule 2.4). Used
 * to prove the columns are a cache, and to rebuild them.
 */
export async function computeDataFromAssertions(
  db: Db,
  object: CompiledObject,
  recordId: string,
): Promise<Record<string, unknown>> {
  const rows = (
    await db.rows<StoredAssertion>(
      "SELECT * FROM field_assertions WHERE record = $record AND status IN ['active', 'superseded'];",
      { record: recordId },
    )
  ).map(fromStored);
  const data: Record<string, unknown> = {};
  for (const field of object.state.fields) {
    if (field.type === 'relation') continue;
    const winner = pickWinner(rows.filter((r) => r.field_id === field.id).map(toRanked));
    if (winner) data[field.key] = winner.value;
  }
  return data;
}

/**
 * The record and every live record that deleting it reaches through
 * `onDelete: cascade` relations, at any depth: what `softDeleteRecord`
 * deletes, and what the delete dialog warns about beforehand. Each step
 * reads incoming edges through the records' own graph pointers.
 */
export async function cascadeSet(
  db: Db,
  schema: CompiledSchema,
  roots: readonly string[],
): Promise<Set<string>> {
  const cascadeFields = schema.state.objects.flatMap((o) =>
    o.fields.filter((f) => f.status === 'active' && f.settings.onDelete === 'cascade'),
  );
  const ids = new Set(roots);
  let frontier = [...ids];
  while (frontier.length > 0 && cascadeFields.length > 0) {
    const entries = await directoryEntries(db, frontier);
    const vars: Record<string, unknown> = {};
    const statements: string[] = [];
    let n = 0;
    for (const field of cascadeFields) {
      const targets = relationTargetIds(field.settings)
        .map((id) => schema.objectsByUniversalId.get(id))
        .filter((o): o is CompiledObject => o !== undefined);
      const refs = [...entries.values()]
        .filter((e) => targets.some((t) => t.id === e.object_type_id))
        .map((e) => new RecordId(e.tb, e.id));
      if (refs.length === 0) continue;
      vars[`t${n}`] = refs;
      statements.push(
        `SELECT VALUE <-${ident(relationTable(field.universalId))}<-? FROM $t${n};`,
      );
      n++;
    }
    if (statements.length === 0) break;
    const results = (await db.query(statements.join('\n'), vars)) as RecordId[][][];
    const sources = [...new Set(results.flat(2).map(publicId))].filter((id) => !ids.has(id));
    const live = await directoryEntries(db, sources);
    frontier = sources.filter((id) => {
      const entry = live.get(id);
      return entry && !entry.deleted_at && !entry.merged_into;
    });
    for (const id of frontier) ids.add(id);
  }
  return ids;
}

/**
 * Soft-deletes a record (2.1). Relations to it with `onDelete: cascade`
 * soft-delete their source records too; `set_null` relations simply stop
 * resolving, since reads skip deleted targets. Uniqueness claims stay, so
 * writes cannot silently recreate the record. Returns the IDs deleted; the
 * events among them are retracted by the caller (`deleteRecords`).
 */
export async function softDeleteRecord(context: WriteContext, id: string): Promise<string[]> {
  const rootId = await resolveRecordId(context.op, id);
  const sorted = [...(await cascadeSet(context.op.db, context.schema, [rootId]))].sort();
  const locked = await lockRecordsForUpdate(context, sorted);
  const root = locked.find((r) => r.id === rootId);
  if (root) objectOf(context.schema, root);
  if (root?.deleted_at) {
    throw new AppError(409, 'record_deleted', `record ${rootId} is already deleted`, {
      recordId: rootId,
    });
  }
  return markDeleted(context, sorted);
}

/** Sets `deleted_at` on records, returning those it deleted now. */
export async function markDeleted(context: WriteContext, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const records = await lockRecordsForUpdate(context, ids);
  const deleted: string[] = [];
  for (const record of records) {
    if (record.deleted_at) continue;
    const object = context.schema.objectsById.get(record.object_type_id);
    if (!object) continue;
    context.op.batch.update(object.table, record.id, {
      deleted_at: context.op.now,
      updated_at: context.op.now,
      updated_by: context.actor,
    });
    context.op.batch.update('record_directory', record.id, {
      deleted_at: context.op.now,
      updated_at: context.op.now,
    });
    record.deleted_at = context.op.now;
    record.updated_at = context.op.now;
    const entry = (await entriesOf(context.op, [record.id])).get(record.id);
    if (entry) setEntry(context.op, { ...entry, deleted_at: context.op.now });
    deleteSearchDocuments(context, [record.id]);
    deleted.push(record.id);
  }
  const sorted = deleted.sort();
  await closeSuggestionsFor(context, sorted);
  return sorted;
}
