import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';

// What people do from the web app (accounts spec 4.5, 8: API layer): every
// route against every role, and the rules that must hold under concurrency.

const db = useTestDatabase();
let app: AccountsTestApp;

beforeAll(() => {
  app = startAccountsApp(db);
});

type Signed = { cookie: string; userId: string; email: string };

async function person(name: string): Promise<Signed> {
  const email = `${name.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}@acme.test`;
  return { ...(await app.signIn({ email, name })), email };
}

/** An organization with a workspace and one person in each role. */
async function team() {
  const organizationId = (await createOrganization(db.owner, { name: 'Acme' })).id;
  const workspaceId = (
    await createWorkspace(db.owner, {
      name: 'Acme CRM',
      slug: `acme-${Math.random().toString(16).slice(2, 10)}`,
      organization: organizationId,
    })
  ).id;
  const roles = {} as Record<
    'owner' | 'orgAdmin' | 'admin' | 'editor' | 'viewer' | 'member' | 'outsider',
    Signed
  >;
  for (const name of Object.keys({
    owner: 1,
    orgAdmin: 1,
    admin: 1,
    editor: 1,
    viewer: 1,
    member: 1,
    outsider: 1,
  }) as (keyof typeof roles)[]) {
    roles[name] = await person(name);
  }
  const org = (email: string, role: 'owner' | 'admin' | 'member') =>
    setOrganizationMember(db.owner, { organization: organizationId, email, role });
  await org(roles.owner.email, 'owner');
  await org(roles.orgAdmin.email, 'admin');
  for (const r of ['admin', 'editor', 'viewer'] as const) {
    await org(roles[r].email, 'member');
    await setWorkspaceMember(db.owner, { workspace: workspaceId, email: roles[r].email, role: r });
  }
  await org(roles.member.email, 'member');
  return { organizationId, workspaceId, ...roles };
}

const call = (path: string, who: Signed, method = 'GET', body?: unknown) =>
  app.account(path, { cookie: who.cookie, method, body });

