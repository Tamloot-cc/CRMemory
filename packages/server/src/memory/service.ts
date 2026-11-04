import type {
  AddedLinks,
  LogEventResult,
  PresentedRecord,
  RetractEventResult,
} from '@retainer/shared';
import type { Sql } from '../db/client.js';
import { AppError, notFound } from '../errors.js';
import { claimIdempotencyKey, storeIdempotentResult } from '../idempotency.js';
import { getRecord } from '../records/read.js';
import { type Caller, eventsAmong, withRead, withWrite } from '../records/service.js';
import { softDeleteRecord } from '../records/write.js';
import {
  type AddLinksInput,
  addEventLinks,
  type LogEventInput,
  logEvent,
  removeEventLink,
  retractEventClaims,
} from './events.js';
import {
  type FactList,
  listFacts,
  type RememberInput,
  type RememberResult,
  rememberFact,
  rememberRequestHash,
  retractFact,
} from './facts.js';

/**
 * Memory writes and reads for one caller, shared by REST and MCP so both
 * apply the same validation and rules. Each is one short transaction (4.1).
 */

export async function logEventFor(
  sql: Sql,
  caller: Caller,
  input: LogEventInput,
): Promise<LogEventResult> {
  return withWrite(sql, caller, (tx, context) => logEvent(tx, context, input));
}

/** One live event: the record with its built-in columns and links. */
export async function readEvent(sql: Sql, caller: Caller, id: string): Promise<PresentedRecord> {
  return withRead(sql, caller, async (tx, schema) => {
    const record = await getRecord(tx, caller.workspaceId, schema, id);
    if (!record.event) throw notFound('event', { id });
    return record;
  });
}

export async function addEventLinksFor(
  sql: Sql,
  caller: Caller,
  id: string,
  input: AddLinksInput,
): Promise<PresentedRecord & { added: AddedLinks }> {
  return withWrite(sql, caller, (tx, context) => addEventLinks(tx, context, id, input));
}

/** Removes a participant, or a record from the `about` list; a person only. */
export async function removeEventLinkFor(
  sql: Sql,
  caller: Caller,
  id: string,
  target: { participant: string } | { about: string },
): Promise<PresentedRecord> {
  return withWrite(sql, caller, (tx, context) => removeEventLink(tx, context, id, target));
}

/**
 * Deletes one event through the deletion lifecycle (6.4), with the same
 * permissions as deleting any record. Only an event: other records are
 * deleted with `DELETE /v1/records/:id`.
 */
export async function retractEventFor(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<RetractEventResult> {
  return withWrite(sql, caller, async (tx, context) => {
    const record = await getRecord(tx, caller.workspaceId, context.schema, id).catch((error) => {
      if (error instanceof AppError && error.code === 'record_deleted') {
        throw new AppError(409, 'event_deleted', `event ${id} is already deleted`, { id });
      }
      throw error;
    });
    if (!record.event) throw notFound('event', { id });
    const deleted = await softDeleteRecord(tx, context, record.id);
    const retraction = await retractEventClaims(
      tx,
      context,
      await eventsAmong(tx, context.schema, deleted),
    );
    return { id: record.id, deleted: true, ...retraction };
  });
}

/**
 * `remember` (6.2). With an idempotency key, the key is claimed in the same
 * transaction as the fact, so a retry, even a concurrent one, returns the
 * original response instead of a second fact and note.
 */
export async function remember(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: RememberInput,
  idempotencyKey?: string,
): Promise<RememberResult> {
  return withWrite(sql, caller, async (tx, context) => {
    let claimId: string | undefined;
    if (idempotencyKey !== undefined) {
      const claim = await claimIdempotencyKey(
        tx,
        caller.workspaceId,
        'remember',
        idempotencyKey,
        rememberRequestHash(recordId, input),
      );
      if (claim.kind === 'replay') return claim.result as RememberResult;
      claimId = claim.id;
    }
    const result = await rememberFact(tx, context, recordId, input);
    if (claimId) await storeIdempotentResult(tx, claimId, result);
    return result;
  });
}

export async function factsOf(
  sql: Sql,
  caller: Caller,
  recordId: string,
  limit: number,
): Promise<FactList> {
  return withRead(sql, caller, (tx, schema) =>
    listFacts(tx, caller.workspaceId, schema, recordId, limit),
  );
}

export async function retractFactFor(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<{ id: string; deleted: true }> {
  return withWrite(sql, caller, (tx) => retractFact(tx, caller.workspaceId, id));
}
