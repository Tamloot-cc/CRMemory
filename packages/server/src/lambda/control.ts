import type { Hono } from 'hono';
import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { createAccountsServer } from '../accounts/index.js';
import { type Config, loadConfig } from '../config.js';
import { createControlSql, type Sql } from '../db/client.js';
import { setLogLevel } from '../log.js';

/**
 * The control function (accounts spec 4.6): /account behind API Gateway,
 * with Better Auth and the control role's login. It is the only function
 * with a route to the internet, through a NAT gateway, because Google
 * sign-in needs one. The api function never loads this code.
 */
export function createControlHandler(
  config: Config,
  // One request at a time per instance, like the api function.
  sql: Sql = createControlSql(config, { max: config.RETAINER_DB_POOL_MAX }),
  authSql: Sql = createControlSql(config, { max: config.RETAINER_DB_POOL_MAX }),
) {
  setLogLevel(config.LOG_LEVEL);
  const app = createAccountsServer({
    config,
    sql,
    authSql,
    // API Gateway's view of the caller; a header the client sent is ignored.
    clientIp: (c) =>
      (c.env as { event?: { requestContext?: { http?: { sourceIp?: string } } } }).event
        ?.requestContext?.http?.sourceIp,
  });
  return handle(app as unknown as Hono);
}

let cached: ReturnType<typeof createControlHandler> | undefined;

/** The Lambda entry point (`dist/lambda/control.handler`). */
export const handler = (event: LambdaEvent, context: LambdaContext) => {
  cached ??= createControlHandler(loadConfig());
  return cached(event, context);
};
