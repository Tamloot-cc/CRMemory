import type { Sql } from '../db/client.js';

/**
 * One version runs at a time (docs/self-hosting.md, Upgrading). Stopping a
 * function only blocks new invocations, so a consolidator pass already
 * running would keep writing with the old code during a migration. Every
 * scheduled pass holds this lock shared, and the deploy's migration takes
 * it exclusively: the migration waits for passes in flight to finish, and a
 * pass started meanwhile waits for the migration.
 *
 * Session locks: `sql` must have `max: 1`, so the lock, the work and the
 * unlock share one connection.
 */
export const DEPLOY_LOCK = 0x52544e03;

/** Runs `work` holding the deploy lock shared (a consolidator pass). */
export async function withPassLock<T>(sql: Sql, work: () => Promise<T>): Promise<T> {
  await sql`select pg_advisory_lock_shared(${DEPLOY_LOCK})`;
  try {
    return await work();
  } finally {
    await sql`select pg_advisory_unlock_shared(${DEPLOY_LOCK})`;
  }
}

/**
 * Runs `work` holding the deploy lock exclusively (a migration), waiting at
 * most `waitSeconds` for passes in flight.
 */
export async function withMigrationLock<T>(
  sql: Sql,
  waitSeconds: number,
  work: () => Promise<T>,
): Promise<T> {
  await sql`select set_config('lock_timeout', ${`${waitSeconds * 1000}ms`}, false)`;
  try {
    await sql`select pg_advisory_lock(${DEPLOY_LOCK})`;
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') {
      throw new Error(
        `A consolidator pass was still running after ${waitSeconds} seconds; nothing was migrated. Run the deploy again.`,
      );
    }
    throw error;
  } finally {
    await sql`select set_config('lock_timeout', '0', false)`;
  }
  try {
    return await work();
  } finally {
    await sql`select pg_advisory_unlock(${DEPLOY_LOCK})`;
  }
}
