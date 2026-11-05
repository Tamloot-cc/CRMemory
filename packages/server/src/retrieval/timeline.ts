import { createHash } from 'node:crypto';
import {
  TIMELINE_ITEM_KINDS,
  type TimelineItem,
  type TimelineItemKind,
  type TimelinePage,
} from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import type { RecordId } from '../db/cbor.js';
import { publicId } from '../db/names.js';
import {
  filterChunks,
  keysetStream,
  mergeStreams,
  type StreamStart,
  take,
} from '../db/pagination.js';
import { AppError } from '../errors.js';
import { liveFactSources, presentSource } from '../memory/events.js';
import { findLiveRecord } from '../records/read.js';
import { references } from '../records/references.js';
import { directoryEntries, fetchRows, rowsByIds } from '../records/store.js';
import { type CompiledObject, type CompiledSchema, eventText } from '../schema-engine/compiled.js';
import { assertionsByIds } from '../web/reads.js';
import { factsPage } from '../web/review.js';
import { historyEvents, viaOf } from './history.js';

/**
 * A record's unified timeline (8): its event history, the values asserted
 * for its fields and its facts, assembled from the source tables at read
 * time, newest first.
 */

const isoTime = z.iso.datetime({ offset: true });
/** An ISO-8601 instant, as the cursor carries it. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const uuid = z.uuid();

export const timelineInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  /** Item kinds to include; all by default, or those the other filters name. */
  types: z.array(z.enum(TIMELINE_ITEM_KINDS)).min(1).optional(),
  /** Field names: only values asserted for these fields. */
  fields: z.array(z.string().min(1)).min(1).max(100).optional(),
  /** Event type names: only events of these types. */
  eventTypes: z.array(z.string().min(1)).min(1).max(100).optional(),
  /** Items at or after this time. */
  from: isoTime.optional(),
  /** Items before this time. */
  to: isoTime.optional(),
});
export type TimelineInput = z.infer<typeof timelineInputSchema>;

/** Item kinds by their order at equal times. */
const KIND_ORDER: Record<TimelineItemKind, number> = { event: 0, field_change: 1, fact: 2 };

type Position = { at: string; kind: number; id: string };

/**
 * The cursor carries the last item's whole sort key and a digest of what
 * the page was for, so it is refused for another record or other filters.
 */
function encodeCursor(position: Position, binding: string): string {
  return Buffer.from(JSON.stringify({ ...position, b: binding })).toString('base64url');
}
function decodeCursor(raw: string, binding: string): Position {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const value = parsed as Partial<Position & { b: string }> | null;
  if (
    !value ||
    typeof value.at !== 'string' ||
    !STAMP.test(value.at) ||
    !Object.values(KIND_ORDER).includes(value.kind as number) ||
    !uuid.safeParse(value.id).success
  ) {
    throw new AppError(400, 'invalid_cursor', 'the cursor is not one this endpoint returned');
  }
  if (value.b !== binding) {
    throw new AppError(
      400,
      'invalid_cursor',
      'the cursor belongs to another record or other filters; start again without it',
    );
  }
  return { at: value.at, kind: value.kind as number, id: value.id as string };
}

/** Resolves names to the record's active fields; an unknown name is a 400 listing them. */
function resolveFields(object: CompiledObject, names: string[] | undefined): string[] {
  const fields = object.activeFields.filter((f) => !f.settings.isInverse);
  if (!names) return fields.map((f) => f.id as string);
  return names.map((name) => {
    const field = fields.find((f) => f.name === name);
    if (!field) {
      throw new AppError(
        400,
        'unknown_field',
        `${object.name} has no field "${name}"; its fields: ${fields.map((f) => f.name).join(', ')}`,
        { field: name },
      );
    }
    return field.id as string;
  });
}

function resolveEventTypes(schema: CompiledSchema, names: string[] | undefined): string[] {
  if (!names) return schema.eventTypeIds;
  const types = schema.eventTypeIds.flatMap((id) => {
    const object = schema.objectsById.get(id);
    return object ? [object] : [];
  });
  return names.map((name) => {
    const type = types.find((t) => t.name === name);
    if (!type) {
      throw new AppError(
        400,
        'unknown_event_type',
        `"${name}" is not an event type; event types: ${types.map((t) => t.name).join(', ')}`,
        { eventType: name },
      );
    }
    return type.id;
  });
}

type Item = {
  kind: number;
  id: string;
  at: Date;
  rank: number | null;
  field_id: string | null;
  via_record_id: string | null;
};

const itemOrder = (a: Item, b: Item) =>
  b.at.getTime() - a.at.getTime() || a.kind - b.kind || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * One page of a record's timeline (8). Each kind is its own indexed keyset
 * stream, read in bounded batches and merged by (time descending, kind
 * order, ID descending), so equal times page exactly. The event stream is
 * the record's deduplicated event history (7.2), so an event counts once
 * before the limit. A filter for one kind (fields, event types) leaves the
 * other kinds out unless `types` names them.
 */
