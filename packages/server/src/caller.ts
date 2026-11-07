import type { Actor } from '@retainer/shared';
import type { ApiKeyScope } from './db/schema.js';

/**
 * Who is making a request: taken from the credential (an API key, or a
 * person's session in accounts mode), never from the payload.
 */
export type Caller = {
  workspaceId: string;
  actor: Actor;
  scopes: readonly ApiKeyScope[];
  /** The signed-in person, in accounts mode. */
  userId?: string;
};

/** Only a `user` actor with `admin` scope is a human approval (3). */
export function canApproveDestructive(actor: Actor, scopes: readonly ApiKeyScope[]): boolean {
  return actor.type === 'user' && scopes.includes('admin');
}
