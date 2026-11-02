import type { Actor } from '@retainer/shared';
import { z } from 'zod';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope, WorkspaceSettings } from '../db/schema.js';
import { inWorkspace, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { claimIdempotencyKey, requestHash, storeIdempotentResult } from '../idempotency.js';
import { type CompiledObject, type CompiledSchema, getSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { identifiersFor, lookupValue } from './derive.js';
import { type QueryInput, queryRecords } from './query.js';
import { getRecord, type PresentedRecord } from './read.js';
import {
  acceptAssertion,
  type DecisionResult,
  listReview,
  type ReviewQueue,
  rejectAssertion,
} from './review.js';
import { normalizeFieldValue, prepareValues } from './values.js';
import {
  type FieldWriteStatus,
  insertRecord,
  lockRecord,
  objectOf,
  resolveRecordId,
  softDeleteRecord,
  UniqueConflictError,
  type WriteContext,
  writeFields,
} from './write.js';

/** Who is calling, from their API key. */
export type Caller = {
  workspaceId: string;
  actor: Actor;
  scopes: readonly ApiKeyScope[];
};

export type WriteResponse = {
  id: string;
  created: boolean;
  /** Per written field: `applied`, `pending_review` or `superseded` (6.2). */
  fields: Record<string, FieldWriteStatus>;
  record: PresentedRecord;
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/**
 * A record write: one short workspace transaction holding the schema lock
 * in shared mode, so the schema it validated against stays current (3).
 */
async function withWrite<T>(
  sql: Sql,
  caller: Caller,
  fn: (tx: Tx, context: WriteContext) => Promise<T>,
): Promise<T> {
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    await lockSchemaShared(tx, caller.workspaceId);
    const schema = await getSchema(tx, caller.workspaceId);
    const [workspace] = await tx<{ settings: WorkspaceSettings }[]>`
      select settings from workspaces where id = ${caller.workspaceId}`;
    return fn(tx, {
      workspaceId: caller.workspaceId,
      actor: caller.actor,
      schema,
      confidenceThreshold: workspace?.settings.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    });
  });
}

async function withRead<T>(
  sql: Sql,
  caller: Caller,
  fn: (tx: Tx, schema: CompiledSchema) => Promise<T>,
): Promise<T> {
  return inWorkspace(sql, caller.workspaceId, async (tx) =>
    fn(tx, await getSchema(tx, caller.workspaceId)),
  );
}

/** An object by singular or plural API name. */
export function requireObject(schema: CompiledSchema, name: string): CompiledObject {
  const object =
    schema.objectsByName.get(name) ??
    [...schema.objectsByName.values()].find((o) => o.state.namePlural === name);
  if (!object) {
    throw notFound(`object "${name}"`, { objects: [...schema.objectsByName.keys()] });
  }
  return object;
}

export const valuesSchema = z.record(z.string(), z.unknown());

export async function createRecord(
  sql: Sql,
  caller: Caller,
  objectName: string,
  values: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<WriteResponse> {
  return withWrite(sql, caller, async (tx, context) => {
    const object = requireObject(context.schema, objectName);
    let claimId: string | undefined;
    if (idempotencyKey !== undefined) {
      const claim = await claimIdempotencyKey(
        tx,
        caller.workspaceId,
        'create_record',
        idempotencyKey,
        requestHash({ object: object.name, values }),
      );
      if (claim.kind === 'replay') return claim.result as WriteResponse;
      claimId = claim.id;
    }
    const writes = prepareValues(object, values, 'create');
    const record = await insertRecord(tx, context, object);
    const fields = await writeFields(tx, context, object, record, writes);
    const response: WriteResponse = {
      id: record.id,
      created: true,
      fields,
      record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
    };
    if (claimId) await storeIdempotentResult(tx, claimId, response);
    return response;
  });
}

export const upsertInputSchema = z.strictObject({
  id: z.uuid().optional(),
  match: z.record(z.string(), z.unknown()).optional(),
  values: valuesSchema.default({}),
  ifMissing: z.enum(['fail', 'create']).default('fail'),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
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
  sql: Sql,
  caller: Caller,
  objectName: string,
  input: UpsertInput,
): Promise<WriteResponse> {
  if (input.id && input.match) {
    throw new AppError(400, 'invalid_request', 'pass id or match, not both');
  }
  for (let attempt = 0; ; attempt++) {
    let creatingWith: FieldState | undefined;
    try {
      return await withWrite(sql, caller, async (tx, context) => {
        const object = requireObject(context.schema, objectName);
        let targetId: string | null = null;
        let match: ReturnType<typeof matchField> | undefined;

        if (input.id) {
          targetId = await resolveRecordId(tx, caller.workspaceId, input.id).catch((error) => {
            if (error instanceof AppError && error.status === 404) return null;
            throw error;
          });
        } else if (input.match) {
          match = matchField(object, input.match);
          const [hit] = await tx<{ record_id: string }[]>`
            select record_id from record_identifiers
            where workspace_id = ${caller.workspaceId} and field_id = ${match.field.id as string}
              and value = ${match.lookup} and is_claim`;
          targetId = hit ? await resolveRecordId(tx, caller.workspaceId, hit.record_id) : null;
        }

        if (targetId) {
          const record = await lockRecord(tx, caller.workspaceId, targetId);
          if (record.object_type_id !== object.id) {
            throw new AppError(422, 'wrong_object', `record ${record.id} is not a ${object.name}`, {
              object: objectOf(context.schema, record).name,
            });
          }
          const writes = prepareValues(object, input.values, 'update');
          const fields = await writeFields(tx, context, object, record, writes, {
            ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
          });
          return {
            id: record.id,
            created: false,
            fields,
            record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
          };
        }

        if ((input.id || input.match) && input.ifMissing === 'fail') {
          const what = input.id
            ? `record ${input.id}`
            : `${object.name} with ${match?.field.name} ${match?.lookup}`;
          throw new AppError(404, 'not_found', `no ${what}; pass ifMissing: "create" to create it`);
        }

        const values = match
          ? valuesWithMatch(match.field, match.value, match.lookup, input.values)
          : input.values;
        const writes = prepareValues(object, values, 'create');
        creatingWith = match?.field;
        const record = await insertRecord(tx, context, object);
        const fields = await writeFields(tx, context, object, record, writes);
        return {
          id: record.id,
          created: true,
          fields,
          record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
        };
      });
    } catch (error) {
      const lostRace =
        error instanceof UniqueConflictError && creatingWith && error.field.id === creatingWith.id;
      if (lostRace && attempt < 3) continue;
      throw error;
    }
  }
}

export const patchInputSchema = z.strictObject({
  values: valuesSchema,
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});

export async function patchRecord(
  sql: Sql,
  caller: Caller,
  id: string,
  input: z.infer<typeof patchInputSchema>,
): Promise<WriteResponse> {
  return withWrite(sql, caller, async (tx, context) => {
    const record = await lockRecord(tx, caller.workspaceId, id);
    const object = objectOf(context.schema, record);
    const writes = prepareValues(object, input.values, 'update');
    const fields = await writeFields(tx, context, object, record, writes, {
      ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
    });
    return {
      id: record.id,
      created: false,
      fields,
      record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
    };
  });
}

export async function deleteRecord(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<{ id: string; deleted: true; deletedRecordIds: string[] }> {
  return withWrite(sql, caller, async (tx, context) => {
    const deletedRecordIds = await softDeleteRecord(tx, context, id);
    return {
      id: await resolveRecordId(tx, caller.workspaceId, id),
      deleted: true,
      deletedRecordIds,
    };
  });
}

export async function readRecord(sql: Sql, caller: Caller, id: string): Promise<PresentedRecord> {
  return withRead(sql, caller, (tx, schema) => getRecord(tx, caller.workspaceId, schema, id));
}

export async function findRecords(sql: Sql, caller: Caller, objectName: string, input: QueryInput) {
  return withRead(sql, caller, (tx, schema) =>
    queryRecords(tx, caller.workspaceId, schema, requireObject(schema, objectName), input),
  );
}

export async function reviewQueue(sql: Sql, caller: Caller, limit: number): Promise<ReviewQueue> {
  return withRead(sql, caller, (tx, schema) => listReview(tx, caller.workspaceId, schema, limit));
}

export async function decideAssertion(
  sql: Sql,
  caller: Caller,
  assertionId: string,
  decision: 'accept' | 'reject',
): Promise<DecisionResult> {
  return withWrite(sql, caller, (tx, context) =>
    decision === 'accept'
      ? acceptAssertion(tx, context, assertionId)
      : rejectAssertion(tx, context, assertionId),
  );
}
