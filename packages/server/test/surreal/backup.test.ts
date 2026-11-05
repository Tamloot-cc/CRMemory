import { randomBytes } from 'node:crypto';
import type { Actor } from '@retainer/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { lookupKey } from '../../src/auth/session.js';
import { Backend } from '../../src/db/backend.js';
import { CATALOG_DATABASE } from '../../src/db/names.js';
import { ensureCatalog } from '../../src/db/provision.js';
import { ident } from '../../src/db/surreal.js';
import { logEventFor } from '../../src/memory/service.js';
import { type Caller, createRecord, forget, readRecord } from '../../src/records/service.js';
import { installUpgrader } from '../../src/workspaces/upgrade.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { testBackendConfig, useTestBackend } from '../helpers/backend.js';

/**
 * Backup and restore (spec section 11): export the catalog and a workspace
 * database with SurrealDB's own export, import both into an empty
 * namespace, and boot a backend on it. Keys, routes, records, uniqueness
 * and erasure suppression must all survive.
 */
const backend = useTestBackend();
const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const restoredNamespace = `rt_test_${randomBytes(6).toString('hex')}`;
const { spareKey: _spare, ...restoredConfig } = testBackendConfig(restoredNamespace);
const basic = `Basic ${Buffer.from(
  `${restoredConfig.admin.user}:${restoredConfig.admin.pass}`,
).toString('base64')}`;

async function exportDatabase(namespace: string, database: string): Promise<string> {
  const response = await fetch(`${restoredConfig.url}/export`, {
    headers: { authorization: basic, 'surreal-ns': namespace, 'surreal-db': database },
  });
  if (!response.ok) throw new Error(`export failed: ${response.status}`);
  return response.text();
}

async function importDatabase(namespace: string, database: string, dump: string): Promise<void> {
  const response = await fetch(`${restoredConfig.url}/import`, {
    method: 'POST',
    headers: {
      authorization: basic,
      'surreal-ns': namespace,
      'surreal-db': database,
      accept: 'application/json',
    },
    body: dump,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`import failed: ${response.status} ${text}`);
}

afterAll(async () => {
  await new Backend(restoredConfig)
    .adminNamespace()
    .query(`REMOVE NAMESPACE IF EXISTS ${ident(restoredNamespace)};`);
});

describe('backup and restore', () => {
  it('restores identities, routes, records and suppression', async () => {
    const workspace = await createWorkspace(backend, { name: 'Backed up', template: 'sales' });
    const caller: Caller = {
      workspaceId: workspace.id,
      actor: AGENT,
      scopes: ['read', 'write'],
    };
    const key = await createApiKey(backend, {
      workspace: workspace.id,
      name: 'agent',
      actor: AGENT,
      scopes: ['read', 'write'],
    });
    const dana = await createRecord(backend, caller, 'person', {
      name: 'Dana Levi',
      emails: 'dana@backup.test',
    });
    const gone = await createRecord(backend, caller, 'person', { emails: 'gone@backup.test' });
    await forget(backend, { ...caller, actor: USER, scopes: ['admin'] }, gone.id);

    const { database } = await backend.route(workspace.id);
    const namespace = backend.config.namespace;
    const [catalogDump, workspaceDump] = await Promise.all([
      exportDatabase(namespace, CATALOG_DATABASE),
      exportDatabase(namespace, database),
    ]);

    const restored = new Backend(restoredConfig);
    installUpgrader(restored);
    await restored
      .adminNamespace()
      .query(`DEFINE NAMESPACE IF NOT EXISTS ${ident(restoredNamespace)};`);
    await importDatabase(restoredNamespace, CATALOG_DATABASE, catalogDump);
    await importDatabase(restoredNamespace, database, workspaceDump);
    // Boot on the restored namespace.
    await ensureCatalog(restored);

    // The API key and its route.
    const restoredCaller = await lookupKey(restored, key.key);
    expect(restoredCaller).toMatchObject({ workspaceId: workspace.id, actor: AGENT });
    // Records, through runtime sessions on the restored databases.
    const read = await readRecord(restored, restoredCaller, dana.id);
    expect(read.fields.emails).toEqual({ primary: 'dana@backup.test', additional: [] });
    // Uniqueness claims.
    await expect(
      createRecord(restored, restoredCaller, 'person', { emails: 'dana@backup.test' }),
    ).rejects.toMatchObject({ code: 'unique_conflict' });
    // Erasure suppression.
    const logged = await logEventFor(restored, restoredCaller, {
      type: 'call',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00Z',
      fields: {},
      participants: [{ handle: 'gone@backup.test' }, { handle: 'dana@backup.test' }],
      about: [],
    });
    expect(logged.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(logged.participants.unmatched).toEqual([
      { id: expect.any(String), handle: null, role: null, reason: 'suppressed' },
    ]);
  });
});
