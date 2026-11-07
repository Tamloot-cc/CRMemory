import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { loadConfig } from '../../src/config.js';
import { createRuntimeSql, RUNTIME_ROLE } from '../../src/db/client.js';
import { scramVerifier, setRuntimeLogin } from '../../src/db/runtime-login.js';
import { inWorkspace } from '../../src/db/tx.js';
import { createApiHandler } from '../../src/lambda/api.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

// Credentials (accounts spec 4.9, 8): the API and workers log in as the
// runtime role itself and can never become the owner. The role is
// cluster-wide, so only this file gives it a login, and it takes it away
// again at the end.

const db = useTestDatabase();
const pools: postgres.Sql[] = [];
let ownerRole: string;
let workspaceId: string;

function runtimeUrl(password: string) {
  const url = new URL(db.url);
  url.username = RUNTIME_ROLE;
  url.password = password;
  return url.toString();
}

function connectAs(url: string) {
  const sql = postgres(url, { max: 1, onnotice: false });
  pools.push(sql);
  return sql;
}

const PASSWORD = 'runtime-test-password-1';

beforeAll(async () => {
  [{ ownerRole } = { ownerRole: '' }] = await db.owner<{ ownerRole: string }[]>`
    select current_user as "ownerRole"`;
  workspaceId = (await createWorkspace(db.owner, { name: 'Creds', template: 'sales' })).id;
  await setRuntimeLogin(db.owner, PASSWORD);
});

afterAll(async () => {
  await Promise.all(pools.map((sql) => sql.end()));
  await db.owner.unsafe(`alter role ${RUNTIME_ROLE} nologin password null`);
});

