import { createContext, useContext } from 'react';
import type { Account, AccountOrganization, AccountWorkspace } from '../api/account.js';

/**
 * Accounts mode inside a workspace: the person, and the workspace and
 * organization the page is in. Null in key mode, where none of this exists.
 */
export type AccountState = {
  account: Account;
  workspace: AccountWorkspace;
  organization: AccountOrganization;
};

export const AccountContext = createContext<AccountState | null>(null);

export const useAccount = () => useContext(AccountContext);

/** Every workspace the person can reach, across their organizations. */
export const allWorkspaces = (account: Account) =>
  account.organizations.flatMap((organization) =>
    organization.workspaces.map((workspace) => ({ workspace, organization })),
  );

const LAST_WORKSPACE = 'retainer:workspace';

export function rememberWorkspace(slug: string) {
  try {
    localStorage.setItem(LAST_WORKSPACE, slug);
  } catch {
    /* Only a convenience: the first workspace opens instead. */
  }
}

export function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE);
  } catch {
    return null;
  }
}

/** Organizations where the person may create workspaces and invite people. */
export const managed = (account: Account) =>
  account.organizations.filter((o) => o.role === 'owner' || o.role === 'admin');
