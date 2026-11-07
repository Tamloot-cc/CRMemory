import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifySessionCookie } from '../../src/auth/account-session.js';
import { createApiKey } from '../../src/auth/keys.js';
import {
  createOrganization,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import {
  type AccountsTestApp,
  AUTH_SECRET,
  ORIGIN,
  startAccountsApp,
} from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';

// Signing in and the API's session check (accounts spec 4.4, 8: API and
// Contract layers). Sessions come from Better Auth's real endpoints.

const db = useTestDatabase();
let app: AccountsTestApp;
let organizationId: string;
let workspaceId: string;
let otherWorkspaceId: string;

beforeAll(async () => {
  app = startAccountsApp(db);
  organizationId = (await createOrganization(db.owner, { name: 'Acme' })).id;
  workspaceId = (
    await createWorkspace(db.owner, {
      name: 'Acme CRM',
      template: 'sales',
      organization: organizationId,
    })
  ).id;
  otherWorkspaceId = (await createWorkspace(db.owner, { name: 'Elsewhere' })).id;
});

/** A person in Acme with `role` in its workspace. */
async function member(
  role: 'viewer' | 'editor' | 'admin',
  email = `${role}-${Math.random().toString(16).slice(2, 8)}@acme.test`,
) {
  const signedIn = await app.signIn({ email, name: `Dana ${role}` });
  await setOrganizationMember(db.owner, { organization: organizationId, email, role: 'member' });
  await setWorkspaceMember(db.owner, { workspace: workspaceId, email, role });
  return { ...signedIn, email };
}

describe('signing in with Google', () => {
  it('creates the person once, keyed by Google subject, with a lowercase email', async () => {
    const first = await app.signIn({ sub: 'google-sub-1', email: 'Mixed.Case@Example.TEST' });
    const again = await app.signIn({ sub: 'google-sub-1', email: 'Mixed.Case@Example.TEST' });
    expect(again.userId).toBe(first.userId);
    const [user] =
      await db.owner`select email, email_verified from users where id = ${first.userId}`;
    expect(user).toEqual({ email: 'mixed.case@example.test', email_verified: true });
    const [link] =
      await db.owner`select provider_id, account_id from auth_accounts where user_id = ${first.userId}`;
    expect(link).toEqual({ provider_id: 'google', account_id: 'google-sub-1' });
  });

  it('makes one person when the same first sign-in arrives twice at once', async () => {
    const profile = { sub: 'google-race', email: 'race@example.test' };
    const results = await Promise.allSettled([app.signIn(profile), app.signIn(profile)]);
    const signedIn = results.filter((r) => r.status === 'fulfilled');
    expect(signedIn.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(String(r.reason)).not.toContain('500');
    }
    expect(await db.owner`select 1 from users where email = 'race@example.test'`).toHaveLength(1);
  });

  it('refuses an address Google has not verified', async () => {
    await expect(
      app.signIn({ email: 'unverified@example.test', email_verified: false }),
    ).rejects.toThrow('sign-in failed');
    expect(
      await db.owner`select 1 from users where email = 'unverified@example.test'`,
    ).toHaveLength(0);
  });

  it('sets a Strict, HTTP-only session cookie', async () => {
    const res = await app.accounts.request(`${ORIGIN}/account/auth/sign-in/social`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        idToken: {
          token: JSON.stringify({ sub: 'cookie-sub', email: 'cookie@example.test', name: 'C' }),
        },
      }),
    });
    const cookie = res.headers.getSetCookie().find((c) => c.includes('.session_token='));
    expect(cookie).toMatch(/^retainer\.session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('refuses a disabled person a new session', async () => {
    await app.signIn({ sub: 'disabled-sub', email: 'disabled@example.test' });
    await db.owner`update users set disabled_at = now() where email = 'disabled@example.test'`;
    await expect(
      app.signIn({ sub: 'disabled-sub', email: 'disabled@example.test' }),
    ).rejects.toThrow('sign-in failed');
  });
});

describe('the API checking a session', () => {
  it('passes a real Better Auth cookie, with the person as the actor (contract)', async () => {
    const dana = await member('editor');
    const res = await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspace: { id: workspaceId },
      actor: { type: 'user', id: dana.userId, name: 'Dana editor' },
      scopes: ['read', 'write'],
    });
    // The format the API relies on: <token>.<base64 HMAC-SHA256>.
    const value = decodeURIComponent(dana.cookie.split('=').slice(1).join('='));
    expect(verifySessionCookie(value, AUTH_SECRET)).toMatch(/^\S+$/);
  });

  it('answers 404 for a workspace the person has no role in, existing or not', async () => {
    const dana = await member('viewer');
    for (const workspace of [otherWorkspaceId, '00000000-0000-4000-8000-000000000000']) {
      const res = await app.v1('/v1/me', { cookie: dana.cookie, workspace });
      expect(res.status, workspace).toBe(404);
    }
  });

  it('needs the workspace header, as an ID', async () => {
    const dana = await member('viewer');
    expect((await app.v1('/v1/me', { cookie: dana.cookie })).status).toBe(400);
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: 'acme-crm' })).status).toBe(
      400,
    );
  });

  it('refuses a forged cookie and a raw token without its signature', async () => {
    const dana = await member('viewer');
    const value = decodeURIComponent(dana.cookie.split('=').slice(1).join('='));
    const token = value.slice(0, value.lastIndexOf('.'));
    const forged = `${token}.${createHmac('sha256', 'not-the-secret-0123456789abcdef01').update(token).digest('base64')}`;
    for (const cookie of [
      `retainer.session_token=${encodeURIComponent(forged)}`,
      `retainer.session_token=${encodeURIComponent(token)}`,
    ]) {
      const res = await app.v1('/v1/me', { cookie, workspace: workspaceId });
      expect(res.status).toBe(401);
    }
  });

  it('applies a downgrade, a removal and a sign-out at the next request', async () => {
    const dana = await member('editor');
    const write = () =>
      app.v1('/v1/objects/company/records', {
        cookie: dana.cookie,
        workspace: workspaceId,
        method: 'POST',
        body: { values: { name: 'Initech' } },
      });
    expect((await write()).status).toBe(201);

    await setWorkspaceMember(db.owner, {
      workspace: workspaceId,
      email: dana.email,
      role: 'viewer',
    });
    const denied = await write();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { message: expect.stringContaining('Your role in this workspace lets you look') },
    });

    await db.owner`delete from workspace_members where user_id = ${dana.userId}`;
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId })).status).toBe(
      404,
    );

    await setWorkspaceMember(db.owner, {
      workspace: workspaceId,
      email: dana.email,
      role: 'viewer',
    });
    await db.owner`delete from sessions where user_id = ${dana.userId}`;
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId })).status).toBe(
      401,
    );
  });

  it("ends a disabled person's access at their next request", async () => {
    const dana = await member('viewer');
    await db.owner`update users set disabled_at = now() where id = ${dana.userId}`;
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId })).status).toBe(
      401,
    );
    expect((await app.account('/account', { cookie: dana.cookie })).status).toBe(401);
  });

  it('makes organization owners and admins admin in every workspace', async () => {
    const olga = await app.signIn({ email: 'olga@acme.test', name: 'Olga' });
    await setOrganizationMember(db.owner, {
      organization: organizationId,
      email: 'olga@acme.test',
      role: 'admin',
    });
    const res = await app.v1('/v1/me', { cookie: olga.cookie, workspace: workspaceId });
    expect(await res.json()).toMatchObject({ scopes: ['read', 'write', 'schema:write', 'admin'] });
  });

  it('still requires the web header on cookie mutations', async () => {
    const dana = await member('editor');
    const res = await app.api.request(`${ORIGIN}/v1/objects/company/records`, {
      method: 'POST',
      headers: {
        cookie: dana.cookie,
        'x-retainer-workspace': workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ values: { name: 'No header' } }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a bearer request that names another workspace', async () => {
    const { key } = await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Agent',
      actor: { type: 'agent', id: 'sign-in-test' },
      scopes: ['read'],
    });
    const headers = { authorization: `Bearer ${key}` };
    expect((await app.api.request(`${ORIGIN}/v1/me`, { headers })).status).toBe(200);
    const mismatch = await app.api.request(`${ORIGIN}/v1/me`, {
      headers: { ...headers, 'x-retainer-workspace': otherWorkspaceId },
    });
    expect(mismatch.status).toBe(400);
  });

  it('has no key-mode sign-in in accounts mode', async () => {
    const res = await app.api.request(`${ORIGIN}/auth/session`, {
      method: 'POST',
      headers: { 'x-retainer-client': 'web', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'rtn_anything' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('/account', () => {
  it('refuses an API key', async () => {
    const { key } = await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Admin agent',
      actor: { type: 'agent', id: 'admin-agent' },
      scopes: ['admin'],
    });
    const res = await app.accounts.request(`${ORIGIN}/account`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });

  it('needs a session', async () => {
    expect((await app.account('/account')).status).toBe(401);
  });

  it("lists the person's organizations and the workspaces they can reach, with roles", async () => {
    const dana = await member('viewer', 'dana.lists@acme.test');
    await createWorkspace(db.owner, { name: 'Acme Hidden', organization: organizationId });
    const res = await app.account('/account', { cookie: dana.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: dana.userId, name: 'Dana viewer', email: 'dana.lists@acme.test' },
      organizations: [
        {
          id: organizationId,
          name: 'Acme',
          role: 'member',
          workspaces: [{ id: workspaceId, slug: 'acme-crm', name: 'Acme CRM', role: 'viewer' }],
        },
      ],
    });
  });
});
