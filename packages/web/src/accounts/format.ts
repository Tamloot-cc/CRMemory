import {
  KEY_ACCESS,
  type KeyAccess,
  keyAccessOf,
  ORGANIZATION_ROLE_DESCRIPTIONS,
  ORGANIZATION_ROLES,
  type OrganizationRole,
  type Scope,
  WORKSPACE_ROLE_DESCRIPTIONS,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '@retainer/shared';

/** Plain words for roles, keys and dates on the accounts screens (accounts spec 5.1). */

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export const shortDate = (value: string | Date) =>
  new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const description = (role: WorkspaceRole | OrganizationRole, kind: 'workspace' | 'organization') =>
  kind === 'workspace'
    ? WORKSPACE_ROLE_DESCRIPTIONS[role as WorkspaceRole]
    : ORGANIZATION_ROLE_DESCRIPTIONS[role as OrganizationRole];

/** "Editor: can also add and change records, comment and review". */
export const roleWords = (
  role: WorkspaceRole | OrganizationRole,
  kind: 'workspace' | 'organization' = 'workspace',
) => `${capital(role)}: ${lower(description(role, kind))}`;

/** Every role of a kind explained, one sentence each, for under a table. */
export const roleLegend = (kind: 'workspace' | 'organization') =>
  (kind === 'workspace' ? WORKSPACE_ROLES : [...ORGANIZATION_ROLES])
    .map((role) => `${roleWords(role, kind)}.`)
    .join(' ');

export const WORKSPACE_ROLE_OPTIONS = WORKSPACE_ROLES.map((role) => ({
  value: role,
  label: capital(role),
  hint: WORKSPACE_ROLE_DESCRIPTIONS[role],
}));

/** Organization roles to choose from; only owners make owners. */
export const organizationRoleOptions = (canMakeOwners: boolean) =>
  [...ORGANIZATION_ROLES]
    .reverse()
    .filter((role) => canMakeOwners || role !== 'owner')
    .map((role) => ({
      value: role,
      label: capital(role),
      hint: ORGANIZATION_ROLE_DESCRIPTIONS[role],
    }));

const KEY_ACCESS_WORDS: Record<KeyAccess, string> = {
  read: 'Read only',
  write: 'Read and write',
  schema: 'Read, write and change structure',
};

export const KEY_ACCESS_OPTIONS = (Object.keys(KEY_ACCESS) as KeyAccess[]).map((value) => ({
  value,
  label: KEY_ACCESS_WORDS[value],
}));

export const keyAccessWords = (scopes: readonly Scope[]) => KEY_ACCESS_WORDS[keyAccessOf(scopes)];
