import type { Actor } from '@retainer/shared';
import type { AssertionStatus, ReviewReason } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import {
  listUnresolvedParticipants,
  lockSource,
  type UnresolvedParticipant,
} from '../memory/interactions.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';
import { getRecord, type PresentedRecord } from './read.js';
import { normalizeFieldValue } from './values.js';
import {
  type FieldWriteStatus,
  lockRecord,
  objectOf,
  type WriteContext,
  writeFields,
} from './write.js';

export type PendingAssertion = {
  id: string;
  recordId: string;
  object: string;
  recordLabel: string | null;
  field: string;
  value: unknown;
  /** The field's current value, which the pending one would replace. */
  currentValue: unknown;
  reason: ReviewReason | null;
  actor: Actor;
  confidence: number;
  sourceInteractionId: string | null;
  observedAt: string;
  createdAt: string;
};

export type MergeSuggestionView = {
  id: string;
  recordIds: [string, string];
  reason: string;
  createdAt: string;
};

export type ReviewQueue = {
  pendingAssertions: PendingAssertion[];
  mergeSuggestions: MergeSuggestionView[];
  /** Participants whose handle belongs only to deleted, unmerged records (1.2). */
  unresolvedParticipants: UnresolvedParticipant[];
};

/**
 * What waits for a person (6.1): pending assertions, suggested merges and
 * participants matching deleted records.
 */
export async function listReview(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  limit: number,
): Promise<ReviewQueue> {
  const rows = await tx<
    {
      id: string;
      record_id: string;
      field_id: string;
      value: unknown;
      review_reason: ReviewReason | null;
      actor: Actor;
      confidence: number;
      source_interaction_id: string | null;
      observed_at: Date;
      created_at: Date;
      object_type_id: string;
      label: string | null;
      data: Record<string, unknown>;
      current_link: string | null;
    }[]
  >`
    select a.id, a.record_id, a.field_id, a.value, a.review_reason, a.actor, a.confidence,
      a.source_interaction_id, a.observed_at, a.created_at, r.object_type_id, r.label, r.data,
      (select l.target_record_id from record_links l
        where l.source_record_id = a.record_id and l.field_id = a.field_id) as current_link
    from field_assertions a
    join records r on r.id = a.record_id and r.deleted_at is null
    where a.workspace_id = ${workspaceId} and a.status = 'pending_review'
    order by a.created_at, a.id
    limit ${limit}`;

  const pendingAssertions: PendingAssertion[] = [];
  for (const row of rows) {
    const object = schema.objectsById.get(row.object_type_id);
    const field = object?.fieldsById.get(row.field_id);
    if (!object || !field || field.status !== 'active') continue;
    pendingAssertions.push({
      id: row.id,
      recordId: row.record_id,
      object: object.name,
      recordLabel: row.label,
      field: field.name,
      value: row.value,
      currentValue: field.type === 'relation' ? row.current_link : (row.data[field.key] ?? null),
      reason: row.review_reason,
      actor: row.actor,
      confidence: row.confidence,
      sourceInteractionId: row.source_interaction_id,
      observedAt: row.observed_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    });
  }

  const suggestions = await tx<
    { id: string; record_a_id: string; record_b_id: string; reason: string; created_at: Date }[]
  >`
    select id, record_a_id, record_b_id, reason, created_at from merge_suggestions
    where workspace_id = ${workspaceId} and status = 'pending'
    order by created_at, id limit ${limit}`;

  return {
    pendingAssertions,
    mergeSuggestions: suggestions.map((s) => ({
      id: s.id,
      recordIds: [s.record_a_id, s.record_b_id],
      reason: s.reason,
      createdAt: s.created_at.toISOString(),
    })),
    unresolvedParticipants: await listUnresolvedParticipants(tx, workspaceId, limit),
  };
}

type PendingRow = {
  id: string;
  record_id: string;
  field_id: string;
  value: unknown;
  status: AssertionStatus;
  source_interaction_id: string | null;
  observed_at: Date;
};

