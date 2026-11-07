import type { Scope } from './api.js';

/**
 * Roles for people in accounts mode (docs/specs/accounts-and-access.md 4.3).
 * A workspace role is a named bundle of the existing scopes, so routes keep
 * checking scopes. The server and the web app read this one definition.
 */

export const WORKSPACE_ROLES = ['viewer', 'editor', 'admin'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const WORKSPACE_ROLE_SCOPES: Record<WorkspaceRole, readonly Scope[]> = {
  viewer: ['read'],
  editor: ['read', 'write'],
  admin: ['read', 'write', 'schema:write', 'admin'],
};

/** Plain words for each role, shown wherever a role is (5.1). */
export const WORKSPACE_ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  viewer: 'Can see everything in this workspace',
  editor: 'Can also add and change records, comment and review',
  admin:
    "Can also change the workspace's structure, erase personal data, and manage people and agents",
};

export const ORGANIZATION_ROLE_DESCRIPTIONS: Record<OrganizationRole, string> = {
  owner: 'Admin in every workspace, and manages the organization and its owners',
  admin: 'Admin in every workspace, creates workspaces and invites people',
  member: 'Only the workspaces they are added to, with the role set there',
};

/**
 * A person's role in a workspace: admin for organization owners and admins,
 * otherwise their role in the workspace, otherwise none.
 */
export function effectiveWorkspaceRole(
  organizationRole: OrganizationRole | null,
  workspaceRole: WorkspaceRole | null,
): WorkspaceRole | null {
  if (organizationRole === 'owner' || organizationRole === 'admin') return 'admin';
  if (organizationRole === null) return null;
  return workspaceRole;
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly unknown[]).includes(value);
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly unknown[]).includes(value);
}
