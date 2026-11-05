import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { lookupKey } from '../../src/auth/session.js';
import { acquireLease, LeaseHeldError } from '../../src/db/lease.js';
import { ensureCatalog } from '../../src/db/provision.js';
import { logEventFor, remember } from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  forget,
  mergeRecord,
  readRecord,
} from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { createTestBackend, useTestBackend } from '../helpers/backend.js';

/** Completion gates (spec section 11) on the pieces this suite owns. */
const backend = useTestBackend();
const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
let a: string;
let b: string;
const as = (workspaceId: string, actor: Actor = AGENT): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
let n = 0;
const email = () => `gate${++n}@acme.test`;

beforeAll(async () => {
  a = (await createWorkspace(backend, { name: 'Gate A', template: 'sales' })).id;
  b = (await createWorkspace(backend, { name: 'Gate B', template: 'sales' })).id;
});

describe('isolation', () => {
  it('scopes keys, records and runtime sessions to one workspace', async () => {
    const inB = await createRecord(backend, as(b), 'person', { emails: email() });
    await expect(readRecord(backend, as(a), inB.id)).rejects.toMatchObject({ code: 'not_found' });

    // A runtime session's token names its database: switching is refused.
    const db = await backend.workspace(a);
    const route = await backend.route(b);
    const results = await db.raw(`USE DB ${route.database}; SELECT * FROM record_directory;`);
    const leaked = results.some(
      (r) => r.status === 'OK' && Array.isArray(r.result) && r.result.length > 0,
    );
    expect(leaked).toBe(false);

    // Runtime sessions read the catalog; they never write it.
    await backend
      .catalog()
      .raw('UPDATE api_keys SET revoked_at = time::now();')
      .catch(() => undefined);
    const key = await createApiKey(backend, {
      workspace: a,
      name: 'agent',
      actor: AGENT,
      scopes: ['read'],
    });
    await backend.catalog().raw('DELETE api_keys;');
    expect(await lookupKey(backend, key.key)).toMatchObject({ workspaceId: a, actor: AGENT });
    await expect(lookupKey(backend, `${key.key}x`)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('process lease', () => {
  it('refuses a second process while the first holds it', async () => {
    const first = await acquireLease(backend, { holder: 'first' });
    try {
      await expect(acquireLease(backend.another(), { holder: 'second' })).rejects.toBeInstanceOf(
        LeaseHeldError,
      );
    } finally {
      await first.release();
    }
    const next = await acquireLease(backend.another(), { holder: 'second' });
    await next.release();
  });
});

describe('signing-key rotation', () => {
  it('accepts the new key, keeps the old one during rotation, and drops it after', async () => {
    const [oldKey, newKey] = inject('signingKeys') as [string, string];
    const idOf = (entry: string) => entry.slice(0, entry.indexOf(':'));
    // Its own namespace: dropping a key there must not affect other tests.
    const own = await createTestBackend();
    try {
      const workspace = (await createWorkspace(own, { name: 'Rotate' })).id;
      const record = await createRecord(own, as(workspace), 'person', { emails: email() });
      const database = (await own.route(workspace)).database;

      // A process with the new key and the old one as previous: on boot the
      // catalog, on first use the workspace, accept both.
      const rotating = own.another({ keys: [newKey, oldKey] });
      await ensureCatalog(rotating);
      expect((await readRecord(rotating, as(workspace), record.id)).id).toBe(record.id);
      expect((await rotating.route(workspace)).keyId).toBe(idOf(newKey));
      // A session signed with the old key still works during the rotation.
      expect((await readRecord(own, as(workspace), record.id)).id).toBe(record.id);

      // Once the old key is dropped from the configuration, the next boot
      // removes it everywhere, and its tokens are refused.
      const rotated = own.another({ keys: [newKey] });
      await ensureCatalog(rotated);
      await readRecord(rotated, as(workspace), record.id);
      const [info] = (await rotated.adminDb(database).query('INFO FOR DB;')) as [
        { accesses: Record<string, string> },
      ];
      expect(Object.keys(info.accesses)).toEqual([`backend_${idOf(newKey)}`]);
      await expect(
        own.runtimeDb(database, idOf(oldKey)).query('SELECT * FROM record_directory;'),
      ).rejects.toThrow(/401|authentication/);
      await expect(own.catalog().query('SELECT * FROM workspaces;')).rejects.toThrow(
        /401|authentication/,
      );
    } finally {
      await own.drop();
    }
  });
});

describe('competing writes from two processes', () => {
  it('lets one of two concurrent creates claim a unique email', async () => {
    const other = backend.another();
    const shared = email();
    const results = await Promise.allSettled([
      createRecord(backend, as(a), 'person', { emails: shared }),
      createRecord(other, as(a), 'person', { emails: shared }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: 'unique_conflict' });
  });

  it('applies one idempotency key once across processes', async () => {
    const dana = await createRecord(backend, as(a), 'person', { emails: email() });
    const other = backend.another();
    const [x, y] = await Promise.all([
      remember(backend, as(a), dana.id, { text: 'Prefers calls' }, 'same-key'),
      remember(other, as(a), dana.id, { text: 'Prefers calls' }, 'same-key'),
    ]);
    expect(x.fact.id).toBe(y.fact.id);
    const db = await backend.workspace(a);
    const facts = await db.rows('SELECT id FROM facts WHERE record = $r;', { r: dana.id });
    expect(facts).toHaveLength(1);
  });

  it('keeps links on the survivor when a merge races logging', async () => {
    const survivor = await createRecord(backend, as(a), 'person', { emails: email() });
    const merged = await createRecord(backend, as(a), 'person', { emails: email() });
    const other = backend.another();
    const [, logged] = await Promise.all([
      mergeRecord(backend, as(a, USER), survivor.id, { recordId: merged.id }),
      logEventFor(other, as(a), {
        type: 'call',
        channel: 'zoom',
        occurredAt: '2026-10-29T14:00:00Z',
        fields: {},
        participants: [{ recordId: merged.id }],
        about: [],
      }),
    ]);
    const db = await backend.workspace(a);
    const links = await db.rows<{ record: string }>(
      'SELECT record FROM event_links WHERE event = $e;',
      { e: logged.id },
    );
    expect(links.map((l) => l.record)).toEqual([survivor.id]);
    const attachments = await db.rows<{ target: string }>(
      'SELECT target FROM event_attachments WHERE event = $e;',
      { e: logged.id },
    );
    expect(attachments.map((r) => r.target)).toEqual([survivor.id]);
  });

  it('never leaves an erased handle linked when forget races logging', async () => {
    const gone = await createRecord(backend, as(a), 'person', { emails: email() });
    const handle = (gone.record.fields.emails as { primary: string }).primary;
    const other = backend.another();
    await Promise.all([
      forget(backend, as(a, USER), gone.id),
      logEventFor(other, as(a), {
        type: 'call',
        channel: 'zoom',
        occurredAt: '2026-10-29T15:00:00Z',
        fields: {},
        participants: [{ handle }],
        about: [],
      }).catch((error: { code?: string }) => error),
    ]);
    const db = await backend.workspace(a);
    expect(await db.rows('SELECT id FROM event_links WHERE handle = $h;', { h: handle })).toEqual(
      [],
    );
    expect(await db.rows('SELECT id FROM record_directory:[$id];', { id: gone.id })).toEqual([]);
  });
});

describe('query plans', () => {
  const plan = async (statement: string, vars: Record<string, unknown> = {}) => {
    const db = await backend.workspace(a);
    const [text] = await db.rows<string>(`EXPLAIN ${statement}`, vars);
    return String(text);
  };

  it('reads write-path lookups through indexes', async () => {
    expect(await plan("SELECT * FROM field_assertions WHERE refs CONTAINS 'x';")).toMatch(
      /IndexScan.*field_assertions_refs_idx/s,
    );
    expect(
      await plan("SELECT record FROM unique_claims WHERE field_id = 'f' AND value = 'v' LIMIT 1;"),
    ).toMatch(/IndexScan.*unique_claims_uq/s);
    expect(await plan("SELECT * FROM operations WHERE refs CONTAINS 'x';")).toMatch(
      /IndexScan.*operations_refs_idx/s,
    );
    expect(
      await plan(
        "SELECT event FROM event_attachments WHERE target = 'x' ORDER BY occurred_at DESC LIMIT 10;",
      ),
    ).toMatch(/IndexScan.*event_attachments_target_idx/s);
    expect(await plan("SELECT * FROM event_links WHERE handle = 'x';")).toMatch(
      /IndexScan.*event_links_handle_idx/s,
    );
  });
});