describe('the runtime login', () => {
  it('logs in as the runtime role, with no other role to become', async () => {
    const sql = connectAs(runtimeUrl(PASSWORD));
    const [who] = await sql<{ user: string }[]>`select current_user as user`;
    expect(who?.user).toBe(RUNTIME_ROLE);
    const [flags] = await db.owner`
      select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname = ${RUNTIME_ROLE}`;
    expect(flags).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    const memberships = await db.owner`
      select 1 from pg_auth_members where member = ${RUNTIME_ROLE}::regrole`;
    expect(memberships).toHaveLength(0);
  });

  it('cannot become the owner', async () => {
    const sql = connectAs(runtimeUrl(PASSWORD));
    await expect(sql.unsafe(`set role "${ownerRole}"`)).rejects.toMatchObject({ code: '42501' });
    await expect(sql.unsafe(`set session authorization "${ownerRole}"`)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('cannot change the schema', async () => {
    const sql = connectAs(runtimeUrl(PASSWORD));
    const denied = { code: '42501' };
    await expect(sql`create table public.intruder (id int)`).rejects.toMatchObject(denied);
    await expect(sql`create schema intruder`).rejects.toMatchObject(denied);
    await expect(sql`alter table records add column intruder int`).rejects.toMatchObject(denied);
    await expect(sql`drop table records`).rejects.toMatchObject(denied);
    await expect(sql`alter table records disable row level security`).rejects.toMatchObject(denied);
  });

  it('stays under row-level security and cannot read keys', async () => {
    const sql = connectAs(runtimeUrl(PASSWORD));
    const [none] = await sql<{ count: number }[]>`select count(*)::int as count from object_types`;
    expect(none?.count).toBe(0);
    const [own] = await inWorkspace(
      sql,
      workspaceId,
      (tx) => tx<{ count: number }[]>`select count(*)::int as count from object_types`,
    );
    expect(own?.count).toBeGreaterThan(0);
    await expect(sql`select * from api_keys`).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the old password once a new one is set', async () => {
    await setRuntimeLogin(db.owner, 'runtime-test-password-2');
    await expect(connectAs(runtimeUrl(PASSWORD))`select 1`).rejects.toMatchObject({
      code: '28P01',
    });
    await setRuntimeLogin(db.owner, PASSWORD);
    const [ok] = await connectAs(runtimeUrl(PASSWORD))`select 1 as ok`;
    expect(ok?.ok).toBe(1);
  });

  it('serializes two owners setting it at once', async () => {
    const second = db.connect({ max: 1 });
    await Promise.all([
      setRuntimeLogin(db.owner, PASSWORD),
      setRuntimeLogin(second, PASSWORD),
      setRuntimeLogin(db.owner, PASSWORD),
    ]);
    const [ok] = await connectAs(runtimeUrl(PASSWORD))`select 1 as ok`;
    expect(ok?.ok).toBe(1);
  });

  it('refuses a password it would have to normalize', async () => {
    await expect(setRuntimeLogin(db.owner, 'pass word')).rejects.toThrow('printable ASCII');
    await expect(setRuntimeLogin(db.owner, 'pässword')).rejects.toThrow('printable ASCII');
  });

  it('is not given while the runtime role can become another role', async () => {
    const extra = `retainer_runtime_test_${Math.random().toString(16).slice(2, 10)}`;
    await db.owner.unsafe(`create role ${extra} nologin`);
    try {
      await db.owner.unsafe(`grant ${extra} to ${RUNTIME_ROLE}`);
      await expect(setRuntimeLogin(db.owner, PASSWORD)).rejects.toThrow(
        `${RUNTIME_ROLE} is a member of ${extra}`,
      );
    } finally {
      await db.owner.unsafe(`drop role ${extra}`);
    }
  });
});

describe('functions on separate logins', () => {
  it('migrates with the owner, then serves the API with the runtime login alone', async () => {
    const ops = createOpsHandler(
      loadConfig({
        DATABASE_URL: db.url,
        RETAINER_RUNTIME_DATABASE_URL: runtimeUrl('runtime-test-password-3'),
        LOG_LEVEL: 'error',
      }),
    );
    expect(await ops({ command: 'migrate' })).toMatchObject({ runtimeLogin: true });

    const config = loadConfig({
      RETAINER_RUNTIME_DATABASE_URL: runtimeUrl('runtime-test-password-3'),
      LOG_LEVEL: 'error',
    });
    const sql = createRuntimeSql(config, { max: 1 });
    pools.push(sql);
    const [who] = await sql<{ user: string }[]>`select current_user as user`;
    expect(who?.user).toBe(RUNTIME_ROLE);

    const { key } = await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Agent',
      actor: { type: 'agent', id: 'creds' },
      scopes: ['read'],
    });
    const api = createApiHandler(config, sql);
    const res = await api(
      {
        version: '2.0',
        routeKey: '$default',
        rawPath: '/v1/me',
        rawQueryString: '',
        headers: { host: 'localhost', authorization: `Bearer ${key}` },
        requestContext: {
          http: { method: 'GET', path: '/v1/me', protocol: 'HTTP/1.1', sourceIp: '192.0.2.1' },
          stage: '$default',
        },
        isBase64Encoded: false,
      } as never,
      {} as never,
    );
    expect(res).toMatchObject({ statusCode: 200 });
    await setRuntimeLogin(db.owner, PASSWORD);
  });

  it('cannot run operator commands without the owner URL', async () => {
    const ops = createOpsHandler(
      loadConfig({ RETAINER_RUNTIME_DATABASE_URL: runtimeUrl(PASSWORD), LOG_LEVEL: 'error' }),
    );
    await expect(ops({ command: 'cli', args: ['workspace', 'list'] })).rejects.toThrow(
      'DATABASE_URL is required',
    );
  });
});

describe('scramVerifier', () => {
  it('builds the verifier Postgres stores', () => {
    const salt = Buffer.alloc(16, 1);
    const verifier = scramVerifier('pencil', salt, 4096);
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:AQEBAQEBAQEBAQEBAQEBAQ==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(scramVerifier('pencil', salt, 4096)).toBe(verifier);
  });
});