describe('creating a workspace', () => {
  it('gives a new person their own organization, as its owner, with a seeded workspace', async () => {
    const ana = await person('Ana');
    const res = await call('/account/workspaces', ana, 'POST', {
      name: 'Sales',
      template: 'sales',
    });
    expect(res.status).toBe(201);
    const workspace = (await res.json()) as { id: string; slug: string; organizationId: string };
    expect(workspace.slug).toMatch(/^sales-[a-z2-9]{4}$/);
    const [membership] = await db.owner`
      select role from organization_members
      where organization_id = ${workspace.organizationId} and user_id = ${ana.userId}`;
    expect(membership).toEqual({ role: 'owner' });
    const objects =
      await db.owner`select name_singular as key from object_types where workspace_id = ${workspace.id}`;
    expect(objects.map((o) => o.key)).toEqual(
      expect.arrayContaining(['company', 'person', 'deal']),
    );

    // They reach it from the API at once, as admin.
    const me = await app.v1('/v1/me', { cookie: ana.cookie, workspace: workspace.id });
    expect(await me.json()).toMatchObject({ scopes: ['read', 'write', 'schema:write', 'admin'] });
  });

  it('makes one organization when two first workspaces are created at once', async () => {
    const ben = await person('Ben');
    const results = await Promise.all([
      call('/account/workspaces', ben, 'POST', { name: 'One' }),
      call('/account/workspaces', ben, 'POST', { name: 'Two' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const orgs =
      await db.owner`select organization_id from organization_members where user_id = ${ben.userId}`;
    expect(orgs).toHaveLength(1);
  });

  it('puts later workspaces in the organization they manage, and refuses plain members', async () => {
    const t = await team();
    const res = await call('/account/workspaces', t.orgAdmin, 'POST', { name: 'Second' });
    expect(((await res.json()) as { organizationId: string }).organizationId).toBe(
      t.organizationId,
    );
    expect((await call('/account/workspaces', t.member, 'POST', { name: 'Mine' })).status).toBe(
      403,
    );
    expect(
      (
        await call('/account/workspaces', t.outsider, 'POST', {
          name: 'Theirs',
          organizationId: t.organizationId,
        })
      ).status,
    ).toBe(404);
  });

  it('rolls back the organization when seeding fails', async () => {
    const cy = await person('Cy');
    const res = await call('/account/workspaces', cy, 'POST', { name: 'X', template: 'no-such' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(
      await db.owner`select 1 from organization_members where user_id = ${cy.userId}`,
    ).toHaveLength(0);
  });
});

describe('who may do what', () => {
  // [route, method, body, roles allowed]; everyone else gets 403, or 404
  // when they have no role at all.
  it('checks every workspace route against every role', async () => {
    const t = await team();
    const ws = `/account/workspaces/${t.workspaceId}`;
    const cases: [string, string, unknown, string[]][] = [
      [ws, 'PATCH', { name: 'Acme CRM' }, ['owner', 'orgAdmin', 'admin']],
      [`${ws}/members`, 'GET', undefined, ['owner', 'orgAdmin', 'admin', 'editor', 'viewer']],
      [
        `${ws}/members/${t.viewer.userId}`,
        'PUT',
        { role: 'viewer' },
        ['owner', 'orgAdmin', 'admin'],
      ],
      [`${ws}/keys`, 'GET', undefined, ['owner', 'orgAdmin', 'admin']],
      [`${ws}/keys`, 'POST', { name: 'Bot', access: 'read' }, ['owner', 'orgAdmin', 'admin']],
    ];
    for (const [path, method, body, allowed] of cases) {
      for (const who of [
        'owner',
        'orgAdmin',
        'admin',
        'editor',
        'viewer',
        'member',
        'outsider',
      ] as const) {
        const res = await call(path, t[who], method, body);
        const expected = allowed.includes(who)
          ? [200, 201, 204]
          : who === 'member' || who === 'outsider'
            ? [404]
            : [403];
        expect(expected, `${method} ${path} as ${who}: ${res.status}`).toContain(res.status);
      }
    }
  });

  it('checks every organization route against every role', async () => {
    const t = await team();
    const org = `/account/organizations/${t.organizationId}`;
    const cases: [string, string, unknown, string[]][] = [
      [org, 'GET', undefined, ['owner', 'orgAdmin']],
      [org, 'PATCH', { name: 'Acme' }, ['owner']],
      [`${org}/members/${t.member.userId}`, 'PATCH', { role: 'member' }, ['owner', 'orgAdmin']],
      [
        `${org}/invitations`,
        'POST',
        { email: 'new@acme.test', role: 'member' },
        ['owner', 'orgAdmin'],
      ],
    ];
    for (const [path, method, body, allowed] of cases) {
      for (const who of [
        'owner',
        'orgAdmin',
        'admin',
        'editor',
        'viewer',
        'member',
        'outsider',
      ] as const) {
        const res = await call(path, t[who], method, body);
        const expected = allowed.includes(who)
          ? [200, 201, 204]
          : who === 'outsider'
            ? [404]
            : [403];
        expect(expected, `${method} ${path} as ${who}: ${res.status}`).toContain(res.status);
      }
    }
  });

  it('refuses every account route without a session or with the CSRF header missing', async () => {
    const t = await team();
    expect((await app.account(`/account/workspaces/${t.workspaceId}/members`)).status).toBe(401);
    const res = await app.accounts.request(`${ORIGIN}/account/workspaces`, {
      method: 'POST',
      headers: { cookie: t.owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No header' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('members', () => {
  it('lists the people with access, including organization admins', async () => {
    const t = await team();
    const res = await call(`/account/workspaces/${t.workspaceId}/members`, t.viewer);
    const body = (await res.json()) as {
      role: string;
      members: { userId: string; role: string }[];
    };
    expect(body.role).toBe('viewer');
    expect((body as unknown as { candidates: unknown[] }).candidates).toEqual([]);
    const asAdmin = (await (
      await call(`/account/workspaces/${t.workspaceId}/members`, t.admin)
    ).json()) as { candidates: { userId: string }[] };
    expect(asAdmin.candidates.map((c) => c.userId)).toEqual([t.member.userId]);
    const byId = Object.fromEntries(body.members.map((m) => [m.userId, m.role]));
    expect(byId).toEqual({
      [t.owner.userId]: 'admin',
      [t.orgAdmin.userId]: 'admin',
      [t.admin.userId]: 'admin',
      [t.editor.userId]: 'editor',
      [t.viewer.userId]: 'viewer',
    });
  });

  it("lets a workspace admin change roles, but not an organization admin's", async () => {
    const t = await team();
    const path = (who: Signed) => `/account/workspaces/${t.workspaceId}/members/${who.userId}`;
    expect((await call(path(t.viewer), t.admin, 'PUT', { role: 'editor' })).status).toBe(204);
    expect((await call(path(t.member), t.admin, 'PUT', { role: 'viewer' })).status).toBe(204);
    expect((await call(path(t.orgAdmin), t.admin, 'PUT', { role: 'viewer' })).status).toBe(409);
    expect((await call(path(t.outsider), t.admin, 'PUT', { role: 'viewer' })).status).toBe(409);
    expect((await call(path(t.viewer), t.admin, 'PUT', { role: 'owner' })).status).toBe(400);

    expect((await call(path(t.editor), t.admin, 'DELETE')).status).toBe(204);
    expect(
      (await app.v1('/v1/me', { cookie: t.editor.cookie, workspace: t.workspaceId })).status,
    ).toBe(404);
  });

  it('keeps an owner, lets only owners manage owners, and removes everywhere at once', async () => {
    const t = await team();
    const org = `/account/organizations/${t.organizationId}/members`;
    expect(
      (await call(`${org}/${t.owner.userId}`, t.owner, 'PATCH', { role: 'admin' })).status,
    ).toBe(409);
    expect((await call(`${org}/${t.owner.userId}`, t.owner, 'DELETE')).status).toBe(409);
    expect((await call(`${org}/${t.owner.userId}`, t.orgAdmin, 'DELETE')).status).toBe(403);
    expect(
      (await call(`${org}/${t.member.userId}`, t.orgAdmin, 'PATCH', { role: 'owner' })).status,
    ).toBe(403);
    expect(
      (await call(`${org}/${t.member.userId}`, t.owner, 'PATCH', { role: 'owner' })).status,
    ).toBe(204);
    expect((await call(`${org}/${t.owner.userId}`, t.owner, 'DELETE')).status).toBe(204);

    expect((await call(`${org}/${t.editor.userId}`, t.orgAdmin, 'DELETE')).status).toBe(204);
    expect(
      (await app.v1('/v1/me', { cookie: t.editor.cookie, workspace: t.workspaceId })).status,
    ).toBe(404);
  });

  it('keeps one owner when two owners demote each other at once', async () => {
    const t = await team();
    const org = `/account/organizations/${t.organizationId}/members`;
    await call(`${org}/${t.orgAdmin.userId}`, t.owner, 'PATCH', { role: 'owner' });
    const results = await Promise.all([
      call(`${org}/${t.owner.userId}`, t.orgAdmin, 'PATCH', { role: 'admin' }),
      call(`${org}/${t.orgAdmin.userId}`, t.owner, 'PATCH', { role: 'admin' }),
    ]);
    // The second finds it is no longer an owner (403), or would leave none (409).
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(204);
    expect([403, 409]).toContain(statuses[1]);
    const owners = await db.owner`
      select 1 from organization_members where organization_id = ${t.organizationId} and role = 'owner'`;
    expect(owners).toHaveLength(1);
  });
});

describe('keys', () => {
  it('creates an agent key that works on the API, lists it with its creator, and revokes it', async () => {
    const t = await team();
    const keys = `/account/workspaces/${t.workspaceId}/keys`;
    const created = await call(keys, t.admin, 'POST', { name: 'Sales Bot', access: 'write' });
    expect(created.status).toBe(201);
    const { id, key, actor, scopes } = (await created.json()) as {
      id: string;
      key: string;
      actor: unknown;
      scopes: string[];
    };
    expect(actor).toEqual({ type: 'agent', id: 'sales-bot', name: 'Sales Bot' });
    expect(scopes).toEqual(['read', 'write']);
    const me = await app.api.request(`${ORIGIN}/v1/me`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(await me.json()).toMatchObject({ workspace: { id: t.workspaceId } });

    const listed = (await (await call(keys, t.admin)).json()) as {
      keys: { id: string; createdBy: { id: string } | null }[];
    };
    expect(listed.keys.find((k) => k.id === id)?.createdBy?.id).toBe(t.admin.userId);
    expect(JSON.stringify(listed)).not.toContain(key);

    expect((await call(`${keys}/${id}`, t.admin, 'DELETE')).status).toBe(204);
    const after = await app.api.request(`${ORIGIN}/v1/me`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(after.status).toBe(401);
  });

  it('refuses unknown access, and a key from another workspace', async () => {
    const t = await team();
    const keys = `/account/workspaces/${t.workspaceId}/keys`;
    expect((await call(keys, t.admin, 'POST', { name: 'X', access: 'admin' })).status).toBe(400);
    const ana = await person('Ana');
    const mine = (await (
      await call('/account/workspaces', ana, 'POST', { name: 'Ana WS' })
    ).json()) as {
      id: string;
    };
    const other = (await (
      await call(`/account/workspaces/${mine.id}/keys`, ana, 'POST', { name: 'K', access: 'read' })
    ).json()) as { id: string };
    expect((await call(`${keys}/${other.id}`, t.admin, 'DELETE')).status).toBe(404);
  });
});

describe('invitations', () => {
  async function invite(t: Awaited<ReturnType<typeof team>>, email: string) {
    const res = await call(
      `/account/organizations/${t.organizationId}/invitations`,
      t.owner,
      'POST',
      {
        email,
        role: 'member',
        workspaces: [{ workspaceId: t.workspaceId, role: 'editor' }],
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; link: string };
    expect(body.link).toMatch(new RegExp(`^${ORIGIN}/app/invite/`));
    return { ...body, token: body.link.split('/').at(-1) as string };
  }

  it('adds the invited person to the organization and workspaces, once', async () => {
    const t = await team();
    const email = `invitee-${Math.random().toString(16).slice(2, 8)}@acme.test`;
    const { token, id } = await invite(t, email.toUpperCase());
    const invitee = await app.signIn({ email, name: 'Invitee' });

    const account = (await (await app.account('/account', { cookie: invitee.cookie })).json()) as {
      invitations: { id: string }[];
    };
    expect(account.invitations.map((i) => i.id)).toEqual([id]);
    const preview = await app.account(`/account/invitations/${token}`, { cookie: invitee.cookie });
    expect(await preview.json()).toMatchObject({ organization: { name: 'Acme' }, forYou: true });

    const accepts = await Promise.all([
      app.account(`/account/invitations/${token}/accept`, {
        cookie: invitee.cookie,
        method: 'POST',
      }),
      app.account(`/account/invitations/${id}/accept`, { cookie: invitee.cookie, method: 'POST' }),
    ]);
    expect(accepts.map((r) => r.status)).toEqual([200, 200]);
    const me = await app.v1('/v1/me', { cookie: invitee.cookie, workspace: t.workspaceId });
    expect(await me.json()).toMatchObject({ scopes: ['read', 'write'] });
    expect(
      await db.owner`select 1 from organization_members where user_id = ${invitee.userId}`,
    ).toHaveLength(1);
  });

  it('refuses someone signed in with another address, and a withdrawn invitation', async () => {
    const t = await team();
    const { token, id } = await invite(t, 'someone@acme.test');
    const wrong = await person('Wrong');
    const res = await app.account(`/account/invitations/${token}/accept`, {
      cookie: wrong.cookie,
      method: 'POST',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringContaining('someone@acme.test') },
    });
    // The ID alone is useless to anyone but the invited address.
    expect(
      (
        await app.account(`/account/invitations/${id}/accept`, {
          cookie: wrong.cookie,
          method: 'POST',
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await call(
          `/account/organizations/${t.organizationId}/invitations/${id}`,
          t.owner,
          'DELETE',
        )
      ).status,
    ).toBe(204);
    const someone = await app.signIn({ email: 'someone@acme.test' });
    expect(
      (
        await app.account(`/account/invitations/${token}/accept`, {
          cookie: someone.cookie,
          method: 'POST',
        })
      ).status,
    ).toBe(404);
  });

  it('lets only an owner invite an owner', async () => {
    const t = await team();
    const path = `/account/organizations/${t.organizationId}/invitations`;
    const body = { email: 'boss@acme.test', role: 'owner' };
    expect((await call(path, t.orgAdmin, 'POST', body)).status).toBe(403);
    expect((await call(path, t.owner, 'POST', body)).status).toBe(201);
  });
});

describe('organizations', () => {
  it('shows members with their workspaces, and deletes only an empty organization', async () => {
    const t = await team();
    const org = `/account/organizations/${t.organizationId}`;
    const described = (await (await call(org, t.orgAdmin)).json()) as {
      members: { userId: string; workspaces: { role: string }[] }[];
    };
    expect(described.members.find((m) => m.userId === t.editor.userId)?.workspaces).toEqual([
      { id: t.workspaceId, name: 'Acme CRM', role: 'editor' },
    ]);
    expect(described.members.find((m) => m.userId === t.member.userId)?.workspaces).toEqual([]);

    expect((await call(org, t.owner, 'DELETE')).status).toBe(409);
    await db.owner`delete from workspaces where id = ${t.workspaceId}`;
    expect((await call(org, t.owner, 'DELETE')).status).toBe(204);
  });
});
