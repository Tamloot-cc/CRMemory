import type { OrganizationRole, Scope, WorkspaceRole } from '@retainer/shared';

/**
 * /account (accounts spec 4.5): the signed-in person, their organizations,
 * workspaces, members, invitations and keys. Only in accounts mode; in key
 * mode the server answers 404 and the app keeps its key sign-in.
 */

export type AccountWorkspace = { id: string; slug: string; name: string; role: WorkspaceRole };
export type AccountOrganization = {
  id: string;
  name: string;
  role: OrganizationRole;
  workspaces: AccountWorkspace[];
};
export type PendingForYou = {
  id: string;
  organization: string;
  invitedBy: string | null;
  expiresAt: string;
};
export type Account = {
  user: { id: string; name: string; email: string };
  organizations: AccountOrganization[];
  invitations: PendingForYou[];
};

export type Workspace = { id: string; slug: string; name: string; organizationId: string };

export type InvitedWorkspace = { workspaceId: string; role: WorkspaceRole };
export type PendingInvitation = {
  id: string;
  email: string;
  role: OrganizationRole;
  workspaces: InvitedWorkspace[];
  invitedBy: string | null;
  expiresAt: string;
};

export type WorkspaceMember = {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  organizationRole: OrganizationRole;
  joinedAt: string;
};

export type KeyAccess = 'read' | 'write' | 'schema';
export type WorkspaceKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: string;
  revokedAt: string | null;
  createdBy: { id: string; name: string } | null;
};

export type OrganizationDetails = {
  id: string;
  name: string;
  role: OrganizationRole;
  members: {
    userId: string;
    name: string;
    email: string;
    role: OrganizationRole;
    workspaces: { id: string; name: string; role: WorkspaceRole }[];
  }[];
  workspaces: { id: string; slug: string; name: string; members: number }[];
  invitations: PendingInvitation[];
};

export type InvitationPreview = {
  id: string;
  organization: { id: string; name: string };
  role: OrganizationRole;
  invitedBy: string | null;
  email: string;
  workspaces: { id: string; name: string; role: WorkspaceRole }[];
  forYou: boolean;
};

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'X-Retainer-Client': 'web',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new AccountError(response.status, message ?? `The request failed (${response.status}).`);
  }
  return body as T;
}

const ws = (id: string) => `/account/workspaces/${encodeURIComponent(id)}`;
const org = (id: string) => `/account/organizations/${encodeURIComponent(id)}`;

export const account = {
  /** The person; 401 when signed out, 404 in key mode. */
  me: () => call<Account>('/account'),
  createWorkspace: (input: { name: string; template?: string; organizationId?: string }) =>
    call<Workspace>('/account/workspaces', { method: 'POST', body: input }),
  renameWorkspace: (id: string, name: string) =>
    call<Workspace>(ws(id), { method: 'PATCH', body: { name } }),
  members: (id: string) =>
    call<{
      role: WorkspaceRole;
      members: WorkspaceMember[];
      invitations: PendingInvitation[];
      candidates: { userId: string; name: string; email: string }[];
    }>(`${ws(id)}/members`),
  setMemberRole: (id: string, userId: string, role: WorkspaceRole) =>
    call<void>(`${ws(id)}/members/${userId}`, { method: 'PUT', body: { role } }),
  removeMember: (id: string, userId: string) =>
    call<void>(`${ws(id)}/members/${userId}`, { method: 'DELETE' }),
  keys: (id: string) => call<{ keys: WorkspaceKey[] }>(`${ws(id)}/keys`),
  createKey: (id: string, input: { name: string; access: KeyAccess }) =>
    call<WorkspaceKey & { key: string }>(`${ws(id)}/keys`, { method: 'POST', body: input }),
  revokeKey: (id: string, keyId: string) =>
    call<void>(`${ws(id)}/keys/${keyId}`, { method: 'DELETE' }),
  organization: (id: string) => call<OrganizationDetails>(org(id)),
  renameOrganization: (id: string, name: string) =>
    call<void>(org(id), { method: 'PATCH', body: { name } }),
  deleteOrganization: (id: string) => call<void>(org(id), { method: 'DELETE' }),
  setOrganizationRole: (id: string, userId: string, role: OrganizationRole) =>
    call<void>(`${org(id)}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeFromOrganization: (id: string, userId: string) =>
    call<void>(`${org(id)}/members/${userId}`, { method: 'DELETE' }),
  invite: (
    id: string,
    input: { email: string; role: OrganizationRole; workspaces: InvitedWorkspace[] },
  ) =>
    call<{ id: string; link: string; expiresAt: string }>(`${org(id)}/invitations`, {
      method: 'POST',
      body: input,
    }),
  revokeInvitation: (id: string, invitationId: string) =>
    call<void>(`${org(id)}/invitations/${invitationId}`, { method: 'DELETE' }),
  invitation: (tokenOrId: string) =>
    call<InvitationPreview>(`/account/invitations/${encodeURIComponent(tokenOrId)}`),
  acceptInvitation: (tokenOrId: string) =>
    call<{ organizationId: string }>(
      `/account/invitations/${encodeURIComponent(tokenOrId)}/accept`,
      { method: 'POST' },
    ),
};

/** Better Auth's browser client, loaded only in accounts mode. */
export const authClient = () => import('./auth-client.js').then((m) => m.authClient);

/** Ends this session, then starts the app again at the sign-in screen. */
export async function signOutOfAccount(): Promise<void> {
  await (await authClient()).signOut();
  window.location.assign('/app/');
}

/** Where the app opens a workspace: a full page load, so nothing cached crosses over. */
export const workspaceHref = (slug: string, path = '/') => `/app/w/${slug}${path}`;
