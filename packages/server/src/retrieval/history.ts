import type { AttachedEvent, EventAttachment, RecordReference, Via } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import {
  cursorPosition,
  keysetStream,
  mergeStreams,
  page,
  type StreamSpec,
  type StreamStart,
  streamStatement,
  take,
} from '../db/pagination.js';
import { presentRecords, type RecordRow } from '../records/read.js';
import { references } from '../records/references.js';
import { directoryEntries, rowsByIds } from '../records/store.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';

/**
 * A record's event history (ARCHITECTURE.md 7.1, 7.2; spec section 8), read
 * from the stored attachments: `event_attachments` (participant, about, or
 * one of the event's own relation fields) and `rollup_attachments` (one hop
 * through a `rollUpEvents` field). Each is one indexed stream per record,
 * `WHERE target = $t ORDER BY occurred_at DESC LIMIT n`, read in bounded
 * keyset batches and merged. Liveness, visibility and deprecated fields are
 * filtered as rows arrive; each event is kept once, with the attachment
 * that wins by precedence, before anything is limited or counted.
 */

/** The precedence of attachment kinds (7.1): a lower rank wins. */
export const VIA_RANK = { participant: 1, about: 2, field: 3, rollup: 4 } as const;

/** One event of a record's history and the attachment that wins. */
export type HistoryRow = {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  rank: number;
  field_id: string | null;
  via_record_id: string | null;
};

type DirectRow = {
  event: string;
  via: 'participant' | 'about' | 'field';
  field_id?: string | null;
  event_type: string;
  occurred_at: Date;
};

type RollupRow = {
  event: string;
  field_id: string;
  source: string;
  event_type: string;
  occurred_at: Date;
};

/** One path to an event, before deduplication. */
type PathRow = HistoryRow;

const DIRECT_FIELDS = 'event, via, field_id, event_type, occurred_at';
const ROLLUP_FIELDS = 'event, field_id, source, event_type, occurred_at';

function directSpec(recordId: string, batch?: number): StreamSpec<DirectRow> {
  return {
    table: 'event_attachments',
    where: 'target = $t',
    vars: { t: recordId },
    time: 'occurred_at',
    fields: DIRECT_FIELDS,
    timeOf: (r) => r.occurred_at,
    keyOf: (r) => r.event,
    ...(batch ? { batch } : {}),
  };
}

function rollupSpec(recordId: string, batch?: number): StreamSpec<RollupRow> {
  return {
    table: 'rollup_attachments',
    where: 'target = $t',
    vars: { t: recordId },
    time: 'occurred_at',
    fields: ROLLUP_FIELDS,
    timeOf: (r) => r.occurred_at,
    keyOf: (r) => r.event,
    ...(batch ? { batch } : {}),
  };
}

const fromDirect = (r: DirectRow): PathRow => ({
  event_id: r.event,
  event_type: r.event_type,
  occurred_at: r.occurred_at,
  rank: VIA_RANK[r.via],
  field_id: r.via === 'field' ? (r.field_id ?? null) : null,
  via_record_id: null,
});

const fromRollup = (r: RollupRow): PathRow => ({
  event_id: r.event,
  event_type: r.event_type,
  occurred_at: r.occurred_at,
  rank: VIA_RANK.rollup,
  field_id: r.field_id,
  via_record_id: r.source,
});

export type HistoryOptions = {
  /** Only this direct kind (no rollups). */
  link?: EventAttachment;
  /** Some visible event types only. */
  eventTypeIds?: readonly string[];
  /** Resume strictly after this (occurred_at, event ID). */
  start?: StreamStart;
  /** Stop at events older than this. */
  until?: Date;
  /** Rows per statement. */
  batch?: number;
};

/** The paths `options` admits, by schema alone (no reads). */
function admits(schema: CompiledSchema, recordId: string, options: HistoryOptions) {
  const types = new Set(
    options.eventTypeIds
      ? options.eventTypeIds.filter((id) => schema.eventTypeIds.includes(id))
      : schema.eventTypeIds,
  );
  const eventFields = new Set(schema.eventRelationFieldIds);
  const rollupFields = new Set(schema.rollUpFieldIds);
  const want = (kind: EventAttachment) => !options.link || options.link === kind;
  return (row: PathRow): boolean => {
    if (!types.has(row.event_type)) return false;
    if (row.rank === VIA_RANK.participant) return want('participant');
    if (row.rank === VIA_RANK.about) return want('about');
    if (row.rank === VIA_RANK.field) return want('field') && eventFields.has(row.field_id ?? '');
    return (
      !options.link &&
      rollupFields.has(row.field_id ?? '') &&
      !!row.via_record_id &&
      row.via_record_id !== recordId
    );
  };
}

