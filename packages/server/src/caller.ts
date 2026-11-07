import type { Actor } from '@retainer/shared';
import type { ApiKeyScope } from './db/schema.js';

/** Who is making a request: taken from the API key, never from the payload. */
export type Caller = {
  workspaceId: string;
  actor: Actor;
  scopes: readonly ApiKeyScope[];
};

/** Only a `user` actor with `admin` scope is a human approval (3). */
export function canApproveDestructive(actor: Actor, scopes: readonly ApiKeyScope[]): boolean {
  return actor.type === 'user' && scopes.includes('admin');
}
