import { describe, expect, it } from 'vitest';
import {
  effectiveWorkspaceRole,
  ORGANIZATION_ROLES,
  WORKSPACE_ROLE_DESCRIPTIONS,
  WORKSPACE_ROLE_SCOPES,
  WORKSPACE_ROLES,
} from './roles.js';

describe('workspace roles', () => {
  it('bundle the existing scopes, each role adding to the one below', () => {
    expect(WORKSPACE_ROLE_SCOPES).toEqual({
      viewer: ['read'],
      editor: ['read', 'write'],
      admin: ['read', 'write', 'schema:write', 'admin'],
    });
    for (let i = 1; i < WORKSPACE_ROLES.length; i++) {
      const lower = WORKSPACE_ROLE_SCOPES[WORKSPACE_ROLES[i - 1] as 'viewer'];
      const higher = WORKSPACE_ROLE_SCOPES[WORKSPACE_ROLES[i] as 'editor'];
      for (const scope of lower) expect(higher).toContain(scope);
    }
  });

  it('are each explained in plain words', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(WORKSPACE_ROLE_DESCRIPTIONS[role]).not.toMatch(/scope|RBAC|tenant/i);
    }
  });
});

describe('effectiveWorkspaceRole', () => {
  it('makes organization owners and admins admin in every workspace', () => {
    for (const workspaceRole of [null, ...WORKSPACE_ROLES]) {
      expect(effectiveWorkspaceRole('owner', workspaceRole)).toBe('admin');
      expect(effectiveWorkspaceRole('admin', workspaceRole)).toBe('admin');
    }
  });

  it('gives members only the role set in the workspace', () => {
    for (const role of WORKSPACE_ROLES) expect(effectiveWorkspaceRole('member', role)).toBe(role);
    expect(effectiveWorkspaceRole('member', null)).toBeNull();
  });

  it('gives no role outside the organization', () => {
    for (const role of [null, ...WORKSPACE_ROLES]) {
      expect(effectiveWorkspaceRole(null, role)).toBeNull();
    }
    expect(ORGANIZATION_ROLES).toEqual(['owner', 'admin', 'member']);
  });
});
