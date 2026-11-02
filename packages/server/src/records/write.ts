import type { Actor, ActorType } from '@retainer/shared';
import type { AssertionStatus, ReviewReason } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { identifiersFor, searchTextOf } from './derive.js';
import { searchVector } from './search-sql.js';
import { pickWinner, type RankedAssertion, reviewReason } from './winner.js';

/** Everything a write needs: who, where, and the schema it validated against. */
export type WriteContext = {
  workspaceId: string;
  actor: Actor;
  schema: CompiledSchema;
  /** Agent assertions below this confidence wait for review (rule 2.3). */
  confidenceThreshold: number;
};

export type WriteOptions = {
  /** The interaction the values come from; kept as provenance. */
  sourceInteractionId?: string | null;
  /**
   * When the claim was true at the source: the cited interaction's
   * `occurred_at`. Without it, the server's clock at write time (rule 2.2).
   */
  observedAt?: Date | null;
  /** 0..1; direct writes are 1. */
  confidence?: number;
  /** Rejects the write if the record changed since (rule 2.5). */
  expectedUpdatedAt?: string;
};

/** What happened to each written field (6.2). */
export type FieldWriteStatus = 'applied' | 'pending_review' | 'superseded';

export type LockedRecord = {
  id: string;
  object_type_id: string;
  data: Record<string, unknown>;
  updated_at: Date;
  deleted_at: Date | null;
  merged_into_id: string | null;
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
      { field: field.name, value, recordId, candidates: [recordId] },
    );
  }
}

type AssertionRow = {
  id: string;
  field_id: string;
  value: unknown;
  actor: Actor;
  status: AssertionStatus;
  observed_at: Date;
  created_at: Date;
};

const toRanked = (row: AssertionRow): RankedAssertion => ({
  id: row.id,
  actorType: row.actor.type,
  observedAt: row.observed_at,
  createdAt: row.created_at,
  status: row.status,
  value: row.value,
});

/** Fields whose values become rows in `record_identifiers`. */
const hasIdentifiers = (field: FieldState) =>
  field.isUnique || field.type === 'emails' || field.type === 'phones' || field.type === 'links';

/** Follows `merged_into_id` to the surviving record (4.2). */
export async function resolveRecordId(tx: Tx, workspaceId: string, id: string): Promise<string> {
  let current = id;
  for (let hops = 0; hops < 16; hops++) {
    const [row] = await tx<{ merged_into_id: string | null }[]>`
      select merged_into_id from records where id = ${current} and workspace_id = ${workspaceId}`;
    if (!row) throw notFound('record', { id });
    if (!row.merged_into_id) return current;
    current = row.merged_into_id;
  }
  throw new AppError(409, 'merge_cycle', `record ${id} has a merge chain that does not end`);
}

/**
 * Locks a live record for writing (rule 2.5). A merged ID resolves to the
 * surviving record; a deleted record cannot be written.
 */
export async function lockRecord(tx: Tx, workspaceId: string, id: string): Promise<LockedRecord> {
  const canonical = await resolveRecordId(tx, workspaceId, id);
  const [row] = await tx<LockedRecord[]>`
    select id, object_type_id, data, updated_at, deleted_at, merged_into_id from records
    where id = ${canonical} and workspace_id = ${workspaceId}
    for update`;
  if (!row) throw notFound('record', { id });
  if (row.merged_into_id) return lockRecord(tx, workspaceId, row.merged_into_id);
  if (row.deleted_at) {
    throw new AppError(409, 'record_deleted', `record ${canonical} is deleted`, {
      recordId: canonical,
    });
  }
  return row;
}

export function objectOf(
  schema: CompiledSchema,
  record: { object_type_id: string },
): CompiledObject {
  const object = schema.objectsById.get(record.object_type_id);
  if (object?.state.status !== 'active') {
    throw new AppError(409, 'object_deleted', 'the object of this record was deleted');
  }
  return object;
}

