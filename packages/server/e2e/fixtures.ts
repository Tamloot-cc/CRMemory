import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { test as base, expect } from '@playwright/test';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/auth/keys.js';
import { generateSigningKeyEntry, parseSigningKeys } from '../src/db/access.js';
import { Backend } from '../src/db/backend.js';
import { ensureCatalog } from '../src/db/provision.js';
import { ident } from '../src/db/surreal.js';
import { consolidateWorkspace } from '../src/worker/consolidate.js';
import { installUpgrader } from '../src/workspaces/upgrade.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
export const test = base.extend<{
  retainer: {
    url: string;
    keys: { user: string; writer: string; agent: string; reader: string; other: string };
    request: (path: string, body?: unknown, key?: string, method?: string) => Promise<any>;
    /** Runs the consolidator once, which suggests merges. */
    consolidate: () => Promise<unknown>;
  };
}>({
  retainer: async ({ browserName: _browserName }, use) => {
    const surrealUrl = process.env.RETAINER_SURREAL_URL;
    if (!surrealUrl) throw new Error('RETAINER_SURREAL_URL is required');
    // A fresh namespace per test: its own catalog and workspace databases.
    const namespace = `rt_browser_${randomBytes(6).toString('hex')}`;
    const owner = new Backend({
      url: surrealUrl.replace(/\/+$/, ''),
      namespace,
      admin: {
        user: process.env.RETAINER_SURREAL_USER ?? 'root',
        pass: process.env.RETAINER_SURREAL_PASS ?? 'retainer',
        level: 'root',
      },
      signingKeys: parseSigningKeys({
        current: process.env.RETAINER_BROWSER_SIGNING_KEY ?? generateSigningKeyEntry('browser'),
      }),
    });
    installUpgrader(owner);
    await ensureCatalog(owner);
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
    const writer = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Writer',
        actor: { type: 'user', id: 'writer' },
        scopes: ['read', 'write'],
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
      backend: owner,
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
      await use({
        url,
        keys: { user, writer, agent, reader, other: otherKey },
        request,
        consolidate: () => consolidateWorkspace(owner, workspace.id),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        // Canceled browser requests can leave active sockets open after the
        // assertions finish. Stop accepting first, then close those sockets.
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      await owner.adminNamespace().query(`REMOVE NAMESPACE IF EXISTS ${ident(namespace)};`);
    }
  },
});
export { expect };
