import { createHash, randomUUID } from 'node:crypto';
import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { lookupKey } from '../../src/auth/session.js';
import type { Db } from '../../src/db/backend.js';
import { RecordId } from '../../src/db/cbor.js';
import { CATALOG_TABLES, WORKSPACE_TABLES } from '../../src/db/definitions.js';
import { publicId } from '../../src/db/names.js';
import { readWorkspace } from '../../src/db/protocol.js';
import { logEventFor } from '../../src/memory/service.js';
import { type Caller, createRecord, forget } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * The PostgreSQL suite checked roles, row-level security and tenant foreign
 * keys. On SurrealDB the boundary is one database per workspace, reached by
 * record-access tokens bound to it, with a read-only catalog (spec section 4).
 * Each case below states the guarantee that replaced its PostgreSQL one.
 */
const backend = useTestBackend();

let workspaceA: string;
let workspaceB: string;

const databaseOf = async (workspaceId: string) => (await backend.route(workspaceId)).database;
const adminOf = async (workspaceId: string) => backend.adminDb(await databaseOf(workspaceId));
const tablesOf = async (db: Db) => {
  const [info] = (await db.query('INFO FOR DB;')) as [
    { tables: Record<string, string>; analyzers: Record<string, string> },
  ];
  return info;
};
/** Statement results of a raw request, without failing on refused statements. */
const statuses = async (db: Db, text: string, vars?: Record<string, unknown>) =>
  (await db.raw(text, vars)).map((r) => r.status);

beforeAll(async () => {
  workspaceA = (await createWorkspace(backend, { name: 'A', slug: 'a' })).id;
  workspaceB = (await createWorkspace(backend, { name: 'B', slug: 'b' })).id;
});

describe('extensions', () => {
  // pg_trgm and btree_gin are replaced by the workspace database's search analyzers (spec section 8).
  it('has the prefix, exact-word and trigram analyzers', async () => {
    const info = await tablesOf(await adminOf(workspaceA));
    expect(Object.keys(info.analyzers).sort()).toEqual(['rt_exact', 'rt_prefix', 'rt_trigram']);
  });
});

describe('roles', () => {
  // The non-owner runtime role is replaced by record-access sessions, which are refused definitions.
  it('runs the app as a record-access session that defines nothing and cannot switch databases', async () => {
    for (const db of [await backend.workspace(workspaceA), backend.catalog()]) {
      for (const statement of ['INFO FOR DB;', 'DEFINE TABLE intruder;', 'REMOVE TABLE jobs;']) {
        await expect(db.query(statement), statement).rejects.toThrow(/permission/i);
      }
    }
    // Nothing was removed, and the administrative session still sees every table.
    const info = await tablesOf(await adminOf(workspaceA));
    expect(Object.keys(info.tables)).toContain('jobs');
    expect(Object.keys(info.tables)).not.toContain('intruder');
  });

  // Databases are STRICT: a write never defines a table it names (spec section 13).
  it('refuses writes that would define a table implicitly', async () => {
    for (const db of [await backend.workspace(workspaceA), backend.catalog()]) {
      for (const statement of [
        'CREATE intruder:x SET a = 1;',
        'INSERT INTO intruder { id: "y" };',
        'RELATE record_directory:a->r_intruder->record_directory:b;',
      ]) {
        await expect(db.query(statement), statement).rejects.toThrow(/does not exist|permission/i);
      }
    }
    for (const db of [await adminOf(workspaceA), backend.adminCatalog()]) {
      const tables = Object.keys((await tablesOf(db)).tables);
      expect(tables).not.toContain('intruder');
      expect(tables).not.toContain('r_intruder');
    }
  });
});