/** Relation values must point at a live record of the target object, in this workspace. */
async function checkRelationTargets(
  tx: Tx,
  context: WriteContext,
  object: CompiledObject,
  writes: Map<FieldState, unknown>,
): Promise<void> {
  const relations = [...writes].filter(
    (entry): entry is [FieldState, string] => entry[0].type === 'relation' && entry[1] !== null,
  );
  if (relations.length === 0) return;
  const rows = await tx<{ id: string; object_type_id: string; deleted_at: Date | null }[]>`
    select id, object_type_id, deleted_at from records
    where workspace_id = ${context.workspaceId} and id = any(${relations.map(([, id]) => id)}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const errors = [];
  for (const [field, targetId] of relations) {
    const target = byId.get(targetId);
    const targetObject = context.schema.objectsByUniversalId.get(
      field.settings.targetObjectId ?? '',
    );
    if (!target || target.deleted_at) {
      errors.push({ field: field.name, message: `no live record ${targetId}` });
    } else if (target.object_type_id !== targetObject?.id) {
      errors.push({
        field: field.name,
        message: `record ${targetId} is not a ${targetObject?.name ?? 'valid target'}`,
      });
    }
  }
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_values', `invalid values for ${object.name}`, { errors });
  }
}

/**
 * The write path (rules 2.2–2.5). With the record row locked: insert one
 * assertion per field, recompute only the touched fields' winners, then
 * update `data`, `record_links`, `record_identifiers`, label and search in
 * the same transaction.
 */
export async function writeFields(
  tx: Tx,
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
  await checkRelationTargets(tx, context, object, writes);

  const fields = [...writes.keys()];
  const fieldIds = fields.map((f) => f.id as string);
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  const observedAt = options.observedAt ?? (clock?.now as Date);
  const confidence = options.confidence ?? 1;
  const actorType: ActorType = context.actor.type;

  const existing = await tx<AssertionRow[]>`
    select id, field_id, value, actor, status, observed_at, created_at from field_assertions
    where record_id = ${record.id} and field_id = any(${fieldIds}::uuid[])
      and status in ('active', 'superseded')`;

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

    const [inserted] = await tx<AssertionRow[]>`
      insert into field_assertions (workspace_id, record_id, field_id, value, actor,
        source_interaction_id, confidence, status, review_reason, observed_at, created_at)
      values (${context.workspaceId}, ${record.id}, ${field.id as string},
        ${value === null ? null : tx.json(value as never)}, ${tx.json(context.actor)},
        ${options.sourceInteractionId ?? null}, ${confidence},
        ${reason ? 'pending_review' : 'active'}, ${reason}, ${observedAt}, clock_timestamp())
      returning id, field_id, value, actor, status, observed_at, created_at`;
    const assertion = inserted as AssertionRow;

    if (reason) {
      statuses[field.name] = 'pending_review';
      continue;
    }

    const candidates = [...current, assertion];
    const winner = candidates.find((a) => a.id === pickWinner(candidates.map(toRanked))?.id);
    const winnerId = winner?.id as string;
    await tx`update field_assertions set status = 'active'
      where id = ${winnerId} and status <> 'active'`;
    await tx`update field_assertions set status = 'superseded'
      where record_id = ${record.id} and field_id = ${field.id as string}
        and status = 'active' and id <> ${winnerId}`;
    statuses[field.name] = winnerId === assertion.id ? 'applied' : 'superseded';
    winners.set(field, winner);
  }

  if (winners.size === 0) return statuses;

  // records.data, record_links and record_identifiers follow the winners.
  const data = { ...record.data };
  for (const [field, winner] of winners) {
    if (field.type === 'relation') {
      await tx`delete from record_links where source_record_id = ${record.id}
        and field_id = ${field.id as string}`;
      if (winner?.value) {
        await tx`
          insert into record_links (workspace_id, field_id, source_record_id, target_record_id,
            created_by)
          values (${context.workspaceId}, ${field.id as string}, ${record.id},
            ${winner.value as string}, ${tx.json(context.actor)})`;
      }
      continue;
    }
    if (winner) data[field.key] = winner.value;
    else delete data[field.key];

    if (hasIdentifiers(field)) {
      await replaceIdentifiers(tx, context.workspaceId, record.id, field, winner?.value ?? null);
    }
  }

  const { label, body } = searchTextOf(object.state.fields, object.labelField, data);
  const [updated] = await tx<{ updated_at: Date }[]>`
    update records set data = ${tx.json(data as never)}, label = ${label},
      search = ${searchVector(tx, label, body)}, updated_at = clock_timestamp(),
      updated_by = ${tx.json(context.actor)}
    where id = ${record.id}
    returning updated_at`;
  record.data = data;
  record.updated_at = updated?.updated_at ?? record.updated_at;
  return statuses;
}

/**
 * Replaces a field's identifier rows with those of its new winning value.
 * A claim another record already holds fails the whole write with the
 * holder's ID; ON CONFLICT waits for a concurrent claimer to commit or roll
 * back first, so the loser of a race sees the winner.
 */
async function replaceIdentifiers(
  tx: Tx,
  workspaceId: string,
  recordId: string,
  field: FieldState,
  value: unknown,
): Promise<void> {
  const fieldId = field.id as string;
  await tx`delete from record_identifiers where record_id = ${recordId} and field_id = ${fieldId}`;
  for (const identifier of identifiersFor(field, value)) {
    if (!field.isUnique) {
      await tx`
        insert into record_identifiers (workspace_id, record_id, field_id, kind, value, is_claim)
        values (${workspaceId}, ${recordId}, ${fieldId}, ${identifier.kind}, ${identifier.value},
          false)`;
      continue;
    }
    const claimed = await tx`
      insert into record_identifiers (workspace_id, record_id, field_id, kind, value, is_claim)
      values (${workspaceId}, ${recordId}, ${fieldId}, ${identifier.kind}, ${identifier.value}, true)
      on conflict (workspace_id, field_id, value) where is_claim do nothing
      returning id`;
    if (claimed.length === 0) {
      const [holder] = await tx<{ record_id: string }[]>`
        select record_id from record_identifiers
        where workspace_id = ${workspaceId} and field_id = ${fieldId}
          and value = ${identifier.value} and is_claim`;
      throw new UniqueConflictError(field, identifier.value, holder?.record_id ?? 'unknown');
    }
  }
}

/** Inserts an empty record row; the caller writes its values with `writeFields`. */
export async function insertRecord(
  tx: Tx,
  context: WriteContext,
  object: CompiledObject,
): Promise<LockedRecord> {
  const [row] = await tx<LockedRecord[]>`
    insert into records (workspace_id, object_type_id, created_by, updated_by)
    values (${context.workspaceId}, ${object.id}, ${tx.json(context.actor)},
      ${tx.json(context.actor)})
    returning id, object_type_id, data, updated_at, deleted_at, merged_into_id`;
  return row as LockedRecord;
}

/**
 * Recomputes a record's values from its assertions alone (rule 2.4). Used
 * to prove `records.data` is a cache, and to rebuild it.
 */
export async function computeDataFromAssertions(
  tx: Tx,
  object: CompiledObject,
  recordId: string,
): Promise<Record<string, unknown>> {
  const rows = await tx<AssertionRow[]>`
    select id, field_id, value, actor, status, observed_at, created_at from field_assertions
    where record_id = ${recordId} and status in ('active', 'superseded')`;
  const data: Record<string, unknown> = {};
  for (const field of object.state.fields) {
    if (field.type === 'relation') continue;
    const winner = pickWinner(rows.filter((r) => r.field_id === field.id).map(toRanked));
    if (winner) data[field.key] = winner.value;
  }
  return data;
}

/**
 * Soft-deletes a record (2.1). Relations to it with `onDelete: cascade`
 * soft-delete their source records too; `set_null` relations simply stop
 * resolving, since reads skip deleted targets. All affected records are
 * locked in sorted ID order (rule 2.5). Uniqueness claims stay, so writes
 * cannot silently recreate the record.
 */
export async function softDeleteRecord(
  tx: Tx,
  context: WriteContext,
  id: string,
): Promise<string[]> {
  const rootId = await resolveRecordId(tx, context.workspaceId, id);
  const cascadeFieldIds = context.schema.state.objects.flatMap((o) =>
    o.fields
      .filter((f) => f.status === 'active' && f.settings.onDelete === 'cascade')
      .map((f) => f.id as string),
  );

  // Collect first, then lock everything in sorted order.
  const ids = new Set([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0 && cascadeFieldIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      select distinct l.source_record_id as id from record_links l
      join records r on r.id = l.source_record_id and r.deleted_at is null
      where l.target_record_id = any(${frontier}::uuid[])
        and l.field_id = any(${cascadeFieldIds}::uuid[])`;
    frontier = rows.map((r) => r.id).filter((rid) => !ids.has(rid));
    for (const rid of frontier) ids.add(rid);
  }

  const sorted = [...ids].sort();
  const locked = await tx<{ id: string; deleted_at: Date | null }[]>`
    select id, deleted_at from records where id = any(${sorted}::uuid[]) order by id for update`;
  if (locked.find((r) => r.id === rootId)?.deleted_at) {
    throw new AppError(409, 'record_deleted', `record ${rootId} is already deleted`, {
      recordId: rootId,
    });
  }
  await tx`
    update records set deleted_at = clock_timestamp(), updated_at = clock_timestamp(),
      updated_by = ${tx.json(context.actor)}
    where id = any(${sorted}::uuid[]) and deleted_at is null`;
  return sorted;
}