export async function timelinePage(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  input: TimelineInput,
): Promise<TimelinePage> {
  const record = await findLiveRecord(db, workspaceId, schema, recordId);
  const object = schema.objectsById.get(record.object_type_id);
  if (!object) throw new AppError(404, 'not_found', `record ${recordId} not found`);

  const kinds = new Set<TimelineItemKind>(
    input.types ??
      (input.fields || input.eventTypes
        ? [
            ...(input.eventTypes ? (['event'] as const) : []),
            ...(input.fields ? (['field_change'] as const) : []),
          ]
        : TIMELINE_ITEM_KINDS),
  );
  const fieldIds = resolveFields(object, input.fields);
  const eventTypeIds = resolveEventTypes(schema, input.eventTypes);
  const binding = createHash('sha256')
    .update(
      JSON.stringify([
        record.id,
        [...kinds].sort(),
        input.fields ? [...fieldIds].sort() : null,
        input.eventTypes ? [...eventTypeIds].sort() : null,
        input.from ?? null,
        input.to ?? null,
      ]),
    )
    .digest('base64url')
    .slice(0, 16);
  const position = input.cursor ? decodeCursor(input.cursor, binding) : null;
  const limit = input.limit;
  const batch = Math.min(limit + 1, 201);
  const until = input.from ? new Date(input.from) : undefined;

  /**
   * Where one kind's stream starts: after the cursor (at its time, items of
   * a later kind order are all still to come, of an earlier one none), or
   * before `to`.
   */
  const startOf = (kind: TimelineItemKind): StreamStart | undefined => {
    if (position) {
      const order = KIND_ORDER[kind];
      const at = new Date(position.at);
      return {
        at,
        key: order > position.kind ? '￿' : order < position.kind ? '' : position.id,
      };
    }
    return input.to ? { at: new Date(input.to), key: '' } : undefined;
  };
  const withStart = (kind: TimelineItemKind) => {
    const start = startOf(kind);
    return start ? { start } : {};
  };

  const streams: AsyncGenerator<Item>[] = [];
  if (kinds.has('event') && eventTypeIds.length > 0) {
    streams.push(
      mapItems(
        historyEvents(db, schema, record.id, {
          eventTypeIds,
          batch,
          ...withStart('event'),
          ...(until ? { until } : {}),
        }),
        (h) => ({
          kind: KIND_ORDER.event,
          id: h.event_id,
          at: h.occurred_at,
          rank: h.rank,
          field_id: h.field_id,
          via_record_id: h.via_record_id,
        }),
      ),
    );
  }
  if (kinds.has('field_change') && fieldIds.length > 0) {
    const wanted = new Set(fieldIds);
    type Row = { id: RecordId; field_id: string; status: string; observed_at: Date };
    const rows = keysetStream<Row>(
      db,
      {
        table: 'field_assertions',
        where: 'record = $record',
        vars: { record: record.id },
        time: 'observed_at',
        fields: 'id, field_id, status, observed_at',
        timeOf: (r) => r.observed_at,
        keyOf: (r) => publicId(r.id),
        batch,
        ...(until ? { until } : {}),
      },
      startOf('field_change'),
    );
    streams.push(
      mapItems(
        filterChunks(rows, batch, (chunk) =>
          chunk.filter(
            (r) => wanted.has(r.field_id) && (r.status === 'active' || r.status === 'superseded'),
          ),
        ),
        (r) => ({
          kind: KIND_ORDER.field_change,
          id: publicId(r.id),
          at: r.observed_at,
          rank: null,
          field_id: null,
          via_record_id: null,
        }),
      ),
    );
  }
  if (kinds.has('fact')) {
    type Row = { id: RecordId; valid_from: Date; deleted_at?: Date | null };
    const rows = keysetStream<Row>(
      db,
      {
        table: 'facts',
        where: 'record = $record',
        vars: { record: record.id },
        time: 'valid_from',
        fields: 'id, valid_from, deleted_at',
        timeOf: (r) => r.valid_from,
        keyOf: (r) => publicId(r.id),
        batch,
        ...(until ? { until } : {}),
      },
      startOf('fact'),
    );
    // Retracted facts and facts whose every source is gone are left out.
    streams.push(
      mapItems(
        filterChunks(rows, batch, async (chunk) => {
          const kept = chunk.filter((r) => !r.deleted_at);
          const live = await liveFactSources(
            db,
            kept.map((r) => publicId(r.id)),
          );
          return kept.filter((r) => (live.get(publicId(r.id))?.length ?? 0) > 0);
        }),
        (r) => ({
          kind: KIND_ORDER.fact,
          id: publicId(r.id),
          at: r.valid_from,
          rank: null,
          field_id: null,
          via_record_id: null,
        }),
      ),
    );
  }
  if (streams.length === 0) return { record: record.id, items: [], nextCursor: null };

  const rows = await take(mergeStreams(streams, itemOrder), limit + 1);
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ at: last.at.toISOString(), kind: last.kind, id: last.id }, binding)
      : null;

  const idsOf = (kind: TimelineItemKind) =>
    pageRows.filter((r) => r.kind === KIND_ORDER[kind]).map((r) => r.id);
  const [events, values, facts] = await Promise.all([
    presentEvents(db, workspaceId, schema, idsOf('event')),
    presentValues(db, schema, idsOf('field_change')),
    presentFacts(db, schema, idsOf('fact')),
  ]);
  const items = pageRows.flatMap((row): TimelineItem[] => {
    const at = row.at.toISOString();
    if (row.kind === KIND_ORDER.event) {
      const event = events.get(row.id);
      if (!event || row.rank === null) return [];
      return [
        {
          kind: 'event',
          id: row.id,
          at,
          ...event,
          via: viaOf(schema, {
            rank: row.rank,
            field_id: row.field_id,
            via_record_id: row.via_record_id,
          }),
        },
      ];
    }
    const item = (row.kind === KIND_ORDER.field_change ? values : facts).get(row.id);
    return item ? [item] : [];
  });
  return { record: record.id, items, nextCursor };
}

