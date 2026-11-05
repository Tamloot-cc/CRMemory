import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/api/http.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../../src/auth/keys.js';
import { authenticate, requireScope } from '../../src/auth/middleware.js';
import { workspaceDatabase } from '../../src/db/names.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let app: Hono<AppEnv>;
let workspaceId: string;
let readKey: string;
let adminKey: string;

beforeAll(async () => {
  workspaceId = (await createWorkspace(backend, { name: 'Auth' })).id;
  readKey = (
    await createApiKey(backend, {
      workspace: 'auth',
      name: 'Reader',
      actor: { type: 'agent', id: 'reader' },
      scopes: ['read'],
    })
  ).key;
  adminKey = (
    await createApiKey(backend, {
      workspace: workspaceId,
      name: 'Admin',
      actor: { type: 'user', id: 'admin' },
      scopes: ['admin'],
    })
  ).key;

  app = new Hono<AppEnv>();
  app.use('/v1/*', authenticate(backend));
  app.get('/v1/whoami', async (c) => {
    const caller = c.get('caller');
    // The per-transaction RLS setting and role become the runtime session's
    // token: bound to the caller's workspace database, refused definitions.
    const db = await backend.workspace(caller.workspaceId);
    const [state] = await db.rows<{ workspace_id: string }>(
      'SELECT workspace_id FROM ONLY workspace_state:current;',
    );
    const definitions = await db.query('INFO FOR DB;').then(
      () => 'allowed',
      () => 'refused',
    );
    return c.json({
      caller,
      session: { ws: state?.workspace_id, database: db.target.database, definitions },
    });
  });
  app.post('/v1/write', requireScope('write'), (c) => c.json({ ok: true }));
});

const call = (path: string, key?: string, method = 'GET') =>
  app.request(path, { method, headers: key ? { authorization: `Bearer ${key}` } : {} });

describe('authentication', () => {
  it('takes workspace, scopes and actor from the key', async () => {
    const res = await call('/v1/whoami', readKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caller: { workspaceId, scopes: ['read'], actor: { type: 'agent', id: 'reader' } },
      session: {
        ws: workspaceId,
        database: workspaceDatabase(workspaceId),
        definitions: 'refused',
      },
    });
  });

  it('rejects missing, malformed and unknown keys with 401', async () => {
    for (const res of [
      await call('/v1/whoami'),
      await app.request('/v1/whoami', { headers: { authorization: `Basic ${readKey}` } }),
      await call('/v1/whoami', 'rtn_doesnotexist'),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    }
  });

  it('stops accepting a key once revoked', async () => {
    const key = await createApiKey(backend, {
      workspace: workspaceId,
      name: 'Temp',
      actor: { type: 'agent', id: 'temp' },
      scopes: ['read'],
    });
    expect((await call('/v1/whoami', key.key)).status).toBe(200);
    await revokeApiKey(backend, key.id);
    expect((await call('/v1/whoami', key.key)).status).toBe(401);
    const listing = await listApiKeys(backend, workspaceId);
    expect(listing.find((k) => k.id === key.id)?.revokedAt).not.toBeNull();
    expect(JSON.stringify(listing)).not.toContain(key.key);
  });

  it('stores only the hash', async () => {
    const rows = await backend
      .adminCatalog()
      .rows<{ hash: string; prefix: string }>('SELECT hash, prefix FROM api_keys;');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      expect([readKey, adminKey].some((k) => row.hash === k)).toBe(false);
    }
  });
});

describe('scopes', () => {
  it('returns 403 naming the missing scope', async () => {
    const res = await call('/v1/write', readKey, 'POST');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'this API key needs the "write" scope',
        details: { required: 'write', scopes: ['read'] },
      },
    });
  });

  it('lets admin do everything', async () => {
    expect((await call('/v1/write', adminKey, 'POST')).status).toBe(200);
  });
});
