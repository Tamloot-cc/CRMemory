import type { Context } from 'hono';
import { accountsConfig, type Config } from '../config.js';
import type { Sql } from '../db/client.js';
import { createAuth, type GoogleOverrides } from './auth.js';
import { createAccountsApp } from './routes.js';

export { CLIENT_IP_HEADER } from './auth.js';

/**
 * /account for one process: the container's (index.ts) or the control
 * function's (lambda/control.ts). Throws at startup when accounts mode is
 * only half configured (4.1).
 */
export function createAccountsServer(input: {
  config: Config;
  /** A connection as the control role. */
  sql: Sql;
  /**
   * Another, for Better Auth alone: its drizzle adapter replaces the pool's
   * date and JSON parsers, which would break every raw query sharing it.
   */
  authSql: Sql;
  clientIp: (c: Context) => string | undefined;
  google?: GoogleOverrides;
  rateLimit?: boolean;
}) {
  const { config } = input;
  const publicOrigin = config.RETAINER_PUBLIC_ORIGIN ?? `http://localhost:${config.PORT}`;
  const auth = createAuth({
    sql: input.authSql,
    config: accountsConfig(config),
    publicOrigin,
    ...(input.google ? { google: input.google } : {}),
    ...(input.rateLimit === undefined ? {} : { rateLimit: input.rateLimit }),
  });
  return createAccountsApp({ auth, sql: input.sql, publicOrigin, clientIp: input.clientIp });
}
