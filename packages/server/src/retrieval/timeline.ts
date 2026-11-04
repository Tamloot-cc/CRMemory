import { createHash } from 'node:crypto';
import {
  TIMELINE_ITEM_KINDS,
  type TimelineItem,
  type TimelineItemKind,
  type TimelinePage,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { eventHistory, liveFactSource, viaOf } from '../memory/events.js';
import { getRecord } from '../records/read.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import { assertions } from '../web/reads.js';
import { factsPage } from '../web/review.js';

/**
 * A record's unified timeline (8): its event history, the values asserted
 * for its fields and its facts, assembled from the source tables at read
 * time, newest first.
 */

const isoTime = z.iso.datetime({ offset: true });
/** A timestamptz as Postgres prints it, e.g. `2026-10-29 12:00:00.123456+00`. */
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
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

/**
 * One page of a record's timeline (8). Each kind is read by keyset from its
 * own table, at most a page of each, and Postgres merges them by (time
 * descending, kind order, ID descending), so equal times page exactly. The
 * event branch is the record's deduplicated event history (7.2), so an
 * event counts once before the limit. A filter for one kind (fields, event
 * types) leaves the other kinds out unless `types` names them.
 */
export async function timelinePage(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  input: TimelineInput,
): Promise<TimelinePage> {
  const record = await getRecord(tx, workspaceId, schema, recordId);
  const object = schema.objectsByName.get(record.object);
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

  /** Keyset and time range for one branch, whose items all have one kind. */
  const bound = (kind: TimelineItemKind) => (time: Fragment, id: Fragment) => {
    const parts: Fragment[] = [];
    if (input.from) parts.push(tx`${time} >= ${input.from}::timestamptz`);
    if (input.to) parts.push(tx`${time} < ${input.to}::timestamptz`);
    if (position) {
      const at = tx`${position.at}::timestamptz`;
      const order = KIND_ORDER[kind];
      parts.push(
        order > position.kind
          ? tx`${time} <= ${at}`
          : order < position.kind
            ? tx`${time} < ${at}`
            : tx`(${time}, ${id}) < (${at}, ${position.id}::uuid)`,
      );
    }
    return parts.length === 0 ? tx`true` : parts.reduce((a, b) => tx`${a} and ${b}`);
  };

  const branches: Fragment[] = [];
  if (kinds.has('event') && eventTypeIds.length > 0) {
    const history = eventHistory(tx, schema, workspaceId, record.id, {
      limit: limit + 1,
      where: bound('event'),
      eventTypeIds,
    });
    branches.push(tx`(
      select ${KIND_ORDER.event}::int as kind, h.event_id as id, h.occurred_at as at,
        h.rank, h.field_id, h.via_record_id
      from ${history} h
      order by h.occurred_at desc, h.event_id desc limit ${limit + 1})`);
  }
  if (kinds.has('field_change') && fieldIds.length > 0) {
    const where = bound('field_change')(tx`a.observed_at`, tx`a.id`);
    branches.push(tx`(
      select ${KIND_ORDER.field_change}::int as kind, a.id, a.observed_at as at,
        null::int as rank, null::uuid as field_id, null::uuid as via_record_id
      from field_assertions a
      where a.record_id = ${record.id} and a.workspace_id = ${workspaceId}
        and a.field_id = any(${fieldIds}::uuid[])
        and a.status in ('active', 'superseded') and ${where}
      order by a.observed_at desc, a.id desc limit ${limit + 1})`);
  }
  if (kinds.has('fact')) {
    const where = bound('fact')(tx`f.valid_from`, tx`f.id`);
    // Retracted facts and facts whose every source is gone are left out.
    branches.push(tx`(
      select ${KIND_ORDER.fact}::int as kind, f.id, f.valid_from as at,
        null::int as rank, null::uuid as field_id, null::uuid as via_record_id
      from facts f
      where f.record_id = ${record.id} and f.workspace_id = ${workspaceId}
        and f.deleted_at is null and exists (${liveFactSource(tx, tx`f.id`)}) and ${where}
      order by f.valid_from desc, f.id desc limit ${limit + 1})`);
  }
  if (branches.length === 0) return { record: record.id, items: [], nextCursor: null };

  const rows = await tx<
    {
      kind: number;
      id: string;
      at: Date;
      stamp: string;
      rank: number | null;
      field_id: string | null;
      via_record_id: string | null;
    }[]
  >`
    select t.*, t.at::text as stamp
    from (${branches.reduce((a, b) => tx`${a} union all ${b}`)}) t
    order by t.at desc, t.kind, t.id desc
    limit ${limit + 1}`;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ at: last.stamp, kind: last.kind, id: last.id }, binding)
      : null;

  const idsOf = (kind: TimelineItemKind) =>
    pageRows.filter((r) => r.kind === KIND_ORDER[kind]).map((r) => r.id);
  const [events, values, facts] = await Promise.all([
    presentEvents(tx, schema, idsOf('event')),
    presentValues(tx, schema, idsOf('field_change')),
    presentFacts(tx, schema, idsOf('fact')),
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
    return item ? [{ ...item, at }] : [];
  });
  return { record: record.id, items, nextCursor };
}

async function presentEvents(tx: Tx, schema: CompiledSchema, ids: string[]) {
  const result = new Map<string, { type: string; title: string | null; summary: string | null }>();
  if (ids.length === 0) return result;
  const rows = await tx<{ id: string; object_type_id: string; data: Record<string, unknown> }[]>`
    select id, object_type_id, data from records where id = any(${ids}::uuid[])`;
  for (const row of rows) {
    const object = schema.objectsById.get(row.object_type_id);
    const text = (key: string | undefined) => {
      const value = key === undefined ? undefined : row.data[key];
      return typeof value === 'string' ? value : null;
    };
    result.set(row.id, {
      type: object?.name ?? 'unknown',
      title: text(object?.core?.title.key),
      summary: text(object?.core?.summary.key),
    });
  }
  return result;
}

async function presentValues(tx: Tx, schema: CompiledSchema, ids: string[]) {
  const result = new Map<string, TimelineItem>();
  if (ids.length === 0) return result;
  const { items } = await assertions(tx, schema, tx`a.id = any(${ids}::uuid[])`, ids.length);
  for (const a of items) {
    if (a.status !== 'active' && a.status !== 'superseded') continue;
    result.set(a.id, {
      kind: 'field_change',
      id: a.id,
      at: a.observedAt,
      field: a.field,
      value: a.value,
      status: a.status,
      current: a.status === 'active',
      actor: a.actor,
      confidence: a.confidence,
      source: a.source,
      ...(a.relationReferences ? { relationReferences: a.relationReferences } : {}),
    });
  }
  return result;
}

async function presentFacts(tx: Tx, schema: CompiledSchema, ids: string[]) {
  const result = new Map<string, TimelineItem>();
  if (ids.length === 0) return result;
  const { facts } = await factsPage(
    tx,
    schema,
    tx`f.id = any(${ids}::uuid[])`,
    ids.length,
    undefined,
    true,
  );
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
