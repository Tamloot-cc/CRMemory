import type {
  AddedLinks,
  LogEventResult,
  PresentedRecord,
  RetractEventResult,
} from '@retainer/shared';
import type { Backend } from '../db/backend.js';
import { AppError, notFound } from '../errors.js';
import { getRecord } from '../records/read.js';
import { type Caller, eventsAmong, withRead, withWrite } from '../records/service.js';
import { entriesOf, resolveRecordId, softDeleteRecord } from '../records/write.js';
import type { AddLinksInput } from './event-links.js';
import {
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
  retractFact,
} from './facts.js';

/**
 * Memory writes and reads for one caller, shared by REST and MCP so both
 * apply the same validation and rules. Each write is one operation under the
 * write protocol (section 6); results that show a record are presented after
 * it commits.
 */

export async function logEventFor(
  backend: Backend,
  caller: Caller,
  input: LogEventInput,
): Promise<LogEventResult> {
  const { result } = await withWrite<LogEventResult>(
    backend,
    caller,
    { kind: 'log_event', refs: (r) => [r.id] },
    (context) => logEvent(context, input),
  );
  return result;
}

/** One live event: the record with its built-in columns and links. */
export async function readEvent(
  backend: Backend,
  caller: Caller,
  id: string,
): Promise<PresentedRecord> {
  return withRead(backend, caller, async (db, schema) => {
    const record = await getRecord(db, caller.workspaceId, schema, id);
    if (!record.event) throw notFound('event', { id });
    return record;
  });
}

export async function addEventLinksFor(
  backend: Backend,
  caller: Caller,
  id: string,
  input: AddLinksInput,
): Promise<PresentedRecord & { added: AddedLinks }> {
  const { result } = await withWrite(
    backend,
    caller,
    { kind: 'add_event_links', refs: (r: { id: string }) => [r.id] },
    (context) => addEventLinks(context, id, input),
  );
  return { ...(await readEvent(backend, caller, result.id)), added: result.added };
}

/** Removes a participant, or a record from the `about` list; a person only. */
export async function removeEventLinkFor(
  backend: Backend,
  caller: Caller,
  id: string,
  target: { participant: string } | { about: string },
): Promise<PresentedRecord> {
  const { result } = await withWrite(
    backend,
    caller,
    { kind: 'remove_event_link', refs: (r: { id: string }) => [r.id] },
    (context) => removeEventLink(context, id, target),
  );
  return readEvent(backend, caller, result.id);
}

/**
 * Deletes one event through the deletion lifecycle (6.4), with the same
 * permissions as deleting any record. Only an event: other records are
 * deleted with `DELETE /v1/records/:id`.
 */
export async function retractEventFor(
  backend: Backend,
  caller: Caller,
  id: string,
): Promise<RetractEventResult> {
  const { result } = await withWrite<RetractEventResult>(
    backend,
    caller,
    { kind: 'retract_event', refs: (r) => [r.id] },
    async (context) => {
      const canonical = await resolveRecordId(context.op, id);
      const entry = (await entriesOf(context.op, [canonical])).get(canonical);
      const object = entry && context.schema.objectsById.get(entry.object_type_id);
      if (!entry || !object || object.hidden || !object.isEvent) {
        throw notFound('event', { id });
      }
      if (entry.deleted_at) {
        throw new AppError(409, 'event_deleted', `event ${id} is already deleted`, { id });
      }
      const deleted = await softDeleteRecord(context, canonical);
      const retraction = await retractEventClaims(context, await eventsAmong(context, deleted));
      return { id: canonical, deleted: true, ...retraction };
    },
  );
  return result;
}

/**
 * `remember` (6.2). With an idempotency key, the receipt is written in the
 * same transaction as the fact, so a retry, even a concurrent one, returns
 * the original response instead of a second fact and note.
 */
export async function remember(
  backend: Backend,
  caller: Caller,
  recordId: string,
  input: RememberInput,
  idempotencyKey?: string,
): Promise<RememberResult> {
  const { result } = await withWrite<RememberResult>(
    backend,
    caller,
    {
      kind: 'remember',
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      request: {
        record: recordId,
        text: input.text,
        source: input.source ?? null,
        quote: input.quote ?? null,
      },
      refs: (r) => [r.fact.id, r.fact.record],
    },
    (context) => rememberFact(context, recordId, input),
  );
  return result;
}

export async function factsOf(
  backend: Backend,
  caller: Caller,
  recordId: string,
  limit: number,
): Promise<FactList> {
  return withRead(backend, caller, (db, schema) =>
    listFacts(db, caller.workspaceId, schema, recordId, limit),
  );
}

export async function retractFactFor(
  backend: Backend,
  caller: Caller,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const { result } = await withWrite(
    backend,
    caller,
    { kind: 'retract_fact', refs: (r: { id: string }) => [r.id] },
    (context) => retractFact(context.op, id),
  );
  return result;
}
