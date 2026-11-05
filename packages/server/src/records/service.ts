import type {
  Actor,
  AggregateResult,
  BulkDeleteImpact,
  DeleteImpact,
  DeleteRecordResult,
  ForgetResult,
  MergeResult,
  MergeSuggestionDecision,
  TraverseInput,
  TraverseResult,
} from '@retainer/shared';
import { z } from 'zod';
import type { Backend, Db } from '../db/backend.js';
import { mutate, type Operation, readWorkspace } from '../db/protocol.js';
import type { ApiKeyScope } from '../db/types.js';
import { AppError, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { lockSource, retractEventClaims } from '../memory/events.js';
import { forgetRecord } from '../privacy/forget.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { type AggregateInput, aggregateRecords } from './aggregate.js';
import { identifiersFor, lookupValue } from './derive.js';
import {
  dismissMergeSuggestion,
  type MergeInput,
  type MergeOutcome,
  mergeRecords,
} from './merge.js';
import { type QueryInput, queryRecords } from './query.js';
import { getRecord, type PresentedRecord } from './read.js';
import {
  acceptAssertion,
  type DecisionResult as DecisionOutcome,
  rejectAssertion,
} from './review.js';
import { directoryEntries } from './store.js';
import { traverseRecords } from './traverse.js';
import { normalizeFieldValue, prepareValues } from './values.js';
import {
  cascadeSet,
  claimHolder,
  entriesOf,
  type FieldWriteStatus,
  insertRecord,
  lockRecord,
  objectOf,
  resolveRecordId,
  resolveRecordIdIn,
  softDeleteRecord,
  type WriteContext,
  type WriteOptions,
  writeFields,
} from './write.js';

/** Who is calling, from their API key. */
export type Caller = {
  workspaceId: string;
  actor: Actor;
  scopes: readonly ApiKeyScope[];
};

/** A decision on a pending assertion, with the record as it now stands. */
export type DecisionResult = Omit<DecisionOutcome, 'recordId'> & { record: PresentedRecord };

export type WriteResponse = {
  id: string;
  created: boolean;
  /** Per written field: `applied`, `pending_review` or `superseded` (6.2). */
  fields: Record<string, FieldWriteStatus>;
  record: PresentedRecord;
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/** The write context of an operation (section 6): its schema and settings. */
export async function writeContext(op: Operation, actor: Caller['actor']): Promise<WriteContext> {
  return {
    op,
    workspaceId: op.workspaceId,
    actor,
    schema: await op.schema(),
    confidenceThreshold: op.state.settings.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
  };
}

export type WriteRun<T> = {
  /** The operation kind; scopes idempotency keys (section 7). */
  kind: string;
  idempotencyKey?: string;
  /** What identifies the request, for detecting a key reused differently. */
  request?: unknown;
  /** Public IDs the result refers to, so erasure can sanitize the receipt. */
  refs?: (result: T) => string[];
};

/**
 * A workspace write under the write protocol (section 6): the plan runs
 * with a write context; its result is the operation's receipt.
 */
export async function withWrite<T>(
  backend: Backend,
  caller: Caller,
  run: WriteRun<T>,
  fn: (context: WriteContext) => Promise<T>,
): Promise<{ result: T; operationId: string; replayed: boolean }> {
  return mutate(backend, caller.workspaceId, {
    kind: run.kind,
    ...(run.idempotencyKey !== undefined
      ? { idempotencyKey: run.idempotencyKey, requestHash: requestHash(run.request ?? null) }
      : {}),
    refs: run.refs ?? (() => []),
    plan: async (op) => fn(await writeContext(op, caller.actor)),
  });
}

export async function withRead<T>(
  backend: Backend,
  caller: Caller,
  fn: (db: Db, schema: CompiledSchema) => Promise<T>,
): Promise<T> {
  return readWorkspace(backend, caller.workspaceId, async ({ db, schema }) =>
    fn(db, await schema()),
  );
}

/** Presents a record after the write that changed it committed. */
async function present(backend: Backend, caller: Caller, id: string): Promise<PresentedRecord> {
  return withRead(backend, caller, (db, schema) => getRecord(db, caller.workspaceId, schema, id));
}

type WriteOutcome = { id: string; created: boolean; fields: Record<string, FieldWriteStatus> };

async function respond(
  backend: Backend,
  caller: Caller,
  outcome: WriteOutcome,
): Promise<WriteResponse> {
  return { ...outcome, record: await present(backend, caller, outcome.id) };
}

/**
 * An object by singular or plural API name. The hidden internal-note type
 * (6.4) is not in `objectsByName`, so every route that names an object
 * resolves it as not found.
 */
export function requireObject(schema: CompiledSchema, name: string): CompiledObject {
  const object =
    schema.objectsByName.get(name) ??
    [...schema.objectsByName.values()].find((o) => o.state.namePlural === name);
  if (!object) {
    throw notFound(`object "${name}"`, { objects: [...schema.objectsByName.keys()] });
  }
  return object;
}

/** Only logging creates events (6.2): record writes may edit one, never create one. */
function refuseEventCreation(object: CompiledObject): void {
  if (!object.isEvent) return;
  throw new AppError(
    422,
    'use_log_event',
    `${object.name} is an event type: create its records with log_event (POST /v1/events), ` +
      'which records when it happened, its source and who took part. upsert_record can edit ' +
      'an event that exists',
    { object: object.name },
  );
}

export const valuesSchema = z.record(z.string(), z.unknown());

/** The event a write cites (rule 2.1); its `occurred_at` becomes `observed_at`. */
export const sourceSchema = z.uuid();

/**
 * Write options for a cited source (rules 2.1, 2.2): the event must be live
 * in this workspace, and its `occurred_at` is the claim's `observed_at`. It
 * is locked before any record, the order deletion uses.
 */
async function citeSource(context: WriteContext, source?: string): Promise<WriteOptions> {
  if (source === undefined) return {};
  const cited = await lockSource(context, source);
  return { sourceRecordId: cited.id, observedAt: cited.occurredAt };
}

export type CreateOptions = {
  /** Retrying with the same key returns the first result (6.2). */
  idempotencyKey?: string;
  /** The event the values come from. */
  source?: string;
};

export async function createRecord(
  backend: Backend,
  caller: Caller,
  objectName: string,
  values: Record<string, unknown>,
  options: CreateOptions = {},
): Promise<WriteResponse> {
  const { idempotencyKey, source } = options;
  const { result } = await withWrite<WriteOutcome>(
    backend,
    caller,
    {
      kind: 'create_record',
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      request: { object: objectName, values, source: source ?? null },
      refs: (r) => [r.id],
    },
    async (context) => {
      const object = requireObject(context.schema, objectName);
      refuseEventCreation(object);
      const cited = await citeSource(context, source);
      const writes = prepareValues(object, values, 'create');
      const record = await insertRecord(context, object);
      const fields = await writeFields(context, object, record, writes, cited);
      return { id: record.id, created: true, fields };
    },
  );
  return respond(backend, caller, result);
}

export const upsertInputSchema = z.strictObject({
  id: z.uuid().optional(),
  match: z.record(z.string(), z.unknown()).optional(),
  values: valuesSchema.default({}),
  ifMissing: z.enum(['fail', 'create']).default('fail'),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  source: sourceSchema.optional(),
});
export type UpsertInput = z.infer<typeof upsertInputSchema>;

const SEARCH_HINT = 'find the record with search or query_records, then update it by id';

/** Resolves `match` to its unique field, or explains why it cannot match (6.2). */
function matchField(object: CompiledObject, match: Record<string, unknown>) {
  const entries = Object.entries(match);
  const uniqueNames = object.activeFields.filter((f) => f.isUnique).map((f) => f.name);
  if (entries.length !== 1) {
    throw new AppError(422, 'invalid_match', 'match takes exactly one unique field and value', {
      allowed: uniqueNames,
    });
  }
  const [[name, value]] = entries as [[string, unknown]];
  const field = object.fieldsByName.get(name);
  if (!field) {
    throw new AppError(422, 'invalid_match', `unknown field "${name}" on ${object.name}`, {
      field: name,
      allowed: uniqueNames,
    });
  }
  if (!field.isUnique) {
    const why =
      field.type === 'phones'
        ? 'phones are not unique: numbers are shared and reassigned'
        : `${name} is not unique, so it cannot select one record`;
    throw new AppError(422, 'invalid_match', `${why}; ${SEARCH_HINT}`, {
      field: name,
      allowed: uniqueNames,
    });
  }
  const lookup = lookupValue(field, value);
  if (lookup === null) {
    throw new AppError(422, 'invalid_match', `match.${name} needs a non-empty value`, {
      field: name,
    });
  }
  return { field, value, lookup };
}

/** With `ifMissing: "create"`, the match value is written to the new record. */
function valuesWithMatch(
  field: FieldState,
  matchValue: unknown,
  lookup: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const given = values[field.name];
  if (given === undefined) return { ...values, [field.name]: matchValue };
  let identifiers: string[];
  try {
    identifiers = identifiersFor(field, normalizeFieldValue(field, given)).map((i) => i.value);
  } catch {
    return values; // prepareValues reports the invalid value
  }
  if (!identifiers.includes(lookup)) {
    throw new AppError(422, 'invalid_match', `values.${field.name} must include the match value`, {
      field: field.name,
    });
  }
  return values;
}

/**
 * Updates the record found by `id` or `match`, or creates one (6.2). With
 * `ifMissing: "fail"` (the default) a miss is an error, so "update Dana's
 * address" never creates a person by accident. A create that loses a race
 * on the match value rolls back entirely and retries the lookup, so
 * concurrent upserts of one email end on one record.
 */
export async function upsertRecord(
  backend: Backend,
  caller: Caller,
  objectName: string,
  input: UpsertInput,
): Promise<WriteResponse> {
  if (input.id && input.match) {
    throw new AppError(400, 'invalid_request', 'pass id or match, not both');
  }
  const { result } = await withWrite<WriteOutcome>(
    backend,
    caller,
    { kind: 'upsert_record', refs: (r) => [r.id] },
    async (context) => {
      const object = requireObject(context.schema, objectName);
      const cited = await citeSource(context, input.source);
      let targetId: string | null = null;
      let match: ReturnType<typeof matchField> | undefined;

      if (input.id) {
        targetId = await resolveRecordId(context.op, input.id).catch((error) => {
          if (error instanceof AppError && error.status === 404) return null;
          throw error;
        });
      } else if (input.match) {
        match = matchField(object, input.match);
        const holder = await claimHolder(context, match.field, match.lookup);
        targetId = holder ? await resolveRecordId(context.op, holder) : null;
      }

      if (targetId) {
        const record = await lockRecord(context, targetId);
        if (record.object_type_id !== object.id) {
          throw new AppError(422, 'wrong_object', `record ${record.id} is not a ${object.name}`, {
            object: objectOf(context.schema, record).name,
          });
        }
        const writes = prepareValues(object, input.values, 'update');
        const fields = await writeFields(context, object, record, writes, {
          ...cited,
          ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
        });
        return { id: record.id, created: false, fields };
      }

      if ((input.id || input.match) && input.ifMissing === 'fail') {
        const what = input.id
          ? `record ${input.id}`
          : `${object.name} with ${match?.field.name} ${match?.lookup}`;
        throw new AppError(404, 'not_found', `no ${what}; pass ifMissing: "create" to create it`);
      }

      refuseEventCreation(object);
      const values = match
        ? valuesWithMatch(match.field, match.value, match.lookup, input.values)
        : input.values;
      const writes = prepareValues(object, values, 'create');
      const record = await insertRecord(context, object);
      const fields = await writeFields(context, object, record, writes, cited);
      return { id: record.id, created: true, fields };
    },
  );
  return respond(backend, caller, result);
}

export const patchInputSchema = z.strictObject({
  values: valuesSchema,
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  source: sourceSchema.optional(),
});

export async function patchRecord(
  backend: Backend,
  caller: Caller,
  id: string,
  input: z.infer<typeof patchInputSchema>,
): Promise<WriteResponse> {
  const { result } = await withWrite<WriteOutcome>(
    backend,
    caller,
    { kind: 'patch_record', refs: (r) => [r.id] },
    async (context) => {
      const cited = await citeSource(context, input.source);
      const record = await lockRecord(context, id);
      const object = objectOf(context.schema, record);
      const writes = prepareValues(object, input.values, 'update');
      const fields = await writeFields(context, object, record, writes, {
        ...cited,
        ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
      });
      return { id: record.id, created: false, fields };
    },
  );
  return respond(backend, caller, result);
}

/** Records outside `roots` that deleting them would take along, counted by object. */
async function cascadeCounts(
  db: Db,
  schema: CompiledSchema,
  roots: string[],
): Promise<DeleteImpact['records']> {
  const ids = await cascadeSet(db, schema, roots);
  for (const id of roots) ids.delete(id);
  const entries = await directoryEntries(db, [...ids]);
  const counts = new Map<string, number>();
  for (const entry of entries.values()) {
    counts.set(entry.object_type_id, (counts.get(entry.object_type_id) ?? 0) + 1);
  }
  return [...counts]
    .map(([objectId, count]) => ({
      object: schema.objectsById.get(objectId)?.name ?? 'unknown',
      count,
    }))
    .sort((a, b) => a.object.localeCompare(b.object));
}

/**
 * What deleting a record would delete with it through cascading relations,
 * counted by object, at any depth and without changing anything.
 */
export async function deleteImpact(
  backend: Backend,
  caller: Caller,
  id: string,
): Promise<DeleteImpact> {
  return withRead(backend, caller, async (db, schema) => {
    const record = await getRecord(db, caller.workspaceId, schema, id);
    return { id: record.id, records: await cascadeCounts(db, schema, [record.id]) };
  });
}

export const bulkDeleteImpactSchema = z.strictObject({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
/** The same for several records deleted together: overlaps count once. */
export async function bulkDeleteImpact(
  backend: Backend,
  caller: Caller,
  input: z.infer<typeof bulkDeleteImpactSchema>,
): Promise<BulkDeleteImpact> {
  return withRead(backend, caller, async (db, schema) => {
    const roots = new Set<string>();
    for (const id of input.ids) {
      const canonical = await resolveRecordIdIn(db, id);
      const entry = (await directoryEntries(db, [canonical])).get(canonical);
      if (!entry) throw notFound('record', { id });
      if (entry.deleted_at)
        throw new AppError(404, 'record_deleted', `record ${canonical} was deleted`, {
          recordId: canonical,
        });
      roots.add(canonical);
    }
    return { ids: [...roots], records: await cascadeCounts(db, schema, [...roots]) };
  });
}

/** Totals over the records a filter matches, for a list's footer. */
export async function aggregate(
  backend: Backend,
  caller: Caller,
  objectName: string,
  input: AggregateInput,
): Promise<AggregateResult> {
  return withRead(backend, caller, (db, schema) =>
    aggregateRecords(db, caller.workspaceId, schema, requireObject(schema, objectName), input),
  );
}

/**
 * Soft-deletes a record and what cascades from it (2.1). Every event among
 * them goes through the deletion lifecycle (6.4): what cites it is
 * retracted and recomputed, and the response counts how far that reached.
 */
export async function deleteRecord(
  backend: Backend,
  caller: Caller,
  id: string,
): Promise<DeleteRecordResult> {
  const { result } = await withWrite<DeleteRecordResult>(
    backend,
    caller,
    { kind: 'delete_record', refs: (r) => [r.id, ...r.deletedRecordIds] },
    async (context) => {
      const rootId = await resolveRecordId(context.op, id);
      const deletedRecordIds = await softDeleteRecord(context, id);
      const events = await eventsAmong(context, deletedRecordIds);
      // Deleting an event retracts what cites it, and says how much (6.4).
      const retraction = events.length > 0 ? await retractEventClaims(context, events) : {};
      return { id: rootId, deleted: true, deletedRecordIds, ...retraction } as DeleteRecordResult;
    },
  );
  return result;
}

/** The event records among `ids`. */
export async function eventsAmong(
  context: WriteContext,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const entries = await entriesOf(context.op, ids);
  return [...entries.values()]
    .filter((e) => context.schema.objectsById.get(e.object_type_id)?.isEvent)
    .map((e) => e.id)
    .sort();
}

/** `traverse_records`: bounded walks along an explicit path (section 8). */
export async function traverse(
  backend: Backend,
  caller: Caller,
  input: TraverseInput,
): Promise<TraverseResult> {
  return withRead(backend, caller, (db, schema) => traverseRecords(db, schema, input));
}

export async function readRecord(
  backend: Backend,
  caller: Caller,
  id: string,
): Promise<PresentedRecord> {
  return withRead(backend, caller, (db, schema) => getRecord(db, caller.workspaceId, schema, id));
}

export async function findRecords(
  backend: Backend,
  caller: Caller,
  objectName: string,
  input: QueryInput,
) {
  return withRead(backend, caller, (db, schema) =>
    queryRecords(db, caller.workspaceId, schema, requireObject(schema, objectName), input),
  );
}

export async function decideAssertion(
  backend: Backend,
  caller: Caller,
  assertionId: string,
  decision: 'accept' | 'reject',
): Promise<DecisionResult> {
  const { result } = await withWrite<DecisionOutcome>(
    backend,
    caller,
    { kind: `${decision}_assertion`, refs: (r) => [r.recordId] },
    (context) =>
      decision === 'accept'
        ? acceptAssertion(context, assertionId)
        : rejectAssertion(context, assertionId),
  );
  const { recordId, ...rest } = result;
  return { ...rest, record: await present(backend, caller, recordId) };
}

/**
 * Merges `input.recordId` into record `id` (4.2). With an idempotency key,
 * a retry returns the first result; without one, merging again is a no-op
 * by state.
 */
export async function mergeRecord(
  backend: Backend,
  caller: Caller,
  id: string,
  input: MergeInput,
  idempotencyKey?: string,
): Promise<MergeResult> {
  const { result } = await withWrite<MergeOutcome>(
    backend,
    caller,
    {
      kind: 'merge',
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      request: { id, recordId: input.recordId, values: input.values ?? null },
      refs: (r) => [r.id, r.mergedId, ...r.recomputedRecordIds],
    },
    (context) => mergeRecords(context, id, input),
  );
  return { ...result, record: await present(backend, caller, result.id) };
}

export async function dismissSuggestion(
  backend: Backend,
  caller: Caller,
  id: string,
): Promise<MergeSuggestionDecision> {
  const { result } = await withWrite(backend, caller, { kind: 'dismiss_suggestion' }, (context) =>
    dismissMergeSuggestion(context, id),
  );
  return result;
}

/**
 * `forget` (2.1). Like every write it holds the workspace's write queue and
 * commits against the revision it planned on, so no write interleaves.
 */
export async function forget(backend: Backend, caller: Caller, id: string): Promise<ForgetResult> {
  const { result } = await withWrite(
    backend,
    caller,
    { kind: 'forget', refs: () => [] },
    (context) => forgetRecord(context, id),
  );
  return result;
}
