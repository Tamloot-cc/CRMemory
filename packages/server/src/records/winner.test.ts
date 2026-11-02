import { describe, expect, it } from 'vitest';
import {
  compareAssertions,
  pickWinner,
  type RankedAssertion,
  reviewReason,
  sameValue,
} from './winner.js';

const at = (iso: string) => new Date(iso);
let n = 0;
const assertion = (overrides: Partial<RankedAssertion>): RankedAssertion => ({
  id: `0000000${++n}`,
  actorType: 'agent',
  observedAt: at('2026-01-01T00:00:00Z'),
  createdAt: at('2026-01-01T00:00:00Z'),
  status: 'active',
  value: 'x',
  ...overrides,
});

describe('compareAssertions (rule 2.2)', () => {
  it('ranks user > integration > agent > system regardless of time', () => {
    const user = assertion({ actorType: 'user', observedAt: at('2020-01-01T00:00:00Z') });
    const integration = assertion({ actorType: 'integration' });
    const agent = assertion({ actorType: 'agent', observedAt: at('2030-01-01T00:00:00Z') });
    const system = assertion({ actorType: 'system', observedAt: at('2031-01-01T00:00:00Z') });
    expect([system, agent, integration, user].sort(compareAssertions)).toEqual([
      user,
      integration,
      agent,
      system,
    ]);
  });

  it('breaks ties by observed_at, then created_at, then ID', () => {
    const older = assertion({ observedAt: at('2026-01-01T00:00:00Z') });
    const newer = assertion({ observedAt: at('2026-02-01T00:00:00Z') });
    expect(pickWinner([older, newer])).toBe(newer);

    const firstWritten = assertion({ createdAt: at('2026-01-01T00:00:00Z') });
    const laterWritten = assertion({ createdAt: at('2026-01-02T00:00:00Z') });
    expect(pickWinner([laterWritten, firstWritten])).toBe(laterWritten);

    const a = assertion({ id: 'aaaa' });
    const b = assertion({ id: 'bbbb' });
    expect(pickWinner([a, b])).toBe(b);
    expect(pickWinner([b, a])).toBe(b);
  });

  it('an old email cannot overwrite a newer claim at the same precedence', () => {
    const fromLastWeek = assertion({ observedAt: at('2026-10-26T00:00:00Z') });
    const backfilledOldEmail = assertion({
      observedAt: at('2025-03-01T00:00:00Z'),
      createdAt: at('2026-11-02T00:00:00Z'),
    });
    expect(pickWinner([fromLastWeek, backfilledOldEmail])).toBe(fromLastWeek);
  });
});

describe('pickWinner (rule 2.4)', () => {
  it('ignores pending_review and rejected assertions', () => {
    const active = assertion({ actorType: 'agent' });
    expect(
      pickWinner([
        assertion({ actorType: 'user', status: 'pending_review' }),
        assertion({ actorType: 'user', status: 'rejected' }),
        active,
      ]),
    ).toBe(active);
    expect(pickWinner([assertion({ status: 'rejected' })])).toBeUndefined();
  });

  it('lets a superseded assertion win again when it ranks highest', () => {
    const superseded = assertion({ actorType: 'user', status: 'superseded' });
    expect(pickWinner([assertion({}), superseded])).toBe(superseded);
  });
});

describe('reviewReason (rule 2.3)', () => {
  const userWinner = assertion({ actorType: 'user', value: 'CTO' });
  const incoming = (overrides = {}) => ({
    actorType: 'agent' as const,
    value: 'CEO',
    observedAt: at('2026-06-01T00:00:00Z'),
    confidence: 1,
    ...overrides,
  });

  it('holds a newer, different agent value against a user or integration winner', () => {
    expect(reviewReason(incoming(), userWinner, 0.5)).toBe('outranked');
    const integration = assertion({ actorType: 'integration', value: 'CTO' });
    expect(reviewReason(incoming(), integration, 0.5)).toBe('outranked');
  });

  it('lets older or equal agent values simply lose', () => {
    expect(
      reviewReason(incoming({ observedAt: at('2025-01-01T00:00:00Z') }), userWinner, 0.5),
    ).toBe(null);
    expect(reviewReason(incoming({ value: 'CTO' }), userWinner, 0.5)).toBeNull();
  });

  it('does not hold agent values against agent or system winners', () => {
    expect(reviewReason(incoming(), assertion({ actorType: 'agent' }), 0.5)).toBeNull();
    expect(reviewReason(incoming(), assertion({ actorType: 'system' }), 0.5)).toBeNull();
    expect(reviewReason(incoming(), undefined, 0.5)).toBeNull();
  });

  it('holds agent values below the confidence threshold', () => {
    expect(reviewReason(incoming({ confidence: 0.3 }), undefined, 0.5)).toBe('low_confidence');
  });

  it('never holds people or integrations', () => {
    expect(
      reviewReason(incoming({ actorType: 'user', confidence: 0 }), userWinner, 0.5),
    ).toBeNull();
    expect(reviewReason(incoming({ actorType: 'integration' }), userWinner, 0.5)).toBeNull();
  });
});

describe('sameValue', () => {
  it('ignores key order in composite values', () => {
    expect(sameValue({ first: 'Dana', last: 'Levi' }, { last: 'Levi', first: 'Dana' })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
  });
});
