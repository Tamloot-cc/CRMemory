import type { OrganizationRole, WorkspaceRole } from '@retainer/shared';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { requireWebHeader } from '../auth/session.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { errorResponse, toAppError } from '../http/response.js';
import { type Auth, CLIENT_IP_HEADER } from './auth.js';

/**
 * /account (accounts spec 4.5): Better Auth's routes, and the routes people
 * use to manage their account, organizations, workspaces, members and keys.
 * They take a session cookie only and are never reachable with an API key,
 * so an agent's key can never create a key, add a member or create a
 * workspace (ARCHITECTURE.md 7.1).
 */

export type Person = { id: string; name: string; email: string };

export type AccountsEnv = {
  Bindings: Record<string, unknown>;
  Variables: { person: Person };
};

export type AccountsDeps = {
  auth: Auth;
  /** A connection as the control role. */
  sql: Sql;
  publicOrigin: string;
  /** The client's address, from the connection or API Gateway, never a header. */
  clientIp: (c: Context) => string | undefined;
};

export function createAccountsApp(deps: AccountsDeps) {
  const app = new Hono<AccountsEnv>();
  app.onError((error, c) => errorResponse(c, toAppError(error)));
  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)),
  );

  app.on(['GET', 'POST'], '/account/auth/*', async (c) => {
    // Better Auth trusts only this header for the client's address, so a
    // value the client sent is replaced, never passed on.
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    const ip = deps.clientIp(c);
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    return deps.auth.handler(new Request(c.req.raw, { headers }));
  });

  const account = new Hono<AccountsEnv>();
  account.use('*', signedIn(deps));
  account.get('/', async (c) => c.json(await describeAccount(deps.sql, c.get('person'))));
  app.route('/account', account);
  return app;
}

/**
 * Requires a signed-in person who is not disabled, and the web app's CSRF
 * header on anything that changes data. An API key is refused outright.
 */
function signedIn(deps: AccountsDeps) {
  return createMiddleware<AccountsEnv>(async (c, next) => {
    if (c.req.header('authorization') !== undefined) {
      throw new AppError(
        403,
        'forbidden',
        'account routes take a signed-in person, not an API key or token',
      );
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireWebHeader(c, deps.publicOrigin);
    const found = await deps.auth.getSession(c.req.raw.headers);
    if (!found) throw new AppError(401, 'unauthorized', 'sign in first');
    const [user] = await deps.sql<{ disabled: boolean }[]>`
      select disabled_at is not null as disabled from users where id = ${found.user.id}`;
    if (!user || user.disabled) throw new AppError(401, 'unauthorized', 'sign in first');
    c.set('person', { id: found.user.id, name: found.user.name, email: found.user.email });
    c.header('Cache-Control', 'no-store');
    await next();
  });
}

export type AccountWorkspace = {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
};

export type AccountOrganization = {
  id: string;
  name: string;
  role: OrganizationRole;
  workspaces: AccountWorkspace[];
};

export type AccountDescription = {
  user: Person;
  organizations: AccountOrganization[];
};

/**
 * The person, their organizations and the workspaces they can reach in each,
 * with their effective role (4.3). A workspace being deleted is left out.
 */
export async function describeAccount(sql: Sql, person: Person): Promise<AccountDescription> {
  const rows = await sql<
    {
      organization_id: string;
      organization_name: string;
      organization_role: OrganizationRole;
      workspace_id: string | null;
      slug: string | null;
      workspace_name: string | null;
      workspace_role: WorkspaceRole | null;
    }[]
  >`
    select o.id as organization_id, o.name as organization_name,
      om.role as organization_role,
      w.id as workspace_id, w.slug, w.name as workspace_name,
      case when om.role in ('owner', 'admin') then 'admin' else wm.role end as workspace_role
    from organization_members om
    join organizations o on o.id = om.organization_id
    left join workspaces w
      on w.organization_id = o.id and w.deletion_scheduled_at is null
    left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = om.user_id
    where om.user_id = ${person.id}
    order by o.created_at, o.id, w.name, w.id`;
  const organizations = new Map<string, AccountOrganization>();
  for (const row of rows) {
    let organization = organizations.get(row.organization_id);
    if (!organization) {
      organization = {
        id: row.organization_id,
        name: row.organization_name,
        role: row.organization_role,
        workspaces: [],
      };
      organizations.set(row.organization_id, organization);
    }
    if (row.workspace_id && row.slug && row.workspace_name && row.workspace_role) {
      organization.workspaces.push({
        id: row.workspace_id,
        slug: row.slug,
        name: row.workspace_name,
        role: row.workspace_role,
      });
    }
  }
  return { user: person, organizations: [...organizations.values()] };
}
