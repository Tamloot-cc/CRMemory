import type {
  AddedLinks,
  AttachedEvent,
  EventAttachment,
  EventRetraction,
  LogEventResult,
  PresentedRecord,
  Via,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import { after, page } from '../db/pagination.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound, requireUser } from '../errors.js';
import { isEventIdentitySuppressed } from '../privacy/suppression.js';
import { getRecord, presentRecords, RECORD_COLUMNS, type RecordRow } from '../records/read.js';
import { normalizeFieldValue, prepareValues } from '../records/values.js';
import { sameValue } from '../records/winner.js';
import {
  insertRecord,
  lockRecordsForUpdate,
  type RemovedClaim,
  releaseAndRecompute,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import {
  type AddLinksInput,
  addLinks,
  linksInputSchema,
  loadLinks,
  lockLinkTargets,
  normalizeParticipants,
  presentLinks,
} from './event-links.js';

/**
 * Events (1.3, 4.1): records of an event type, for something that happened.
 * Only logging creates them: `log_event` writes the record, its built-in
 * columns, its initial field values and its links in one transaction. Edits
 * later are ordinary assertions; deleting an event retracts what cites it.
 */

/** How far past the server's clock `occurredAt` may be, for clock skew. */
const FUTURE_SKEW = '10 minutes';

/**
 * The channel of the internal notes `remember` creates for uncited facts
 * (6.4). Public logging rejects it, so no logged event can pass for one.
 */
export const NOTE_CHANNEL = 'retainer';

export const logEventInputSchema = z
  .strictObject({
    type: z.string().trim().min(1).max(100),
    channel: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((channel) => channel !== NOTE_CHANNEL, {
        message: `channel "${NOTE_CHANNEL}" is reserved for the notes remember creates`,
      }),
    externalId: z.string().min(1).max(500).optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    title: z.string().max(500).optional(),
    summary: z.string().max(20_000).optional(),
    fields: z.record(z.string(), z.unknown()).default({}),
  })
  .extend(linksInputSchema.shape);
export type LogEventInput = z.infer<typeof logEventInputSchema>;

export type { AddLinksInput } from './event-links.js';
export { addLinksInputSchema } from './event-links.js';

/** An event type by API name; entities and the hidden note type are refused. */
export function requireEventType(schema: CompiledSchema, name: string): CompiledObject {
  const types = [...schema.objectsByName.values()].filter((o) => o.isEvent);
  const object =
    schema.objectsByName.get(name) ??
    [...schema.objectsByName.values()].find((o) => o.state.namePlural === name);
  if (!object) {
    throw notFound(`event type "${name}"`, { eventTypes: types.map((o) => o.name) });
  }
  if (!object.isEvent) {
    throw new AppError(
      422,
      'not_an_event_type',
      `${object.name} is an entity, not an event type; log events of: ` +
        types.map((o) => o.name).join(', '),
      { eventTypes: types.map((o) => o.name) },
    );
  }
  return object;
}

/** The event type's core fields; every event type has them (6.1). */
function coreOf(object: CompiledObject) {
  if (!object.core) throw new AppError(500, 'internal', `${object.name} has no core fields`);
  return object.core;
}

/**
 * The values `log_event` writes as the event's initial assertions: the core
 * title and summary from the top level, and the other fields from `fields`.
 * Empty text is no value.
 */
function initialValues(object: CompiledObject, input: LogEventInput): Map<FieldState, unknown> {
  const core = coreOf(object);
  const coreNames = [core.title.name, core.summary.name];
  const misplaced = Object.keys(input.fields).filter((name) => coreNames.includes(name));
  if (misplaced.length > 0) {
    throw new AppError(422, 'invalid_values', `pass title and summary at the top level`, {
      errors: misplaced.map((field) => ({
        field,
        message: 'is a core field: pass it as title or summary, not in fields',
      })),
    });
  }
  const values = prepareValues(object, input.fields, 'create');
  for (const [field, text] of [
    [core.title, input.title],
    [core.summary, input.summary],
  ] as const) {
    if (text !== undefined && text !== '') values.set(field, normalizeFieldValue(field, text));
  }
  for (const [field, value] of values) if (value === null) values.delete(field);
  return values;
}

/** Advisory-lock class for event identities (6.2, 6.4). */
const IDENTITY_LOCK_CLASS = 0x5245; // "RE"

/**
 * Serializes everything that touches one event identity in a workspace:
 * concurrent logs of it, and a log racing the erasure that tombstones it.
 */
async function lockEventIdentity(
  tx: Tx,
  workspaceId: string,
  channel: string,
  externalId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(${IDENTITY_LOCK_CLASS}::int4,
    hashtext(${JSON.stringify([workspaceId, channel, externalId])}))`;
}

/**
 * Logs an event (4.1). Logging the same `(channel, externalId)` again with
 * the same type, time and initial values returns the existing event with
 * `created: false`, after adding any participants and `about` records it did
 * not have yet (1.3). A different payload is `event_conflict`; an identity
 * whose event was deleted or erased is `event_retracted`. Without an
 * external ID there is no source deduplication.
 */
export async function logEvent(
  tx: Tx,
  context: WriteContext,
  input: LogEventInput,
): Promise<LogEventResult> {
  const { workspaceId, schema } = context;
  const object = requireEventType(schema, input.type);
  const participants = normalizeParticipants(input.participants);
  const values = initialValues(object, input);
  const occurredAt = new Date(input.occurredAt);
  const [check] = await tx<{ future: boolean }[]>`
    select ${occurredAt}::timestamptz > clock_timestamp() + ${FUTURE_SKEW}::interval as future`;
  if (check?.future) {
    throw new AppError(
      422,
      'invalid_occurred_at',
      'occurredAt is in the future; log events that already happened, with their UTC offset',
      { occurredAt: input.occurredAt },
    );
  }

  if (input.externalId !== undefined) {
    await lockEventIdentity(tx, workspaceId, input.channel, input.externalId);
    if (await isEventIdentitySuppressed(tx, workspaceId, input.channel, input.externalId)) {
      throw retracted(null);
    }
    const [existing] = await tx<
      { record_id: string; object_type_id: string; deleted_at: Date | null; occurred_at: Date }[]
    >`
      select e.record_id, r.object_type_id, r.deleted_at, e.occurred_at
      from event_records e join records r on r.id = e.record_id
      where e.workspace_id = ${workspaceId} and e.channel = ${input.channel}
        and e.external_id = ${input.externalId}`;
    if (existing) {
      if (existing.deleted_at) throw retracted(existing.record_id);
      await tx`select id from records where id = ${existing.record_id} for no key update`;
      await checkSameEvent(tx, context, existing, object, occurredAt, values);
      const stored = await loadLinks(tx, workspaceId, existing.record_id);
      const { rows, inserted } = await addLinks(
        tx,
        workspaceId,
        schema,
        existing.record_id,
        stored,
        { participants, about: input.about },
      );
      const links = await presentLinks(tx, workspaceId, schema, rows, inserted);
      return {
        id: existing.record_id,
        type: object.name,
        created: false,
        participants: links.participants,
        about: links.about,
        added: links.added,
      };
    }
  }

  const record = await insertRecord(tx, context, object);
  await tx`
    insert into event_records (workspace_id, record_id, occurred_at, channel, external_id)
    values (${workspaceId}, ${record.id}, ${occurredAt}, ${input.channel},
      ${input.externalId ?? null})`;
  // The initial values cite the event itself and were true when it happened.
  await writeFields(tx, context, object, record, values, {
    sourceRecordId: record.id,
    observedAt: occurredAt,
    isInitial: true,
  });
  const { rows } = await addLinks(tx, workspaceId, schema, record.id, [], {
    participants,
    about: input.about,
  });
  const links = await presentLinks(tx, workspaceId, schema, rows);
  return {
    id: record.id,
    type: object.name,
    created: true,
    participants: links.participants,
    about: links.about,
  };
}

function retracted(id: string | null): AppError {
  return new AppError(
    409,
    'event_retracted',
    `${id ? `event ${id}` : 'an event'} with this channel and externalId was deleted; ` +
      'log an edited source with a new externalId',
    id ? { id } : {},
  );
}

/**
 * Checks a re-logged event against the one stored under its identity (6.2):
 * the same type and occurrence time, and the same values as its initial
 * assertions, field by field. Later edits do not count: retries compare
 * with what was first logged. A field added since is absent from the
 * original, so a retry that supplies it conflicts; a field deleted since is
 * not compared. Relation values are compared after following merges on
 * both sides, so a retry using the original or the surviving IDs matches.
 */
async function checkSameEvent(
  tx: Tx,
  context: WriteContext,
  existing: { record_id: string; object_type_id: string; occurred_at: Date },
  object: CompiledObject,
  occurredAt: Date,
  values: Map<FieldState, unknown>,
): Promise<void> {
  const conflict = (what: string) =>
    new AppError(
      409,
      'event_conflict',
      `event ${existing.record_id} was already logged with this channel and externalId and a ` +
        `different ${what}. Participants and about records may differ: logging it again adds ` +
        'the new ones. An edited source needs a new externalId; a person can delete the old ' +
        'event if it is wrong',
      { id: existing.record_id },
    );
  if (existing.object_type_id !== object.id) throw conflict('type');
  if (existing.occurred_at.getTime() !== occurredAt.getTime()) throw conflict('occurredAt');

  const initial = await tx<{ field_id: string; value: unknown }[]>`
    select field_id, value from field_assertions
    where workspace_id = ${context.workspaceId} and record_id = ${existing.record_id}
      and is_initial`;
  const original = new Map(initial.map((row) => [row.field_id, row.value]));
  const fields = object.activeFields.filter(
    (f) => f.settings.relationCardinality !== 'one_to_many',
  );

  // Relation values on both sides, resolved to their survivors in one read.
  const relationIds = fields
    .filter((f) => f.type === 'relation')
    .flatMap((f) => [values.get(f), original.get(f.id as string)])
    .flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? (v as string[]) : []));
  const survivors = await canonicalRecordsAll(tx, context, relationIds);
  const resolve = (field: FieldState, value: unknown) => {
    if (field.type !== 'relation' || value === undefined || value === null) return value;
    if (Array.isArray(value)) {
      return [...new Set(value.map((id) => survivors.get(id as string) ?? id))].sort();
    }
    return survivors.get(value as string) ?? value;
  };

  for (const field of fields) {
    const incoming = resolve(field, values.get(field));
    const stored = resolve(field, original.get(field.id as string));
    const absent = (v: unknown) => v === undefined || v === null;
    if (absent(incoming) && absent(stored)) continue;
    if (absent(incoming) || absent(stored) || !sameValue(incoming, stored)) {
      throw conflict(field.coreRole ?? field.name);
    }
  }
}

/** Survivors of record IDs after merges, including deleted and hidden records. */
async function canonicalRecordsAll(
  tx: Tx,
  context: WriteContext,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<{ start_id: string; id: string }[]>`
    with recursive chain (start_id, id, merged_into_id, hops) as (
      select r.id, r.id, r.merged_into_id, 0 from records r
      where r.workspace_id = ${context.workspaceId} and r.id = any(${[...ids]}::uuid[])
      union all
      select c.start_id, r.id, r.merged_into_id, c.hops + 1 from chain c
      join records r on r.id = c.merged_into_id and r.workspace_id = ${context.workspaceId}
      where c.hops < 16
    )
    select start_id, id from chain where merged_into_id is null`;
  return new Map(rows.map((r) => [r.start_id, r.id]));
}

/** A live, visible event record, locked for a change to its links. */
async function lockEvent(tx: Tx, context: WriteContext, id: string): Promise<{ id: string }> {
  const [row] = await tx<{ id: string; object_type_id: string; deleted_at: Date | null }[]>`
    select r.id, r.object_type_id, r.deleted_at from records r
    where r.id = ${id} and r.workspace_id = ${context.workspaceId}
    for no key update`;
  const object = row && context.schema.objectsById.get(row.object_type_id);
  if (!row || !object || object.hidden || object.state.status !== 'active' || !object.isEvent) {
    throw notFound('event', { id });
  }
  if (row.deleted_at) {
    throw new AppError(404, 'record_deleted', `event ${id} was deleted`, { recordId: id });
  }
  return row;
}

/**
 * Adds participants and `about` records to a logged event, with the same
 * matching as `logEvent` (1.3). Idempotent: links it already has are not
 * added again.
 */
export async function addEventLinks(
  tx: Tx,
  context: WriteContext,
  id: string,
  input: AddLinksInput,
): Promise<PresentedRecord & { added: AddedLinks }> {
  const participants = normalizeParticipants(input.participants);
  await lockEvent(tx, context, id);
  const stored = await loadLinks(tx, context.workspaceId, id);
  const { inserted, rows } = await addLinks(tx, context.workspaceId, context.schema, id, stored, {
    participants,
    about: input.about,
  });
  const links = await presentLinks(tx, context.workspaceId, context.schema, rows, inserted);
  return {
    ...(await getRecord(tx, context.workspaceId, context.schema, id)),
    added: links.added,
  };
}

/**
 * Removes one participant, or one record from the `about` list, from an
 * event (1.3). Only a person removes links: what an agent logged stays
 * until someone decides otherwise.
 */
export async function removeEventLink(
  tx: Tx,
  context: WriteContext,
  id: string,
  target: { participant: string } | { about: string },
): Promise<PresentedRecord> {
  requireUser(context.actor, 'remove a participant or an about record');
  await lockEvent(tx, context, id);
  // The about record is locked and followed through merges, as in addLinks,
  // so a merge cannot move its link to the survivor before the delete runs.
  const match =
    'participant' in target
      ? tx`link = 'participant' and id = ${target.participant}`
      : tx`link = 'about' and record_id = ${
          (await lockLinkTargets(tx, context.workspaceId, context.schema, [target.about])).get(
            target.about,
          )?.id ?? target.about
        }`;
  const [removed] = await tx<{ id: string }[]>`
    delete from event_links
    where workspace_id = ${context.workspaceId} and event_id = ${id} and ${match}
    returning id`;
  if (!removed) {
    throw 'participant' in target
      ? notFound('participant', { id: target.participant, event: id })
      : notFound('about record', { id: target.about, event: id });
  }
  return getRecord(tx, context.workspaceId, context.schema, id);
}

/** A live event cited as a source, and when it happened (rules 2.1, 2.2). */
export type CitedSource = { id: string; occurredAt: Date };

/**
 * Locks a cited event `FOR KEY SHARE` for the rest of the transaction.
 * Deleting an event locks it `FOR UPDATE`, so a write citing it either
 * commits before the deletion (which then retracts its claims) or sees it
 * deleted. Take this before any record lock. Only a live event record of a
 * visible type in this workspace can be a source: an entity record, the
 * hidden internal notes and other workspaces' records cannot.
 */
export async function lockSource(
  tx: Tx,
  context: Pick<WriteContext, 'workspaceId' | 'schema'>,
  recordId: string,
): Promise<CitedSource> {
  const [row] = await tx<
    {
      id: string;
      object_type_id: string;
      deleted_at: Date | null;
      occurred_at: Date | null;
    }[]
  >`
    select r.id, r.object_type_id, r.deleted_at, e.occurred_at from records r
    left join event_records e on e.record_id = r.id
    where r.id = ${recordId} and r.workspace_id = ${context.workspaceId}
    for key share of r`;
  const object = row && context.schema.objectsById.get(row.object_type_id);
  if (!row || !object || object.hidden || !row.occurred_at) {
    throw new AppError(
      422,
      'invalid_source',
      row && object && !object.isEvent
        ? `source ${recordId} is a ${object.name}, not an event; a source is an event record: ` +
            'log it with log_event first and pass the id it returns'
        : `source ${recordId} is not an event in this workspace; log it with log_event first ` +
            'and pass the id it returns',
      { source: recordId },
    );
  }
  if (row.deleted_at) {
    throw new AppError(409, 'source_retracted', `source event ${row.id} was deleted`, {
      source: row.id,
    });
  }
  return { id: row.id, occurredAt: row.occurred_at };
}

/**
 * The deletion lifecycle of events (6.4), after they are soft-deleted and
 * locked `FOR UPDATE`: every field assertion on other records that cites
 * one of them becomes `retracted`, the fields where one was winning are
 * recomputed, and facts left with no live source are hidden on read. A
 * retracted assertion is never eligible again, so an older superseded claim
 * from the same source cannot win either (rule 2.4). The events' own
 * initial values stay with them.
 */
export async function retractEventClaims(
  tx: Tx,
  context: WriteContext,
  eventIds: readonly string[],
): Promise<EventRetraction> {
  if (eventIds.length === 0) {
    return { retractedAssertions: 0, recomputedRecordIds: [], hiddenFactIds: [] };
  }
  const ids = [...eventIds];
  // No new claim can cite the events now: writers lock their source first.
  const affected = await tx<{ record_id: string }[]>`
    select distinct record_id from field_assertions
    where workspace_id = ${context.workspaceId} and source_record_id = any(${ids}::uuid[])
      and record_id <> all(${ids}::uuid[])
      and status in ('active', 'superseded', 'pending_review')`;
  const locked = await lockRecordsForUpdate(
    tx,
    context.workspaceId,
    affected.map((a) => a.record_id),
  );
  const retracted = await tx<RemovedClaim[]>`
    with target as (
      select id, record_id, field_id, status from field_assertions
      where workspace_id = ${context.workspaceId} and source_record_id = any(${ids}::uuid[])
        and record_id <> all(${ids}::uuid[])
        and status in ('active', 'superseded', 'pending_review')
    )
    update field_assertions a set status = 'retracted'
    from target t where a.id = t.id
    returning t.record_id, t.field_id, t.status`;
  // A claim from these very events on a record later in the order must not
  // block another record's previous value from coming back.
  const recomputed = await releaseAndRecompute(tx, context, locked, retracted);
  const hidden = await tx<{ id: string }[]>`
    select distinct f.id from facts f
    join fact_sources s on s.fact_id = f.id and s.source_record_id = any(${ids}::uuid[])
    where f.workspace_id = ${context.workspaceId} and f.deleted_at is null
      and not exists (${liveFactSource(tx, tx`f.id`)})
    order by f.id`;
  return {
    retractedAssertions: retracted.length,
    recomputedRecordIds: recomputed,
    hiddenFactIds: hidden.map((f) => f.id),
  };
}

/** `select … from` a fact's live sources: events not deleted (2.1). */
export function liveFactSource(tx: Tx, factId: Fragment): Fragment {
  return tx`select 1 from fact_sources s
    join records src on src.id = s.source_record_id and src.deleted_at is null
    where s.fact_id = ${factId}`;
}

/** The precedence of attachment kinds (7.1): a lower rank wins. */
const VIA_RANK = { participant: 1, about: 2, field: 3 } as const;

/**
 * Events directly attached to a record (6.3, 7.1): it took part, the event
 * is about it, or one of the event's own relation fields points at it. One
 * row per event, with the attachment that wins by precedence; among several
 * relation fields, the one with the smallest field ID. Live events of
 * visible types only, never internal notes.
 */
export function directAttachments(
  tx: Tx,
  schema: CompiledSchema,
  workspaceId: string,
  record: string | Fragment,
  link?: EventAttachment,
): Fragment {
  const recordId = typeof record === 'string' ? tx`${record}::uuid` : record;
  const fieldIds = activeRelationFieldIds(schema);
  const want = (kind: EventAttachment) => !link || link === kind;
  const parts: Fragment[] = [];
  if (want('participant') || want('about')) {
    const kinds = (['participant', 'about'] as const).filter(want);
    parts.push(tx`
      select l.event_id, min(case l.link when 'participant' then ${VIA_RANK.participant}::int
          else ${VIA_RANK.about}::int end) as rank, null::uuid as field_id
      from event_links l
      where l.workspace_id = ${workspaceId} and l.record_id = ${recordId}
        and l.link = any(${kinds as unknown as string[]}::text[])
      group by l.event_id`);
  }
  if (want('field')) {
    parts.push(tx`
      select l.source_record_id as event_id, ${VIA_RANK.field}::int as rank,
        min(l.field_id::text)::uuid as field_id
      from record_links l
      where l.workspace_id = ${workspaceId} and l.target_record_id = ${recordId}
        and l.field_id = any(${fieldIds}::uuid[])
      group by l.source_record_id`);
  }
  const union = parts.reduce((a, b) => tx`${a} union all ${b}`);
  return tx`(
    select distinct on (a.event_id) a.event_id, a.rank, a.field_id
    from (${union}) a
    join records ev on ev.id = a.event_id and ev.deleted_at is null
      and ev.object_type_id = any(${schema.eventTypeIds}::uuid[])
    order by a.event_id, a.rank, a.field_id)`;
}

/** IDs of active relation fields: a deleted field's edges no longer attach anything. */
function activeRelationFieldIds(schema: CompiledSchema): string[] {
  return [...schema.fieldOwners]
    .filter(([id, object]) => {
      const field = object.fieldsById.get(id);
      return (
        field?.status === 'active' &&
        object.state.status === 'active' &&
        field.type === 'relation' &&
        field.settings.relationCardinality !== 'one_to_many'
      );
    })
    .map(([id]) => id);
}

/** How a row from `directAttachments` presents its attachment. */
export function viaOf(schema: CompiledSchema, row: { rank: number; field_id: string | null }): Via {
  if (row.rank === VIA_RANK.participant) return { kind: 'participant' };
  if (row.rank === VIA_RANK.about) return { kind: 'about' };
  const field = row.field_id
    ? schema.fieldOwners.get(row.field_id)?.fieldsById.get(row.field_id)
    : undefined;
  return { kind: 'field', field: field?.name ?? 'unknown' };
}

/**
 * A page of the live events attached directly to a record (7.1), newest
 * first, each with how it is attached. Keyset on (occurred_at, id).
 */
export async function attachedEventPage(
  tx: Tx,
  schema: CompiledSchema,
  workspaceId: string,
  recordId: string,
  limit: number,
  cursor?: string,
  link?: EventAttachment,
): Promise<{ items: AttachedEvent[]; nextCursor: string | null }> {
  const rows = await tx<(RecordRow & { stamp: string; rank: number; field_id: string | null })[]>`
    select ${tx(RECORD_COLUMNS.map((c) => `r.${c}`))}, e.occurred_at::text as stamp,
      a.rank, a.field_id
    from ${directAttachments(tx, schema, workspaceId, recordId, link)} a
    join records r on r.id = a.event_id
    join event_records e on e.record_id = r.id
    where ${after(tx, tx`e.occurred_at`, tx`r.id`, cursor, true)}
    order by e.occurred_at desc, r.id desc
    limit ${limit + 1}`;
  const result = page(rows, limit);
  const presented = await presentRecords(tx, schema, result.items);
  return {
    items: presented.flatMap((record, i) => {
      const row = result.items[i];
      return row && record.event
        ? [{ ...record, event: record.event, via: viaOf(schema, row) }]
        : [];
    }),
    nextCursor: result.nextCursor,
  };
}