/** Of several paths to one event, the one that wins (7.1). */
function winner(paths: PathRow[]): PathRow {
  return paths.reduce((best, p) => {
    if (p.rank !== best.rank) return p.rank < best.rank ? p : best;
    const f = (p.field_id ?? '').localeCompare(best.field_id ?? '');
    if (f !== 0) return f < 0 ? p : best;
    return (p.via_record_id ?? '') < (best.via_record_id ?? '') ? p : best;
  });
}

/** Paths whose event (and rollup source) is live, and of an allowed type. */
async function livePaths(
  db: Db,
  schema: CompiledSchema,
  paths: PathRow[],
  types?: readonly string[],
): Promise<PathRow[]> {
  if (paths.length === 0) return [];
  const allowed = new Set(types ?? schema.eventTypeIds);
  const entries = await directoryEntries(db, [
    ...paths.map((p) => p.event_id),
    ...paths.flatMap((p) => (p.via_record_id ? [p.via_record_id] : [])),
  ]);
  return paths.filter((p) => {
    const event = entries.get(p.event_id);
    if (!event || event.deleted_at || !allowed.has(event.object_type_id)) return false;
    if (!p.via_record_id) return true;
    const source = entries.get(p.via_record_id);
    return !!source && !source.deleted_at;
  });
}

/**
 * The events of a record's history, newest first (occurred_at, then event
 * ID, descending), each once with the attachment that wins: a direct kind
 * first (participant, about, field), then a rollup; the smallest field ID
 * and then source record ID among several. Never more than one hop.
 */
export async function* historyEvents(
  db: Db,
  schema: CompiledSchema,
  recordId: string,
  options: HistoryOptions = {},
): AsyncGenerator<HistoryRow> {
  const ok = admits(schema, recordId, options);
  const batch = options.batch ?? 50;
  const withUntil = <T>(spec: StreamSpec<T>): StreamSpec<T> =>
    options.until ? { ...spec, until: options.until } : spec;
  const streams: AsyncGenerator<PathRow>[] = [
    map(keysetStream(db, withUntil(directSpec(recordId, batch)), options.start), fromDirect),
  ];
  if (!options.link && schema.rollUpFieldIds.length > 0) {
    streams.push(
      map(keysetStream(db, withUntil(rollupSpec(recordId, batch)), options.start), fromRollup),
    );
  }
  const merged = mergeStreams(streams, (a, b) => {
    const t = b.occurred_at.getTime() - a.occurred_at.getTime();
    return t !== 0 ? t : a.event_id < b.event_id ? 1 : a.event_id > b.event_id ? -1 : 0;
  });
  // Paths of one event share its time and ID, so they arrive together.
  let pending: PathRow[][] = [];
  let current: PathRow[] = [];
  const flush = async function* (): AsyncGenerator<HistoryRow> {
    const groups = pending;
    pending = [];
    const live = new Set(
      await livePaths(db, schema, groups.flat(), options.eventTypeIds).then((rows) => rows),
    );
    for (const group of groups) {
      const kept = group.filter((p) => live.has(p));
      if (kept.length > 0) yield winner(kept);
    }
  };
  for await (const path of merged) {
    if (!ok(path)) continue;
    if (current.length > 0 && (current[0] as PathRow).event_id !== path.event_id) {
      pending.push(current);
      current = [];
      if (pending.length >= batch) yield* flush();
    }
    current.push(path);
  }
  if (current.length > 0) pending.push(current);
  yield* flush();
}

async function* map<A, B>(source: AsyncGenerator<A>, fn: (a: A) => B): AsyncGenerator<B> {
  for await (const item of source) yield fn(item);
}

/** The newest `limit` events of a record's history (see `historyEvents`). */
export async function eventHistory(
  db: Db,
  schema: CompiledSchema,
  recordId: string,
  options: HistoryOptions & { limit: number },
): Promise<HistoryRow[]> {
  return take(
    historyEvents(db, schema, recordId, { ...options, batch: options.batch ?? options.limit + 1 }),
    options.limit,
  );
}

/**
 * The number of events in a record's history, each counted once over every
 * path (7.2). Reads every attachment of the record (its own index range),
 * never the whole table.
 */
export async function countEventHistory(
  db: Db,
  schema: CompiledSchema,
  _workspaceId: string,
  recordId: string,
): Promise<number> {
  const [direct, rollups] = (await db.query(
    `SELECT ${DIRECT_FIELDS} FROM event_attachments WHERE target = $t;
     SELECT ${ROLLUP_FIELDS} FROM rollup_attachments WHERE target = $t;`,
    { t: recordId },
  )) as [DirectRow[], RollupRow[]];
  const ok = admits(schema, recordId, {});
  const paths = [...(direct ?? []).map(fromDirect), ...(rollups ?? []).map(fromRollup)].filter(ok);
  const live = await livePaths(db, schema, paths);
  return new Set(live.map((p) => p.event_id)).size;
}

