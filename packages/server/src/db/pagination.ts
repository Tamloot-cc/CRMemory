import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Db } from './backend.js';
import { ident } from './surreal.js';

/**
 * Keyset pagination (spec section 8). A cursor is the base64url JSON of the
 * last item's `[timestamp, id]`; the timestamp is an ISO-8601 instant.
 */

const cursorSchema = z.tuple([
  z
    .string()
    .max(64)
    .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/)
    .refine((v) => Number.isFinite(Date.parse(v))),
  z.uuid(),
]);

export function cursorValue(raw?: string): [string, string] | undefined {
  if (!raw) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString()));
  } catch {
    throw new AppError(400, 'invalid_cursor', 'pass nextCursor from the previous page');
  }
}

/** The position a cursor names, as a stream start. */
export function cursorPosition(raw?: string): StreamStart | undefined {
  const cursor = cursorValue(raw);
  return cursor ? { at: new Date(cursor[0]), key: cursor[1] } : undefined;
}

const stampOf = (stamp: string | Date) => (stamp instanceof Date ? stamp.toISOString() : stamp);

export const encodeCursor = (stamp: string | Date, id: string) =>
  Buffer.from(JSON.stringify([stampOf(stamp), id])).toString('base64url');

/** The first `limit` of `limit + 1` rows, and a cursor when there were more. */
export function page<T extends { stamp: string | Date; id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.stamp, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Keyset streams
// ---------------------------------------------------------------------------

/** Where a stream resumes: strictly after (`at`, `key`) in its order. */
export type StreamStart = { at: Date; key: string };

export type StreamSpec<T> = {
  /** A fixed table name (never caller text). */
  table: string;
  /** Top-level conditions on literal or parameter values, e.g. `target = $t`. */
  where: string;
  vars?: Record<string, unknown>;
  /** The indexed time column the stream is ordered by. */
  time: string;
  /** The projection, e.g. `event, occurred_at`. */
  fields: string;
  timeOf: (row: T) => Date;
  /** The tiebreak among rows with the same time (a public ID). */
  keyOf: (row: T) => string;
  descending?: boolean;
  /** Rows per statement. */
  batch?: number;
  /** Rows strictly beyond this time are not wanted (descending: older than). */
  until?: Date;
};

/**
 * The rows of one index-ordered stream, in (time, key) order, read in
 * bounded batches. Each batch is one top-level statement of the shape
 * `WHERE <where> AND time < $at ORDER BY time DESC LIMIT n`, an index scan
 * that stops at the limit (section 8). The last time group of a full batch
 * may be cut short, so it is read whole by equality and the next batch
 * starts strictly beyond it; ties are ordered by key here.
 */
export async function* keysetStream<T>(
  db: Db,
  spec: StreamSpec<T>,
  start?: StreamStart,
): AsyncGenerator<T> {
  const descending = spec.descending ?? true;
  const batch = Math.max(2, spec.batch ?? 50);
  const time = ident(spec.time);
  const table = ident(spec.table);
  const vars = spec.vars ?? {};
  const t = (row: T) => spec.timeOf(row).getTime();
  const order = (a: T, b: T) => {
    const byTime = descending ? t(b) - t(a) : t(a) - t(b);
    if (byTime !== 0) return byTime;
    const x = spec.keyOf(a);
    const y = spec.keyOf(b);
    return descending ? (x < y ? 1 : x > y ? -1 : 0) : x < y ? -1 : x > y ? 1 : 0;
  };
  const past = (row: T) =>
    spec.until !== undefined &&
    (descending ? t(row) < spec.until.getTime() : t(row) > spec.until.getTime());
  const group = async (at: Date) =>
    (
      await db.rows<T>(
        `SELECT ${spec.fields} FROM ${table} WHERE ${spec.where} AND ${time} = $__at;`,
        { ...vars, __at: at },
      )
    ).sort(order);

  let bound: Date | undefined;
  if (start) {
    for (const row of await group(start.at)) {
      const key = spec.keyOf(row);
      if (descending ? key < start.key : key > start.key) yield row;
    }
    bound = start.at;
  }
  for (;;) {
    const rows = await db.rows<T>(
      `SELECT ${spec.fields} FROM ${table} WHERE ${spec.where}${
        bound ? ` AND ${time} ${descending ? '<' : '>'} $__at` : ''
      } ORDER BY ${time} ${descending ? 'DESC' : 'ASC'} LIMIT ${batch};`,
      bound ? { ...vars, __at: bound } : vars,
    );
    if (rows.length < batch) {
      for (const row of rows.sort(order)) {
        if (past(row)) return;
        yield row;
      }
      return;
    }
    const last = spec.timeOf(rows.at(-1) as T);
    const complete = rows.filter((r) => t(r) !== last.getTime()).sort(order);
    for (const row of complete) {
      if (past(row)) return;
      yield row;
    }
    for (const row of await group(last)) {
      if (past(row)) return;
      yield row;
    }
    bound = last;
  }
}

/** The statement a stream's first batch runs, for plan assertions. */
export function streamStatement<T>(spec: StreamSpec<T>, bounded: boolean): string {
  const descending = spec.descending ?? true;
  const time = ident(spec.time);
  return `SELECT ${spec.fields} FROM ${ident(spec.table)} WHERE ${spec.where}${
    bounded ? ` AND ${time} ${descending ? '<' : '>'} $__at` : ''
  } ORDER BY ${time} ${descending ? 'DESC' : 'ASC'} LIMIT ${Math.max(2, spec.batch ?? 50)}`;
}

/** Merges streams that share one order into one. */
export async function* mergeStreams<T>(
  streams: AsyncGenerator<T>[],
  order: (a: T, b: T) => number,
): AsyncGenerator<T> {
  const heads: { value: T; stream: AsyncGenerator<T> }[] = [];
  for (const stream of streams) {
    const next = await stream.next();
    if (!next.done) heads.push({ value: next.value, stream });
  }
  while (heads.length > 0) {
    let best = 0;
    for (let i = 1; i < heads.length; i++) {
      if (order((heads[i] as { value: T }).value, (heads[best] as { value: T }).value) < 0)
        best = i;
    }
    const head = heads[best] as { value: T; stream: AsyncGenerator<T> };
    yield head.value;
    const next = await head.stream.next();
    if (next.done) heads.splice(best, 1);
    else head.value = next.value;
  }
}

/** Up to `n` items of a stream. */
export async function take<T>(stream: AsyncGenerator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  if (n <= 0) return out;
  for await (const item of stream) {
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * A stream filtered in chunks of `size`, for filters that read (liveness,
 * live sources) and so should look at many rows at once.
 */
export async function* filterChunks<T>(
  stream: AsyncGenerator<T>,
  size: number,
  keep: (rows: T[]) => Promise<T[]> | T[],
): AsyncGenerator<T> {
  let chunk: T[] = [];
  for await (const row of stream) {
    chunk.push(row);
    if (chunk.length >= size) {
      yield* await keep(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) yield* await keep(chunk);
}