async function* mapItems<A>(source: AsyncGenerator<A>, fn: (a: A) => Item): AsyncGenerator<Item> {
  for await (const a of source) yield fn(a);
}

async function presentEvents(db: Db, workspaceId: string, schema: CompiledSchema, ids: string[]) {
  const result = new Map<string, { type: string; title: string | null; summary: string | null }>();
  if (ids.length === 0) return result;
  const rows = await rowsByIds(db, workspaceId, schema, ids);
  for (const row of rows.values()) {
    const object = schema.objectsById.get(row.object_type_id);
    result.set(row.id, { type: object?.name ?? 'unknown', ...eventText(object, row.data) });
  }
  return result;
}

async function presentValues(db: Db, schema: CompiledSchema, ids: string[]) {
  const result = new Map<string, TimelineItem>();
  if (ids.length === 0) return result;
  const rows = await assertionsByIds(db, ids);
  // Sources that are live and of visible types, in one read.
  const visible = new Set(schema.visibleObjectIds);
  const entries = [
    ...(
      await directoryEntries(
        db,
        rows.flatMap((r) => (r.source ? [r.source] : [])),
      )
    ).values(),
  ].filter((e) => !e.deleted_at && visible.has(e.object_type_id));
  const sources = await fetchRows(db, '', schema, entries);
  const fieldOf = (id: string) => schema.fieldOwners.get(id)?.fieldsById.get(id);
  const targetsOf = (row: (typeof rows)[number]) =>
    fieldOf(row.field_id)?.type === 'relation'
      ? [row.value].flat().filter((v): v is string => typeof v === 'string')
      : [];
  const refs = await references(db, schema, [...new Set(rows.flatMap(targetsOf))]);
  for (const row of rows) {
    const targets = targetsOf(row);
    const source = row.source ? sources.get(row.source) : undefined;
    result.set(row.id, {
      kind: 'field_change',
      id: row.id,
      at: row.observed_at.toISOString(),
      field: fieldOf(row.field_id)?.name ?? row.field_id,
      value: row.value,
      status: row.status as 'active' | 'superseded',
      current: row.status === 'active',
      actor: row.actor,
      confidence: row.confidence,
      source: presentSource(schema, {
        source_record_id: source ? row.source : null,
        source_type: source?.object_type_id ?? null,
        source_data: source?.data ?? null,
        occurred_at: source?.occurred_at ?? null,
      }),
      ...(targets.length > 0
        ? {
            relationReferences: Object.fromEntries(
              targets.flatMap((id) => (refs[id] ? [[id, refs[id]]] : [])),
            ),
          }
        : {}),
    });
  }
  return result;
}

async function presentFacts(db: Db, schema: CompiledSchema, ids: string[]) {
  const result = new Map<string, TimelineItem>();
  if (ids.length === 0) return result;
  const { facts } = await factsPage(db, schema, { factIds: ids }, ids.length, undefined, true);
  for (const f of facts) {
    if (f.status === 'retracted') continue;
    result.set(f.id, {
      kind: 'fact',
      id: f.id,
      at: f.validFrom,
      content: f.content,
      factKind: f.kind,
      status: f.status ?? 'current',
      validTo: f.validTo,
      writtenBy: f.writtenBy,
      sources: f.sources,
    });
  }
  return result;
}
