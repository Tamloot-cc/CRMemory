import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

const TENANT_TABLES = [
  'object_types',
  'fields',
  'schema_changes',
  'records',
  'record_links',
  'record_identifiers',
  'interactions',
  'interaction_participants',
  'field_assertions',
  'facts',
  'fact_sources',
  'merge_suggestions',
  'idempotency_keys',
  'suppressions',
  'deletion_audit_log',
  'views',
];

let app: Sql;
let workspaceA: string;
let workspaceB: string;

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE });
  const rows = await db.owner<{ id: string }[]>`
    insert into workspaces (slug, name) values ('a', 'A'), ('b', 'B') returning id`;
  [workspaceA, workspaceB] = rows.map((r) => r.id) as [string, string];
});

describe('extensions', () => {
  it('has pg_trgm and btree_gin', async () => {
    const rows = await db.owner<{ extname: string }[]>`
      select extname from pg_extension where extname in ('pg_trgm', 'btree_gin') order by extname`;
    expect(rows.map((r) => r.extname)).toEqual(['btree_gin', 'pg_trgm']);
  });
});

describe('roles', () => {
  it('runs the app as a role that owns nothing and cannot bypass RLS', async () => {
    const [who] = await app<{ current_user: string }[]>`select current_user`;
    expect(who?.current_user).toBe(RUNTIME_ROLE);

    const [role] = await db.owner<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = ${RUNTIME_ROLE}`;
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });

    const owned = await db.owner`
      select tablename from pg_tables where schemaname = 'public' and tableowner = ${RUNTIME_ROLE}`;
    expect(owned).toHaveLength(0);
  });
});

describe('row-level security', () => {
  it('is enabled with a workspace policy on every tenant table', async () => {
    const rows = await db.owner<{ tablename: string; rowsecurity: boolean; policies: number }[]>`
      select t.tablename, t.rowsecurity,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = t.tablename) as policies
      from pg_tables t where t.schemaname = 'public'`;
    const byTable = new Map(rows.map((r) => [r.tablename, r]));
    for (const table of [...TENANT_TABLES, 'workspaces']) {
      expect(byTable.get(table), table).toMatchObject({ rowsecurity: true, policies: 1 });
    }
    // Every table with a workspace_id column is covered.
    const withWorkspace = await db.owner<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'workspace_id'`;
    for (const { table_name } of withWorkspace) {
      expect(byTable.get(table_name)?.rowsecurity, table_name).toBe(true);
    }
  });

  it('shows the runtime role only the workspace of the transaction', async () => {
    await db.owner`
      insert into suppressions (workspace_id, kind, hmac)
      values (${workspaceA}, 'email', 'a-1'), (${workspaceB}, 'email', 'b-1')`;

    const seenByA = await inWorkspace(app, workspaceA, (tx) => tx`select hmac from suppressions`);
    expect(seenByA.map((r) => r.hmac)).toEqual(['a-1']);

    const workspacesSeenByA = await inWorkspace(
      app,
      workspaceA,
      (tx) => tx`select id from workspaces`,
    );
    expect(workspacesSeenByA.map((r) => r.id)).toEqual([workspaceA]);

    // Outside a workspace transaction nothing is visible.
    expect(await app`select * from suppressions`).toHaveLength(0);
  });

  it('rejects writes into another workspace', async () => {
    await expect(
      inWorkspace(
        app,
        workspaceA,
        (tx) =>
          tx`insert into suppressions (workspace_id, kind, hmac) values (${workspaceB}, 'email', 'x')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not let the setting leak past the transaction', async () => {
    // One connection, so the second query runs where the transaction ran.
    const single = db.connect({ role: RUNTIME_ROLE, max: 1 });
    await inWorkspace(single, workspaceA, (tx) => tx`select 1`);
    expect(await single`select * from suppressions`).toHaveLength(0);
  });
});

describe('tenant foreign keys', () => {
  it('rejects a reference to a row in another workspace', async () => {
    const [interaction] = await db.owner<{ id: string }[]>`
      insert into interactions (workspace_id, kind, channel, occurred_at, summary, created_by)
      values (${workspaceB}, 'note', 'api', now(), 'hello',
        ${db.owner.json({ type: 'system', id: 'test' })})
      returning id`;
    await expect(
      db.owner`
        insert into interaction_participants (workspace_id, interaction_id, position, handle)
        values (${workspaceA}, ${interaction?.id ?? ''}, 0, 'dana@acme.com')`,
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('API-key lookup', () => {
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');

  beforeAll(async () => {
    await db.owner`
      insert into api_keys (workspace_id, name, prefix, hash, scopes, actor, revoked_at) values
        (${workspaceA}, 'live', 'rtn_live', ${hash('live-key')}, ${['read']},
          ${db.owner.json({ type: 'agent', id: 'bot' })}, null),
        (${workspaceA}, 'revoked', 'rtn_revk', ${hash('revoked-key')}, ${['read']},
          ${db.owner.json({ type: 'agent', id: 'old' })}, now())`;
  });

  it('denies the runtime role direct access to api_keys', async () => {
    await expect(app`select * from api_keys`).rejects.toMatchObject({ code: '42501' });
  });

  it('returns workspace, scopes and actor for a live key', async () => {
    const rows = await app`select * from retainer_lookup_api_key(${hash('live-key')})`;
    expect(rows).toEqual([
      {
        key_id: expect.any(String),
        workspace_id: workspaceA,
        scopes: ['read'],
        actor: { type: 'agent', id: 'bot' },
      },
    ]);
  });

  it('returns nothing for revoked or unknown keys', async () => {
    expect(await app`select * from retainer_lookup_api_key(${hash('revoked-key')})`).toHaveLength(
      0,
    );
    expect(await app`select * from retainer_lookup_api_key(${hash('nope')})`).toHaveLength(0);
  });

  it('is executable only by the runtime role', async () => {
    const grantees = await db.owner<{ grantee: string }[]>`
      select a.grantee::regrole::text as grantee
      from pg_proc p, aclexplode(p.proacl) a
      where p.proname = 'retainer_lookup_api_key' and a.privilege_type = 'EXECUTE'`;
    const names = grantees.map((g) => g.grantee);
    expect(names).toContain(RUNTIME_ROLE);
    expect(names).not.toContain('-'); // PUBLIC (grantee 0) shows as "-"
  });
});
