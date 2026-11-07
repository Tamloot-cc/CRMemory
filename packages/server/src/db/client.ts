import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type Config, ownerDatabaseUrl, RUNTIME_ROLE } from '../config.js';
import * as schema from './schema.js';

export { RUNTIME_ROLE };

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

/**
 * How the API and workers connect: as the runtime role itself when
 * RETAINER_RUNTIME_DATABASE_URL is set, otherwise with the migration role's
 * credentials, switching to the runtime role at connection startup.
 */
export function runtimeConnection(config: Config): { url: string; role?: string } {
  const url = config.RETAINER_RUNTIME_DATABASE_URL;
  return url ? { url } : { url: ownerDatabaseUrl(config), role: RUNTIME_ROLE };
}

/** A pool for the API or workers (see `runtimeConnection`). */
export function createRuntimeSql(config: Config, options: Omit<SqlOptions, 'role'> = {}) {
  const { url, role } = runtimeConnection(config);
  return createSql(url, { ...options, role });
}

export type Db = ReturnType<typeof createDb>['db'];
export type Sql = ReturnType<typeof createSql>;