describe('one database per workspace', () => {
  // Row-level security is replaced by one database per workspace: tenant tables never share one.
  it('keeps every tenant table in the workspace database and none in the catalog', async () => {
    const workspaceTables = Object.keys((await tablesOf(await adminOf(workspaceA))).tables);
    for (const table of WORKSPACE_TABLES.map((t) => t.name)) {
      expect(workspaceTables, table).toContain(table);
    }
    const catalogTables = Object.keys((await tablesOf(backend.adminCatalog())).tables).sort();
    expect(catalogTables).toEqual(CATALOG_TABLES.map((t) => t.name).sort());
    // The catalog is read-only for runtime sessions, except the process lease.
    for (const table of CATALOG_TABLES) {
      if (table.name === 'process_lease') continue;
      expect(table.permissions, table.name).toBe(
        'FOR select FULL, FOR create, update, delete NONE',
      );
    }
  });

  it('shows a runtime session only the workspace its token names', async () => {
    const now = new Date();
    await (await adminOf(workspaceA)).query(
      "CREATE suppressions CONTENT { kind: 'email', hmac: 'a-1', created_at: $now };",
      { now },
    );
    await (await adminOf(workspaceB)).query(
      "CREATE suppressions CONTENT { kind: 'email', hmac: 'b-1', created_at: $now };",
      { now },
    );

    const a = await backend.workspace(workspaceA);
    const seenByA = await a.rows<{ hmac: string }>('SELECT hmac FROM suppressions;');
    expect(seenByA.map((r) => r.hmac)).toEqual(['a-1']);

    // Workspace routes live in the catalog, not beside the tenant data.
    expect(await a.rows('SELECT id FROM workspaces;')).toEqual([]);

    // Outside a workspace database nothing is visible.
    expect(await backend.catalog().rows('SELECT * FROM suppressions;')).toEqual([]);
  });

  it('rejects writes into another workspace', async () => {
    const a = await backend.workspace(workspaceA);
    const results = await statuses(
      a,
      `USE DB ${await databaseOf(workspaceB)}; CREATE suppressions CONTENT { kind: 'email', hmac: 'x', created_at: time::now() };`,
    );
    expect(results[0]).toBe('ERR');
    const seenByB = await (await adminOf(workspaceB)).rows<{ hmac: string }>(
      'SELECT hmac FROM suppressions;',
    );
    expect(seenByB.map((r) => r.hmac)).toEqual(['b-1']);
  });

  it('does not let a database switch leak into the next request', async () => {
    // One handle, so the second request carries the same token as the first.
    const a = await backend.workspace(workspaceA);
    await statuses(a, `USE DB ${await databaseOf(workspaceB)};`);
    const seen = await a.rows<{ hmac: string }>('SELECT hmac FROM suppressions;');
    expect(seen.map((r) => r.hmac)).not.toContain('b-1');
    expect(a.target.database).toBe(await databaseOf(workspaceA));
  });
});

let workspaces = 0;
/** A workspace with a schema, one event and one entity record, for the event tables. */
async function workspaceWithEvent() {
  const id = (await createWorkspace(backend, { name: `Events ${++workspaces}`, template: 'sales' }))
    .id;
  const caller: Caller = {
    workspaceId: id,
    actor: { type: 'agent', id: 'inbox' } satisfies Actor,
    scopes: ['read', 'write'],
  };
  const event = await logEventFor(backend, caller, {
    type: 'note',
    channel: 'api',
    externalId: 'security-1',
    occurredAt: '2026-10-01T10:00:00Z',
    summary: 'hello',
    fields: {},
    participants: [],
    about: [],
  });
  const person = await createRecord(backend, caller, 'person', { emails: 'dana@acme.com' });
  const tables = await readWorkspace(backend, id, async ({ schema }) => {
    const compiled = await schema();
    return {
      note: compiled.objectsByName.get('note')?.table as string,
      person: compiled.objectsByName.get('person')?.table as string,
    };
  });
  return { id, caller, eventId: event.id, personId: person.id, tables };
}

