import { describe, expect, it } from 'vitest';
import { resolveParticipants } from './event-links.js';

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const dana = {
  handle: { kind: 'email' as const, value: 'dana@acme.test' },
  recordId: null,
  role: null,
};

describe('resolveParticipants', () => {
  it('matches an email claimed by one live record', () => {
    const records = new Map([[A, { id: A, deleted: false }]]);
    const emails = new Map([['dana@acme.test', { live: [A], deleted: [] }]]);
    expect(resolveParticipants([dana], records, emails)).toEqual([{ recordId: A }]);
  });

  it('judges email claims by the locked records, not the earlier read', () => {
    const emails = new Map([['dana@acme.test', { live: [A], deleted: [] }]]);
    // Deleted after the claims were read.
    expect(resolveParticipants([dana], new Map([[A, { id: A, deleted: true }]]), emails)).toEqual([
      { reason: 'deleted_record' },
    ]);
    // Two claimants, one deleted since: the other is the match.
    const both = new Map([['dana@acme.test', { live: [A, B], deleted: [] }]]);
    expect(
      resolveParticipants(
        [dana],
        new Map([
          [A, { id: A, deleted: true }],
          [B, { id: B, deleted: false }],
        ]),
        both,
      ),
    ).toEqual([{ recordId: B }]);
    // Two claimants merged since: one record, matched as the survivor.
    expect(
      resolveParticipants(
        [dana],
        new Map([
          [A, { id: A, deleted: false }],
          [B, { id: A, deleted: false }],
        ]),
        both,
      ),
    ).toEqual([{ recordId: A }]);
  });
});
