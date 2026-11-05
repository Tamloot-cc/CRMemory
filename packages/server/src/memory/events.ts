import type {
  AddedLinks,
  EventRetraction,
  LogEventResult,
  SourceReference,
} from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { isUuid, publicId } from '../db/names.js';
import { type Operation, serverNow } from '../db/protocol.js';
import { AppError, notFound, requireUser } from '../errors.js';
import { isEventIdentitySuppressed } from '../privacy/suppression.js';
import { directoryEntries } from '../records/store.js';
import { normalizeFieldValue, prepareValues } from '../records/values.js';
import { sameValue } from '../records/winner.js';
import {
  type AssertionRow,
  entriesOf,
  fromStored,
  insertRecord,
  loadRecords,
  lockRecordsForUpdate,
  planState,
  type RemovedClaim,
  releaseAndRecompute,
  type StoredAssertion,
  updateAssertion,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import { type CompiledObject, type CompiledSchema, eventText } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { removeDirectAttachments } from './attachments.js';
import {
  type AddLinksInput,
  addLinks,
  followMerges,
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
const FUTURE_SKEW_MS = 10 * 60 * 1000;

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

type IdentityRow = {
  id: RecordId;
  object_type_id: string;
  occurred_at: Date;
  channel?: string | null;
  external_id?: string | null;
};

/**
 * Logs an event (4.1). Logging the same `(channel, externalId)` again with
 * the same type, time and initial values returns the existing event with
 * `created: false`, after adding any participants and `about` records it did
 * not have yet (1.3). A different payload is `event_conflict`; an identity
 * whose event was deleted or erased is `event_retracted`. Without an
 * external ID there is no source deduplication. Concurrent logs of one
 * identity are serialized by the write protocol, and the unique index on
 * `(channel, external_id)` backs it up.
 */
export async function logEvent(
  context: WriteContext,
  input: LogEventInput,
): Promise<LogEventResult> {
  const { workspaceId, schema, op } = context;
  const object = requireEventType(schema, input.type);
  const participants = normalizeParticipants(input.participants);
  const values = initialValues(object, input);
  const occurredAt = new Date(input.occurredAt);
  if (occurredAt.getTime() > serverNow().getTime() + FUTURE_SKEW_MS) {
    throw new AppError(
      422,
      'invalid_occurred_at',
      'occurredAt is in the future; log events that already happened, with their UTC offset',
      { occurredAt: input.occurredAt },
    );
  }

  if (input.externalId !== undefined) {
    if (await isEventIdentitySuppressed(op.db, workspaceId, input.channel, input.externalId)) {
      throw retracted(null);
    }
    const [identity] = await op.rows<IdentityRow>(
      'SELECT * FROM event_identity WHERE channel = $channel AND external_id = $external;',
      { channel: input.channel, external: input.externalId },
    );
    if (identity) {
      const id = publicId(identity.id);
      const entry = (await entriesOf(op, [id])).get(id);
      if (!entry || entry.deleted_at) throw retracted(id);
      await checkSameEvent(context, { record_id: id, object_type_id: identity.object_type_id, occurred_at: identity.occurred_at }, object, occurredAt, values);
      const stored = await loadLinks(op.db, id);
      const { rows, inserted } = await addLinks(context, id, stored, {
        participants,
        about: input.about,
      });
      const links = await presentLinks(op.db, schema, rows, inserted);
      return {
        id,
        type: object.name,
        created: false,
        participants: links.participants,
        about: links.about,
        added: links.added,
      };
    }
  }

  const record = await insertRecord(context, object, { occurredAt });
  op.batch.create('event_identity', record.id, {
    object_type_id: object.id,
    occurred_at: occurredAt,
    channel: input.channel,
    external_id: input.externalId,
    created_at: op.now,
  });
  // The initial values cite the event itself and were true when it happened.
  await writeFields(context, object, record, values, {
    sourceRecordId: record.id,
    observedAt: occurredAt,
    isInitial: true,
  });
  const { rows } = await addLinks(context, record.id, [], {
    participants,
    about: input.about,
  });
  const links = await presentLinks(op.db, schema, rows);
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

  const initial = await context.op.rows<{ field_id: string; value: unknown }>(
    'SELECT field_id, value FROM field_assertions WHERE record = $record AND is_initial = true;',
    { record: existing.record_id },
  );
  const original = new Map(initial.map((row) => [row.field_id, row.value]));
  const fields = object.activeFields.filter((f) => !f.settings.isInverse);

  // Relation values on both sides, resolved to their survivors in one read.
  const relationIds = fields
    .filter((f) => f.type === 'relation')
    .flatMap((f) => [values.get(f), original.get(f.id as string)])
    .flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? (v as string[]) : []));
  const survivors = await canonicalRecordsAll(context, relationIds);
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
  context: WriteContext,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rows = await followMerges(context.op.db, ids);
  return new Map(rows.map((r) => [r.start_id, r.id]));
}