async function loadPending(tx: Tx, workspaceId: string, assertionId: string): Promise<PendingRow> {
  const [row] = await tx<PendingRow[]>`
    select id, record_id, field_id, value, status, source_interaction_id, observed_at
    from field_assertions
    where id = ${assertionId} and workspace_id = ${workspaceId}`;
  if (!row) throw notFound('assertion', { id: assertionId });
  return row;
}

function requireReviewer(actor: Actor): void {
  if (actor.type !== 'user') {
    throw forbidden('only a user can decide pending assertions; an agent cannot approve itself');
  }
}

export type DecisionResult = {
  assertionId: string;
  status: 'accepted' | 'rejected';
  /** For an acceptance: what happened to the re-asserted value. */
  fields?: Record<string, FieldWriteStatus>;
  record: PresentedRecord;
};

/**
 * Accepts a pending assertion (rule 2.3): the value is re-asserted with the
 * reviewing user as actor, keeping its source interaction and `observed_at`,
 * and goes through the normal write path, so a value a person set later
 * still stands. The original is kept, marked superseded. The source is
 * locked before the record, the order retraction uses.
 */
export async function acceptAssertion(
  tx: Tx,
  context: WriteContext,
  assertionId: string,
): Promise<DecisionResult> {
  requireReviewer(context.actor);
  const first = await loadPending(tx, context.workspaceId, assertionId);
  if (first.status !== 'pending_review') {
    throw new AppError(409, 'not_pending', `assertion is ${first.status}, not pending_review`);
  }
  if (first.source_interaction_id) {
    await lockSource(tx, context.workspaceId, first.source_interaction_id);
  }
  const record = await lockRecord(tx, context.workspaceId, first.record_id);
  // Re-read under the record lock, so two reviewers cannot both accept it.
  const pending = await loadPending(tx, context.workspaceId, assertionId);
  if (pending.status !== 'pending_review') {
    throw new AppError(409, 'not_pending', `assertion is ${pending.status}, not pending_review`);
  }
  if (record.id !== pending.record_id) {
    throw new AppError(409, 'record_merged', 'the record was merged; review it again');
  }
  const object = objectOf(context.schema, record);
  const field = object.fieldsById.get(pending.field_id);
  if (field?.status !== 'active') {
    throw new AppError(409, 'field_deleted', 'the field of this assertion was deleted');
  }

  let value: unknown = null;
  if (pending.value !== null) {
    try {
      value = normalizeFieldValue(field, pending.value);
    } catch (error) {
      throw new AppError(
        422,
        'invalid_values',
        `the pending value no longer fits ${field.name}: ${(error as Error).message}`,
      );
    }
  }

  const fields = await writeFields(tx, context, object, record, new Map([[field, value]]), {
    sourceInteractionId: pending.source_interaction_id,
    observedAt: pending.observed_at,
  });
  await tx`
    update field_assertions set status = 'superseded', reviewed_by = ${tx.json(context.actor)},
      reviewed_at = clock_timestamp()
    where id = ${assertionId}`;
  return {
    assertionId,
    status: 'accepted',
    fields,
    record: await getRecord(tx, context.workspaceId, context.schema, record.id),
  };
}

export async function rejectAssertion(
  tx: Tx,
  context: WriteContext,
  assertionId: string,
): Promise<DecisionResult> {
  requireReviewer(context.actor);
  const [row] = await tx<PendingRow[]>`
    select id, record_id, field_id, value, status, source_interaction_id, observed_at
    from field_assertions
    where id = ${assertionId} and workspace_id = ${context.workspaceId}
    for update`;
  if (!row) throw notFound('assertion', { id: assertionId });
  if (row.status !== 'pending_review') {
    throw new AppError(409, 'not_pending', `assertion is ${row.status}, not pending_review`);
  }
  await tx`
    update field_assertions set status = 'rejected', reviewed_by = ${tx.json(context.actor)},
      reviewed_at = clock_timestamp()
    where id = ${assertionId}`;
  return {
    assertionId,
    status: 'rejected',
    record: await getRecord(tx, context.workspaceId, context.schema, row.record_id),
  };
}
