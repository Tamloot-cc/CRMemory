import type { TransactionSql } from 'postgres';
import type { Sql } from './client.js';

export type Tx = TransactionSql<Record<string, never>>;

/** What `sql.json` accepts. */
type JSONValue = Parameters<Tx['json']>[0];

/**
 * Runs `fn` in a transaction scoped to one workspace. `app.workspace_id` is
 * set for this transaction only, so row-level security confines every query
 * in it to that workspace (7).
 */
export async function inWorkspace<T>(
  sql: Sql,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as Tx);
  });
  return result as T;
}

/** Advisory-lock class for workspace schema locks (3). */
const SCHEMA_LOCK_CLASS = 0x5254; // "RT"

/**
 * Record writers hold the workspace schema lock in shared mode for the rest
 * of the transaction, so a schema change (exclusive mode) cannot race a
 * write's validation or commit against a stale schema.
 */
export async function lockSchemaShared(tx: Tx, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock_shared(${SCHEMA_LOCK_CLASS}::int4, hashtext(${workspaceId}))`;
}

/** Schema changes hold the workspace schema lock exclusively. */
export async function lockSchemaExclusive(tx: Tx, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(${SCHEMA_LOCK_CLASS}::int4, hashtext(${workspaceId}))`;
}

/** Advisory-lock class for the workspace deletion boundary (2.1). */
const PRIVACY_LOCK_CLASS = 0x5250; // "RP"

/**
 * The privacy lock is the serialization boundary between `forget` and
 * every other write (2.1). Writers hold it in shared mode, so a write
 * either commits before `forget` collects what to erase, or starts after
 * the suppression list is updated and sees it. `forget` holds it
 * exclusively. The consolidator holds it shared without the schema lock.
 */
export async function lockPrivacyShared(tx: Tx, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock_shared(${PRIVACY_LOCK_CLASS}::int4, hashtext(${workspaceId}))`;
}

export type WriteLocks = {
  /** Exclusive only for `forget` (2.1). */
  privacy?: 'shared' | 'exclusive';
  /** Exclusive only for moving events between types, which no write may interleave with (1.3). */
  schema?: 'shared' | 'exclusive';
};

/**
 * A record write's locks in one round trip: the schema lock (3), shared
 * unless the write rewrites what other writes resolve against, then the
 * privacy lock, shared or exclusive for `forget`. Postgres evaluates the
 * select list left to right, so the order matches taking them one at a time.
 */
export async function lockForWrite(
  tx: Tx,
  workspaceId: string,
  { privacy = 'shared', schema = 'shared' }: WriteLocks = {},
): Promise<void> {
  const lock = (lockClass: number, mode: 'shared' | 'exclusive') =>
    mode === 'shared'
      ? tx`pg_advisory_xact_lock_shared(${lockClass}::int4, hashtext(${workspaceId}))`
      : tx`pg_advisory_xact_lock(${lockClass}::int4, hashtext(${workspaceId}))`;
  await tx`select ${lock(SCHEMA_LOCK_CLASS, schema)}, ${lock(PRIVACY_LOCK_CLASS, privacy)}`;
}

/** Advisory-lock class for one consolidator run per workspace at a time (4.2). */
const CONSOLIDATOR_LOCK_CLASS = 0x5243; // "RC"

/** Takes the workspace's consolidator lock if it is free; false when another worker holds it. */
export async function tryLockConsolidator(tx: Tx, workspaceId: string): Promise<boolean> {
  const [row] = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(${CONSOLIDATOR_LOCK_CLASS}::int4, hashtext(${workspaceId}))
      as locked`;
  return row?.locked === true;
}

/**
 * Values headed for jsonb columns. They come from validated input or from
 * jsonb itself, so they are JSON; postgres.js types `sql.json` narrowly.
 */
export function jsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}