/** A live, visible event record, for a change to its links. */
async function lockEvent(context: WriteContext, id: string): Promise<{ id: string }> {
  const entry = (await entriesOf(context.op, [id])).get(id);
  const object = entry && context.schema.objectsById.get(entry.object_type_id);
  if (!entry || !object || object.hidden || object.state.status !== 'active' || !object.isEvent) {
    throw notFound('event', { id });
  }
  if (entry.deleted_at) {
    throw new AppError(404, 'record_deleted', `event ${id} was deleted`, { recordId: id });
  }
  return { id };
}

/**
 * Adds participants and `about` records to a logged event, with the same
 * matching as `logEvent` (1.3). Idempotent: links it already has are not
 * added again. Returns what was added; the caller presents the event after
 * the write commits.
 */
export async function addEventLinks(
  context: WriteContext,
  id: string,
  input: AddLinksInput,
): Promise<{ id: string; added: AddedLinks }> {
  const participants = normalizeParticipants(input.participants);
  await lockEvent(context, id);
  const stored = await loadLinks(context.op.db, id);
  const { inserted, rows } = await addLinks(context, id, stored, {
    participants,
    about: input.about,
  });
  const links = await presentLinks(context.op.db, context.schema, rows, inserted);
  return { id, added: links.added };
}

type StoredLinkRow = {
  id: RecordId;
  event: string;
  link: 'participant' | 'about';
  record?: string | null;
};

/**
 * Removes one participant, or one record from the `about` list, from an
 * event (1.3). Only a person removes links: what an agent logged stays
 * until someone decides otherwise.
 */
export async function removeEventLink(
  context: WriteContext,
  id: string,
  target: { participant: string } | { about: string },
): Promise<{ id: string }> {
  requireUser(context.actor, 'remove a participant or an about record');
  await lockEvent(context, id);
  const { op } = context;
  let found: StoredLinkRow | undefined;
  if ('participant' in target) {
    if (isUuid(target.participant)) {
      const [row] = await op.rows<StoredLinkRow>('SELECT * FROM $link;', {
        link: new RecordId('event_links', target.participant),
      });
      if (row && row.event === id && row.link === 'participant') found = row;
    }
  } else {
    // The about record is followed through merges, as in addLinks.
    const record =
      (await lockLinkTargets(context, [target.about])).get(target.about)?.id ?? target.about;
    [found] = await op.rows<StoredLinkRow>(
      "SELECT * FROM event_links WHERE event = $event AND link = 'about' AND record = $record;",
      { event: id, record },
    );
  }
  if (!found) {
    throw 'participant' in target
      ? notFound('participant', { id: target.participant, event: id })
      : notFound('about record', { id: target.about, event: id });
  }
  const linkId = publicId(found.id);
  op.batch.deleteIds('event_links', [linkId]);
  if (found.record) {
    await removeDirectAttachments(context, [
      { event: id, target: found.record, via: found.link, linkId },
    ]);
  }
  return { id };
}