describe('tenant references', () => {
  // Tenant foreign keys are replaced by enforced edges: an endpoint must exist in this database.
  it('rejects a reference to a row in another workspace', async () => {
    const other = await workspaceWithEvent();
    const own = await workspaceWithEvent();
    const edge = (from: RecordId, to: RecordId) =>
      adminOf(own.id).then((db) =>
        db.query(
          "RELATE $from->event_attachments->$to CONTENT { event: $event, target: $target, via: 'participant', event_type: 'note', occurred_at: time::now() } RETURN id;",
          { from, to, event: String(from.id), target: String(to.id) },
        ),
      );
    // Base event types share universal IDs, so the table exists here; the row does not.
    await expect(
      edge(
        new RecordId(other.tables.note, other.eventId),
        new RecordId(own.tables.person, own.personId),
      ),
    ).rejects.toThrow(/does not exist/);
    await expect(
      edge(
        new RecordId(own.tables.note, own.eventId),
        new RecordId(other.tables.person, other.personId),
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('event records', () => {
  // Row-level security on event rows is replaced by one database per workspace.
  it('shows a runtime session only its own event rows and tombstones', async () => {
    const one = await workspaceWithEvent();
    const two = await workspaceWithEvent();
    for (const [ws, hmac] of [
      [one.id, 'one-1'],
      [two.id, 'two-1'],
    ] as const) {
      await (await adminOf(ws)).query(
        "CREATE event_identity_tombstones CONTENT { key_id: 'k', hmac: $hmac, created_at: time::now() };",
        { hmac },
      );
    }
    const db = await backend.workspace(one.id);
    const events = await db.rows<{ id: RecordId }>('SELECT id FROM event_identity;');
    const tombstones = await db.rows<{ hmac: string }>(
      'SELECT hmac FROM event_identity_tombstones;',
    );
    expect(events.map((r) => publicId(r.id))).toEqual([one.eventId]);
    expect(tombstones.map((r) => r.hmac)).toEqual(['one-1']);
    const results = await statuses(
      db,
      `USE DB ${await databaseOf(two.id)}; CREATE event_identity_tombstones CONTENT { key_id: 'k', hmac: 'x', created_at: time::now() };`,
    );
    expect(results[0]).toBe('ERR');
    const inTwo = await (await adminOf(two.id)).rows<{ hmac: string }>(
      'SELECT hmac FROM event_identity_tombstones;',
    );
    expect(inTwo.map((r) => r.hmac)).toEqual(['two-1']);
  });

  // No per-table rule protects tombstones (spec section 4 grants FULL); the
  // write protocol is their only writer, and an erased identity stays refused.
  it('never lets a later write change or remove a tombstone', async () => {
    const ws = await workspaceWithEvent();
    const user: Caller = { ...ws.caller, actor: { type: 'user', id: 'dana' } };
    await forget(backend, user, ws.eventId);
    const db = await backend.workspace(ws.id);
    const kept = await db.rows<{ hmac: string }>('SELECT hmac FROM event_identity_tombstones;');
    expect(kept).toHaveLength(1);
    const relog = {
      type: 'note',
      channel: 'api',
      externalId: 'security-1',
      occurredAt: '2026-10-01T10:00:00Z',
      summary: 'hello',
      fields: {},
      participants: [],
      about: [],
    };
    await expect(logEventFor(backend, ws.caller, relog)).rejects.toMatchObject({
      code: 'event_retracted',
    });
    await logEventFor(backend, ws.caller, { ...relog, externalId: 'security-2' });
    await forget(backend, user, ws.personId);
    expect(await db.rows('SELECT hmac FROM event_identity_tombstones;')).toEqual(
      expect.arrayContaining(kept),
    );
    await expect(logEventFor(backend, ws.caller, relog)).rejects.toMatchObject({
      code: 'event_retracted',
    });
  });

  // The event-column check constraints are replaced by `event_identity`, written once by log_event.
  it('gives event identity only to event records, and keeps it immutable', async () => {
    const ws = await workspaceWithEvent();
    const db = await backend.workspace(ws.id);
    const identity = (id: string) =>
      db.rows<{ channel?: string; external_id?: string }>('SELECT channel, external_id FROM $id;', {
        id: new RecordId('event_identity', id),
      });
    expect(await identity(ws.personId)).toEqual([]);
    expect(await identity(ws.eventId)).toEqual([{ channel: 'api', external_id: 'security-1' }]);
    // The same identity with another time is a different event, never an edit.
    await expect(
      logEventFor(backend, ws.caller, {
        type: 'note',
        channel: 'api',
        externalId: 'security-1',
        occurredAt: '2026-10-02T10:00:00Z',
        summary: 'hello',
        fields: {},
        participants: [],
        about: [],
      }),
    ).rejects.toMatchObject({ code: 'event_conflict' });
    expect(await identity(ws.eventId)).toEqual([{ channel: 'api', external_id: 'security-1' }]);
  });

  // The commit-time constraint is replaced by the write path: only log_event creates event records.
  it('refuses an event record without its event identity', async () => {
    const ws = await workspaceWithEvent();
    await expect(
      createRecord(backend, ws.caller, 'note', { title: 'No identity' }),
    ).rejects.toMatchObject({ code: 'use_log_event' });
    const db = await backend.workspace(ws.id);
    const notes = await db.rows<{ id: RecordId }>(
      'SELECT id FROM record_directory WHERE is_event = true;',
    );
    expect(notes.map((r) => publicId(r.id))).toEqual([ws.eventId]);
  });
});

describe('API-key lookup', () => {
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');

  beforeAll(async () => {
    const keys = [
      { name: 'live', prefix: 'rtn_live', key: 'live-key', actor: { type: 'agent', id: 'bot' } },
      {
        name: 'revoked',
        prefix: 'rtn_revk',
        key: 'revoked-key',
        actor: { type: 'agent', id: 'old' },
      },
    ];
    for (const { key, ...row } of keys) {
      await backend.adminCatalog().query('CREATE $id CONTENT $content;', {
        id: new RecordId('api_keys', randomUUID()),
        content: {
          ...row,
          workspace: workspaceA,
          hash: hash(key),
          scopes: ['read'],
          created_at: new Date(),
          ...(row.name === 'revoked' ? { revoked_at: new Date() } : {}),
        },
      });
    }
  });

  // Denied table access is replaced by a read-only catalog: runtime writes to api_keys have no effect.
  it('denies the runtime session any change to api_keys', async () => {
    const before = await backend.adminCatalog().rows('SELECT * FROM api_keys ORDER BY id;');
    const catalog = backend.catalog();
    await catalog.raw(
      `UPDATE api_keys SET revoked_at = NONE, scopes = ['admin'];
       DELETE api_keys;
       CREATE api_keys CONTENT { workspace: $ws, name: 'minted', prefix: 'rtn_mint', hash: $hash, scopes: ['admin'], actor: { type: 'user', id: 'x' }, created_at: time::now() };`,
      { ws: workspaceA, hash: hash('minted-key') },
    );
    expect(await backend.adminCatalog().rows('SELECT * FROM api_keys ORDER BY id;')).toEqual(
      before,
    );
    await expect(lookupKey(backend, 'minted-key')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('returns workspace, scopes and actor for a live key', async () => {
    expect(await lookupKey(backend, 'live-key')).toEqual({
      workspaceId: workspaceA,
      scopes: ['read'],
      actor: { type: 'agent', id: 'bot' },
    });
  });

  it('returns nothing for revoked or unknown keys', async () => {
    await expect(lookupKey(backend, 'revoked-key')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(lookupKey(backend, 'nope')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  // EXECUTE grants are replaced by token signing: only a session signed with a configured key reads the catalog.
  it('is readable only through a session the server signed', async () => {
    const [, unconfigured] = inject('signingKeys') as [string, string];
    const stranger = backend.another({ keys: [unconfigured] });
    await expect(
      stranger.catalog().query('SELECT * FROM api_keys WHERE hash = $hash;', {
        hash: hash('live-key'),
      }),
    ).rejects.toThrow(/401|authentication/i);
    await expect(lookupKey(stranger, 'live-key')).rejects.toThrow(/401|authentication/i);
  });
});
