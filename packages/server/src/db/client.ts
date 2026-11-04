import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * The role the API and workers run as (created by drizzle/0001_security.sql).
 * It owns no tables and has no BYPASSRLS, so row-level security applies.
 */
export const RUNTIME_ROLE = 'retainer_app';

export type SqlOptions = {
  /**
   * Postgres role every connection switches to at startup. The API and
   * workers run as the runtime role so row-level security applies to them;
   * migrations and operator commands connect without one.
   */
  role?: string;
  max?: number;
  /**
   * Keep connections open instead of retiring each after postgres.js's
   * random 30–60 minutes. For pools that hold a session lock across many
   * queries: a retired connection takes the lock with it, and the pool
   * carries on with a new connection that does not hold it.
   */
  keepConnections?: boolean;
};

export function createSql(databaseUrl: string, options: SqlOptions = {}) {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: false,
    ...(options.role ? { connection: { role: options.role } } : {}),
    ...(options.keepConnections ? { max_lifetime: null } : {}),
  });
}

export function createDb(databaseUrl: string, options: SqlOptions = {}) {
  const sql = createSql(databaseUrl, options);
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Sql = ReturnType<typeof createSql>;