/** A live event cited as a source, and when it happened (rules 2.1, 2.2). */
export type CitedSource = { id: string; occurredAt: Date };

/**
 * A live event to cite as a source. Writes citing it and its deletion are
 * serialized by the write protocol, so a write either commits before the
 * deletion (which then retracts its claims) or sees it deleted. Only a live
 * event record of a visible type in this workspace can be a source: an
 * entity record, the hidden internal notes and other workspaces' records
 * cannot.
 */
export async function lockSource(
  context: WriteContext,
  recordId: string,
): Promise<CitedSource> {
  const record = isUuid(recordId)
    ? (await loadRecords(context, [recordId])).get(recordId)
    : undefined;
  const object = record && context.schema.objectsById.get(record.object_type_id);
  if (!record || !object || object.hidden || !record.occurred_at) {
    throw new AppError(
      422,
      'invalid_source',
      record && object && !object.isEvent
        ? `source ${recordId} is a ${object.name}, not an event; a source is an event record: ` +
            'log it with log_event first and pass the id it returns'
        : `source ${recordId} is not an event in this workspace; log it with log_event first ` +
            'and pass the id it returns',
      { source: recordId },
    );
  }
  if (record.deleted_at) {
    throw new AppError(409, 'source_retracted', `source event ${record.id} was deleted`, {
      source: record.id,
    });
  }
  return { id: record.id, occurredAt: record.occurred_at };
}

/** Assertions citing any of some events, as this plan sees them. */
async function assertionsCiting(
  context: WriteContext,
  eventIds: readonly string[],
): Promise<AssertionRow[]> {
  const vars: Record<string, unknown> = {};
  const statements = eventIds.map((id, i) => {
    vars[`e${i}`] = id;
    return `SELECT * FROM field_assertions WHERE source = $e${i};`;
  });
  const results = (await context.op.db.query(statements.join('\n'), vars)) as StoredAssertion[][];
  const rows = new Map(results.flat().map((row) => [publicId(row.id), fromStored(row)]));
  const wanted = new Set(eventIds);
  for (const [id, row] of planState(context.op).assertions) {
    if (row.source && wanted.has(row.source)) rows.set(id, row);
    else rows.delete(id);
  }
  return [...rows.values()];
}

/**
 * The deletion lifecycle of events (6.4), after they are soft-deleted:
 * every field assertion on other records that cites one of them becomes
 * `retracted`, the fields where one was winning are recomputed, and facts
 * left with no live source are hidden on read. A retracted assertion is
 * never eligible again, so an older superseded claim from the same source
 * cannot win either (rule 2.4). The events' own initial values stay with
 * them.
 */
export async function retractEventClaims(
  context: WriteContext,
  eventIds: readonly string[],
): Promise<EventRetraction> {
  if (eventIds.length === 0) {
    return { retractedAssertions: 0, recomputedRecordIds: [], hiddenFactIds: [] };
  }
  const ids = new Set(eventIds);
  const citing = (await assertionsCiting(context, [...ids])).filter(
    (a) =>
      !ids.has(a.record) && ['active', 'superseded', 'pending_review'].includes(a.status),
  );
  const locked = await lockRecordsForUpdate(
    context,
    citing.map((a) => a.record),
  );
  const retracted: RemovedClaim[] = citing.map((a) => {
    updateAssertion(context, a, { status: 'retracted' });
    return { record_id: a.record, field_id: a.field_id, status: a.status };
  });
  // A claim from these very events on a record later in the order must not
  // block another record's previous value from coming back.
  const recomputed = await releaseAndRecompute(context, locked, retracted);
  const cited = await factsCiting(context.op.db, [...ids]);
  const live = await liveFactSources(context.op, cited);
  return {
    retractedAssertions: retracted.length,
    recomputedRecordIds: recomputed,
    hiddenFactIds: cited.filter((f) => (live.get(f)?.length ?? 0) === 0).sort(),
  };
}

