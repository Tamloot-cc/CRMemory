import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { test as base, expect } from '@playwright/test';
import postgres from 'postgres';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/auth/keys.js';
import { createSql, RUNTIME_ROLE } from '../src/db/client.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
export const test = base.extend<{
  retainer: {
    url: string;
    keys: { user: string; agent: string; reader: string; other: string };
    request: (path: string, body?: unknown, key?: string, method?: string) => Promise<any>;
  };
}>({
  retainer: async ({ browserName: _browserName }, use) => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error('DATABASE_URL is required');
    const name = `retainer_browser_${randomBytes(6).toString('hex')}`;
    const admin = postgres(adminUrl, { max: 1, onnotice: false });
    await admin.unsafe(
      `create database "${name}" template "${process.env.RETAINER_BROWSER_TEMPLATE}"`,
    );
    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${name}`;
    const owner = createSql(dbUrl.toString()),
      sql = createSql(dbUrl.toString(), { role: RUNTIME_ROLE });
    const workspace = await createWorkspace(owner, { name: 'Acme' }),
      other = await createWorkspace(owner, { name: 'Other workspace' });
    const user = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Dana',
        actor: { type: 'user', id: 'dana' },
        scopes: ['admin'],
      })
    ).key;
    const agent = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Inbox agent',
        actor: { type: 'agent', id: 'inbox' },
        scopes: ['read', 'write', 'schema:write'],
      })
    ).key;
    const reader = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Reader',
        actor: { type: 'user', id: 'reader' },
        scopes: ['read'],
      })
    ).key;
    const otherKey = (
      await createApiKey(owner, {
        workspace: other.id,
        name: 'Other user',
        actor: { type: 'user', id: 'other' },
        scopes: ['admin'],
      })
    ).key;
    const app = createApp({
      sql,
      webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listening address');
    const url = `http://127.0.0.1:${address.port}`;
    async function request(path: string, body?: unknown, key = agent, method?: string) {
      const response = await fetch(`${url}/v1${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: `Bearer ${key}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    }
    try {
      await use({ url, keys: { user, agent, reader, other: otherKey }, request });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await sql.end();
      await owner.end();
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  },
});
export { expect };
