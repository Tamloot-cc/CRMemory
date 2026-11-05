import type { Actor } from '@retainer/shared';
import { RecordId } from '../db/cbor.js';
import { isUuid } from '../db/names.js';
import { AppError, notFound, requireUser } from '../errors.js';
import { lockSource } from '../memory/events.js';
import { normalizeFieldValue } from './values.js';
import {
  type AssertionRow,
  type FieldWriteStatus,
  fromStored,
  lockRecord,
  objectOf,
  planState,
  type StoredAssertion,
  updateAssertion,
  type WriteContext,
  writeFields,
} from './write.js';

/** An assertion as this plan sees it. */
async function loadAssertion(context: WriteContext, assertionId: string): Promise<AssertionRow> {
  const planned = planState(context.op).assertions.get(assertionId);
  if (planned) return planned;
  const [row] = isUuid(assertionId)
    ? await context.op.rows<StoredAssertion>('SELECT * FROM $id;', {
        id: new RecordId('field_assertions', assertionId),
      })
    : [];
  if (!row) throw notFound('assertion', { id: assertionId });
  return fromStored(row);
}

const requireReviewer = (actor: Actor) => requireUser(actor, 'decide pending assertions');

const notPending = (row: AssertionRow) =>
  new AppError(409, 'not_pending', `assertion is ${row.status}, not pending_review`);

/** A decision as the plan returns it; the record is presented after commit. */
export type DecisionResult = {
  assertionId: string;
  status: 'accepted' | 'rejected';
  /** For an acceptance: what happened to the re-asserted value. */
  fields?: Record<string, FieldWriteStatus>;
  recordId: string;
};

/**
 * Accepts a pending assertion (rule 2.3): the value is re-asserted with the
 * reviewing user as actor, keeping its source event and `observed_at`,
 * and goes through the normal write path, so a value a person set later
 * still stands. The original is kept, marked superseded. A concurrent
 * rejection is serialized by the write protocol.
 */
export async function acceptAssertion(
  context: WriteContext,
  assertionId: string,
): Promise<DecisionResult> {
  requireReviewer(context.actor);
  const pending = await loadAssertion(context, assertionId);
  if (pending.status !== 'pending_review') throw notPending(pending);
  if (pending.source) await lockSource(context, pending.source);
  const record = await lockRecord(context, pending.record);
  if (record.id !== pending.record) {
    throw new AppError(409, 'record_merged', 'the record was merged; review it again');
  }
  const object = objectOf(context.schema, record);
  const field = object.fieldsById.get(pending.field_id);
  if (field?.status !== 'active') {
    throw new AppError(409, 'field_deleted', 'the field of this assertion was deleted');
  }

  let value: unknown = null;
  if (pending.value !== null && pending.value !== undefined) {
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

  const fields = await writeFields(context, object, record, new Map([[field, value]]), {
    sourceRecordId: pending.source,
    observedAt: pending.observed_at,
  });
  updateAssertion(context, await loadAssertion(context, assertionId), {
    status: 'superseded',
    reviewed_by: context.actor,
    reviewed_at: context.op.now,
  });
  return { assertionId, status: 'accepted', fields, recordId: record.id };
}

export async function rejectAssertion(
  context: WriteContext,
  assertionId: string,
): Promise<DecisionResult> {
  requireReviewer(context.actor);
  const row = await loadAssertion(context, assertionId);
  if (row.status !== 'pending_review') throw notPending(row);
  updateAssertion(context, row, {
    status: 'rejected',
    reviewed_by: context.actor,
    reviewed_at: context.op.now,
  });
  return { assertionId, status: 'rejected', recordId: row.record };
}