/** Live facts (not retracted) citing any of some events. */
async function factsCiting(db: Db, eventIds: readonly string[]): Promise<string[]> {
  const vars: Record<string, unknown> = {};
  const statements = eventIds.map((id, i) => {
    vars[`e${i}`] = id;
    return `SELECT VALUE fact FROM fact_sources WHERE source = $e${i};`;
  });
  const factIds = [...new Set(((await db.query(statements.join('\n'), vars)) as string[][]).flat())];
  if (factIds.length === 0) return [];
  const facts = await db.rows<{ id: RecordId; deleted_at?: Date | null }>(
    'SELECT id, deleted_at FROM $ids;',
    { ids: factIds.map((id) => new RecordId('facts', id)) },
  );
  return facts.filter((f) => !f.deleted_at).map((f) => publicId(f.id));
}

/** A fact's source event that is still live (2.1). */
export type LiveFactSource = {
  fact: string;
  source: string;
  objectTypeId: string;
  occurredAt: Date;
  quote: string | null;
};

/**
 * The live sources of facts, in order of occurrence: events not deleted
 * (2.1). A fact with none is hidden on read. Inside a plan, deletions the
 * plan made count. Replaces a join: one indexed statement per fact, then
 * point lookups of the sources.
 */
export async function liveFactSources(
  dbOrOp: Db | Operation,
  factIds: readonly string[],
): Promise<Map<string, LiveFactSource[]>> {
  const ids = [...new Set(factIds)];
  const result = new Map<string, LiveFactSource[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const db = 'db' in dbOrOp ? dbOrOp.db : dbOrOp;
  const vars: Record<string, unknown> = {};
  const statements = ids.map((id, i) => {
    vars[`f${i}`] = id;
    return `SELECT fact, source, quote, id FROM fact_sources WHERE fact = $f${i} ORDER BY id;`;
  });
  const rows = (
    (await db.query(statements.join('\n'), vars)) as {
      fact: string;
      source?: string | null;
      quote?: string | null;
    }[][]
  ).flat();
  const sourceIds = [...new Set(rows.flatMap((r) => (r.source ? [r.source] : [])))];
  const entries =
    'db' in dbOrOp ? await entriesOf(dbOrOp, sourceIds) : await directoryEntries(db, sourceIds);
  const identities = await db.rows<{ id: RecordId; occurred_at: Date }>(
    'SELECT id, occurred_at FROM $ids;',
    { ids: sourceIds.map((id) => new RecordId('event_identity', id)) },
  );
  const occurred = new Map(identities.map((i) => [publicId(i.id), i.occurred_at]));
  for (const row of rows) {
    if (!row.source) continue;
    const entry = entries.get(row.source);
    const at = occurred.get(row.source);
    if (!entry || entry.deleted_at || !at) continue;
    result.get(row.fact)?.push({
      fact: row.fact,
      source: row.source,
      objectTypeId: entry.object_type_id,
      occurredAt: at,
      quote: row.quote ?? null,
    });
  }
  for (const list of result.values()) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
  return result;
}

/**
 * The live, visible event a claim cites, as callers see it (6.4), from a
 * row that left-joined it: null when it is gone or hidden (an internal note).
 */
export function presentSource(
  schema: CompiledSchema,
  row: {
    source_record_id: string | null;
    source_type: string | null;
    source_data: Record<string, unknown> | null;
    occurred_at: Date | null;
  },
): SourceReference | null {
  if (!row.occurred_at || !row.source_record_id || !row.source_type) return null;
  const object = schema.objectsById.get(row.source_type);
  return {
    id: row.source_record_id,
    type: object?.name ?? 'unknown',
    title: eventText(object, row.source_data ?? {}).title,
    occurredAt: row.occurred_at.toISOString(),
  };
}

