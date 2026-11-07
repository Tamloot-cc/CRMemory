import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../../src/db/client.js';
import { grantViewer } from '../../src/db/viewer.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

// Roles are cluster-wide, so each run uses its own name.
const role = `retainer_viewer_test_${randomBytes(6).toString('hex')}`;
let workspaceA: string;
let workspaceB: string;

async function objectWorkspaces(sql: Sql) {
  const rows = await sql<{ workspace_id: string }[]>`
    select distinct workspace_id from object_types`;
  return rows.map((r) => r.workspace_id);
}

beforeAll(async () => {
  workspaceA = (await createWorkspace(db.owner, { name: 'A', template: 'sales' })).id;
  workspaceB = (await createWorkspace(db.owner, { name: 'B', template: 'sales' })).id;
});

afterAll(async () => {
  await db.owner.unsafe(`drop owned by "${role}"`);
  await db.owner.unsafe(`drop role if exists "${role}"`);
});

describe('grantViewer', () => {
  it('logs in as a role that can neither write nor bypass RLS', async () => {
    const viewer = await grantViewer(db.owner, db.url, { workspace: 'a', role });
    const sql = db.connectUrl(viewer.url);

    const [who] = await sql<{ current_user: string }[]>`select current_user`;
    expect(who?.current_user).toBe(role);
    const [flags] = await db.owner`
      select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = ${role}`;
    expect(flags).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });

    const denied = { code: '42501' };
    await expect(sql`delete from records`).rejects.toMatchObject(denied);
    await expect(sql`update fields set name = 'x'`).rejects.toMatchObject(denied);
    await expect(sql`insert into workspaces (slug, name) values ('c', 'C')`).rejects.toMatchObject(
      denied,
    );
    await expect(sql`select * from api_keys`).rejects.toMatchObject(denied);
  });

  it('shows only the pinned workspace, and re-running moves the pin', async () => {
    const first = await grantViewer(db.owner, db.url, { workspace: workspaceA, role });
    expect(await objectWorkspaces(db.connectUrl(first.url))).toEqual([workspaceA]);

    const second = await grantViewer(db.owner, db.url, { workspace: 'b', role });
    expect(second.password).not.toBe(first.password);
    expect(await objectWorkspaces(db.connectUrl(second.url))).toEqual([workspaceB]);
    await expect(db.connectUrl(first.url)`select 1`).rejects.toMatchObject({ code: '28P01' });
  });

  it('rejects an unknown workspace and an unsafe role name', async () => {
    await expect(grantViewer(db.owner, db.url, { workspace: 'nope', role })).rejects.toThrow(
      'workspace "nope" not found',
    );
    await expect(
      grantViewer(db.owner, db.url, { workspace: 'a', role: 'x"; drop table records; --' }),
    ).rejects.toThrow('invalid role name');
  });
});
