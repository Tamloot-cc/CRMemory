import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope } from '../db/schema.js';
import { AppError } from '../errors.js';
import { type AppEnv, errorResponse } from '../http/response.js';
import { lookupKey, requireWebHeader, SESSION_COOKIE } from './session.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Authenticates `Authorization: Bearer <key>` (7). The key is looked up by
 * its hash through `retainer_lookup_api_key`, the runtime role's only way
 * into api_keys. The caller's workspace, scopes and actor come from the
 * key, never from the request.
 */
export function authenticate(sql: Sql, publicOrigin?: string): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authorization = c.req.header('authorization');
    const match = BEARER.exec(authorization ?? '');
    const cookie = getCookie(c, SESSION_COOKIE);
    // An explicitly supplied invalid header must not fall back to a cookie.
    const raw = authorization !== undefined ? match?.[1] : cookie;
    if (!raw) {
      c.header('www-authenticate', 'Bearer');
      return errorResponse(
        c,
        new AppError(
          401,
          'unauthorized',
          'send an API key as "Authorization: Bearer <key>" or sign in',
        ),
      );
    }
    try {
      if (authorization === undefined && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
        requireWebHeader(c, publicOrigin);
      c.set('caller', await lookupKey(sql, raw));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.status === 401) c.header('www-authenticate', 'Bearer error="invalid_token"');
      return errorResponse(c, error);
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });
}

/** Requires a scope; `admin` implies every other scope. */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const missing = missingScope(c.get('caller').scopes, scope);
    if (missing) return errorResponse(c, missing);
    await next();
  });
}

/** The 403 for a key without `scope`, or undefined when it has it (REST and MCP). */
export function missingScope(
  scopes: readonly ApiKeyScope[],
  scope: ApiKeyScope,
): AppError | undefined {
  if (scopes.includes(scope) || scopes.includes('admin')) return undefined;
  return new AppError(403, 'forbidden', `this API key needs the "${scope}" scope`, {
    required: scope,
    scopes,
  });
}
