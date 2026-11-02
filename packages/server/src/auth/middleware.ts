import type { Actor } from '@retainer/shared';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type AppEnv, errorResponse } from '../api/http.js';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope } from '../db/schema.js';
import { AppError } from '../errors.js';
import { hashApiKey } from './keys.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Authenticates `Authorization: Bearer <key>` (7). The key is looked up by
 * its hash through `retainer_lookup_api_key`, the runtime role's only way
 * into api_keys. The caller's workspace, scopes and actor come from the
 * key, never from the request.
 */
export function authenticate(sql: Sql): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const match = BEARER.exec(c.req.header('authorization') ?? '');
    if (!match?.[1]) {
      c.header('www-authenticate', 'Bearer');
      return errorResponse(
        c,
        new AppError(401, 'unauthorized', 'send an API key as "Authorization: Bearer <key>"'),
      );
    }
    const [key] = await sql<
      { key_id: string; workspace_id: string; scopes: ApiKeyScope[]; actor: Actor }[]
    >`select * from retainer_lookup_api_key(${hashApiKey(match[1])})`;
    if (!key) {
      c.header('www-authenticate', 'Bearer error="invalid_token"');
      return errorResponse(
        c,
        new AppError(401, 'unauthorized', 'the API key is unknown or revoked'),
      );
    }
    c.set('caller', { workspaceId: key.workspace_id, actor: key.actor, scopes: key.scopes });
    await next();
  });
}

/** Requires a scope; `admin` implies every other scope. */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { scopes } = c.get('caller');
    if (!scopes.includes(scope) && !scopes.includes('admin')) {
      return errorResponse(
        c,
        new AppError(403, 'forbidden', `this API key needs the "${scope}" scope`, {
          required: scope,
          scopes,
        }),
      );
    }
    await next();
  });
}
