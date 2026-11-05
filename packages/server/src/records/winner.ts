import { ACTOR_PRECEDENCE, type ActorType } from '@retainer/shared';
import type { AssertionStatus, ReviewReason } from '../db/types.js';

/** The parts of an assertion the winner rules look at. */
export type RankedAssertion = {
  id: string;
  actorType: ActorType;
  observedAt: Date;
  createdAt: Date;
  status: AssertionStatus;
  value: unknown;
};

/**
 * Orders two assertions for one field (rule 2.2): higher actor precedence,
 * then later `observed_at`, then later server `created_at`, then the larger
 * ID as a deterministic tie-breaker. Negative when `a` wins.
 */
export function compareAssertions(a: RankedAssertion, b: RankedAssertion): number {
  return (
    ACTOR_PRECEDENCE[b.actorType] - ACTOR_PRECEDENCE[a.actorType] ||
    b.observedAt.getTime() - a.observedAt.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

const isEligible = (a: RankedAssertion) => a.status === 'active' || a.status === 'superseded';

/**
 * The winner among `active` and `superseded` assertions (rule 2.4);
 * `pending_review` and `rejected` never count.
 */
export function pickWinner<T extends RankedAssertion>(assertions: readonly T[]): T | undefined {
  return assertions.filter(isEligible).sort(compareAssertions)[0];
}

/** JSON with sorted keys, so equal values compare equal regardless of key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sameValue = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

export type IncomingAssertion = {
  actorType: ActorType;
  value: unknown;
  observedAt: Date;
  confidence: number;
};

/**
 * Whether a new assertion waits for review (rule 2.3). Agents never
 * silently overwrite people: an agent value that differs from a winning
 * user or integration value, and is newer, goes to review instead of being
 * superseded. Agent values below the workspace's confidence threshold wait
 * too. Everything else enters the normal ranking.
 */
export function reviewReason(
  incoming: IncomingAssertion,
  winner: RankedAssertion | undefined,
  confidenceThreshold: number,
): ReviewReason | null {
  if (incoming.actorType !== 'agent') return null;
  if (incoming.confidence < confidenceThreshold) return 'low_confidence';
  if (
    winner &&
    ACTOR_PRECEDENCE[winner.actorType] > ACTOR_PRECEDENCE.agent &&
    incoming.observedAt.getTime() > winner.observedAt.getTime() &&
    !sameValue(incoming.value, winner.value)
  ) {
    return 'outranked';
  }
  return null;
}