/**
 * Events directly attached to a record (participant, about, or one of the
 * event's active relation fields), optionally of one kind: the `linked`
 * query filter. Liveness is left to the caller's own read of the events.
 */
export async function directEventIds(
  db: Db,
  schema: CompiledSchema,
  recordId: string,
  link?: EventAttachment,
): Promise<string[]> {
  const rows = await db.rows<DirectRow>(
    `SELECT ${DIRECT_FIELDS} FROM event_attachments WHERE target = $t;`,
    { t: recordId },
  );
  const ok = admits(schema, recordId, link ? { link } : { link: undefined });
  return [
    ...new Set(
      rows
        .map(fromDirect)
        .filter((p) => p.rank !== VIA_RANK.rollup && ok(p))
        .map((p) => p.event_id),
    ),
  ];
}

/** How a history row presents its attachment. */
export function viaOf(
  schema: CompiledSchema,
  row: { rank: number; field_id: string | null; via_record_id?: string | null },
): Via {
  if (row.rank === VIA_RANK.participant) return { kind: 'participant' };
  if (row.rank === VIA_RANK.about) return { kind: 'about' };
  const field = row.field_id
    ? schema.fieldOwners.get(row.field_id)?.fieldsById.get(row.field_id)
    : undefined;
  const name = field?.name ?? 'unknown';
  if (row.rank === VIA_RANK.rollup && row.via_record_id) {
    return { kind: 'rollup', field: name, record: row.via_record_id };
  }
  return { kind: 'field', field: name };
}

/** Presents history rows as event records, in their order; vanished rows are dropped. */
export async function presentHistory(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  rows: readonly HistoryRow[],
): Promise<AttachedEvent[]> {
  const records = await rowsByIds(
    db,
    workspaceId,
    schema,
    rows.map((r) => r.event_id),
  );
  const kept = rows.filter((r) => records.has(r.event_id));
  const presented = await presentRecords(
    db,
    schema,
    kept.map((r) => records.get(r.event_id) as RecordRow),
  );
  return presented.flatMap((record, i): AttachedEvent[] => {
    const row = kept[i];
    return row && record.event ? [{ ...record, event: record.event, via: viaOf(schema, row) }] : [];
  });
}

/**
 * A page of a record's event history (7.1, 7.2), newest first, each event
 * once with how it is attached. Keyset on (occurred_at, id).
 */
export async function attachedEventPage(
  db: Db,
  schema: CompiledSchema,
  workspaceId: string,
  recordId: string,
  limit: number,
  cursor?: string,
  link?: EventAttachment,
): Promise<{
  items: AttachedEvent[];
  nextCursor: string | null;
  references: Record<string, RecordReference>;
}> {
  const start = cursorPosition(cursor);
  const rows = await eventHistory(db, schema, recordId, {
    limit: limit + 1,
    ...(link ? { link } : {}),
    ...(start ? { start } : {}),
  });
  const result = page(
    rows.map((r) => ({ ...r, id: r.event_id, stamp: r.occurred_at })),
    limit,
  );
  const items = await presentHistory(db, workspaceId, schema, result.items);
  // Labels for every record the page names, in one read, so a client never
  // fetches one per participant.
  const named = items.flatMap(({ event, via }) => [
    ...event.participants.matched.map((p) => p.recordId),
    ...event.participants.unmatched.flatMap((p) => p.candidates ?? []),
    ...event.about,
    ...(via.kind === 'rollup' ? [via.record] : []),
  ]);
  return {
    items,
    nextCursor: result.nextCursor,
    references: await references(db, schema, [...new Set(named)]),
  };
}

/**
 * The `EXPLAIN` plan of every history stream shape, for tests that assert
 * each stays an index scan with its limit pushed down (spec section 8).
 */
export async function explainHistoryStreams(
  db: Db,
  recordId: string,
  at: Date = new Date(),
): Promise<Record<string, unknown>> {
  const shapes: Record<string, string> = {};
  for (const [name, spec] of [
    ['direct', directSpec(recordId, 51)],
    ['rollup', rollupSpec(recordId, 51)],
  ] as const) {
    shapes[name] = streamStatement(spec as StreamSpec<unknown>, false);
    shapes[`${name}Bounded`] = streamStatement(spec as StreamSpec<unknown>, true);
    shapes[`${name}Group`] =
      `SELECT ${spec.fields} FROM ${spec.table} WHERE target = $t AND occurred_at = $__at`;
  }
  const names = Object.keys(shapes);
  const results = await db.query(names.map((n) => `${shapes[n]} EXPLAIN;`).join('\n'), {
    t: recordId,
    __at: at,
  });
  return Object.fromEntries(names.map((n, i) => [n, results[i]]));
}
