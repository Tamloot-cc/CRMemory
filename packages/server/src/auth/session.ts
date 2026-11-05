import type { Actor, Session } from '@retainer/shared';
import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../api/http.js';
import { readBody } from '../api/request.js';
import type { Backend } from '../db/backend.js';
import type { ApiKeyScope } from '../db/types.js';
import { AppError } from '../errors.js';
import type { Caller } from '../records/service.js';
import { readWorkspaceInfo } from '../workspaces/workspaces.js';
import { hashApiKey } from './keys.js';
export const SESSION_COOKIE = 'retainer_session';
/**
 * The caller of an API key, by its hash, through the runtime catalog
 * session (read-only). A revoked key, or one of a workspace that is not
 * active, is unknown.
 */
export async function lookupKey(backend: Backend, raw: string): Promise<Caller> {
  const unknown = () => new AppError(401, 'unauthorized', 'the API key is unknown or revoked');
  const [key] = await backend.catalog().rows<{
    workspace: string;
    scopes: ApiKeyScope[];
    actor: Actor;
    revoked_at?: Date | null;
  }>('SELECT workspace, scopes, actor, revoked_at FROM api_keys WHERE hash = $hash;', {
    hash: hashApiKey(raw),
  });
  if (!key || key.revoked_at) throw unknown();
  const [workspace] = await backend
    .catalog()
    .rows<{ state: string }>('SELECT state FROM type::record("workspaces", $id);', {
      id: key.workspace,
    });
  if (workspace?.state !== 'active') throw unknown();
  return { workspaceId: key.workspace, actor: key.actor, scopes: key.scopes };
}
export function requireWebHeader(c: Context, publicOrigin?: string): void {
  if (c.req.header('X-Retainer-Client') !== 'web')
    throw new AppError(403, 'csrf', 'send X-Retainer-Client: web');
  // A sibling origin must not be able to use a permissive proxy CORS policy.
  const origin = c.req.header('origin');
  if (origin && origin !== (publicOrigin ?? new URL(c.req.url).origin))
    throw new AppError(403, 'csrf', 'origin must match the request origin');
}
async function presentSession(backend: Backend, caller: Caller): Promise<Session> {
  const workspace = await readWorkspaceInfo(backend, caller.workspaceId).catch(() => {
    throw new AppError(401, 'unauthorized', 'workspace is unavailable');
  });
  return { workspace, actor: caller.actor, scopes: [...caller.scopes] };
}
export function sessionRoutes(app: Hono<AppEnv>, backend: Backend, publicOrigin?: string) {
  app.post('/auth/session', async (c) => {
    requireWebHeader(c, publicOrigin);
    const { key } = await readBody(c, z.strictObject({ key: z.string().min(1).max(1024) }));
    const caller = await lookupKey(backend, key);
    const result = await presentSession(backend, caller);
    const url = new URL(publicOrigin ?? c.req.url);
    setCookie(c, SESSION_COOKIE, key, {
      httpOnly: true,
      secure:
        url.protocol === 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
      sameSite: 'Strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.delete('/auth/session', (c) => {
    requireWebHeader(c, publicOrigin);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    c.header('Cache-Control', 'no-store');
    return c.json({ signedOut: true });
  });
}
export function meRoute(app: Hono<AppEnv>, backend: Backend) {
  app.get('/me', async (c) => c.json(await presentSession(backend, c.get('caller'))));
}
