import type { TransactionSql } from 'postgres';
import type { Sql } from './client.js';

export type Tx = TransactionSql<Record<string, never>>;

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
