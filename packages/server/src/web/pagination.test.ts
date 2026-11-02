import { describe, expect, it } from 'vitest';
import { cursorValue, encodeCursor, page } from './pagination.js';

const id = '10000000-0000-4000-8000-000000000001';
describe('keyset cursors', () => {
  it('preserves database timestamp microseconds and ties by ID', () => {
    const stamp = '2026-11-02 10:00:00.123456+00';
    expect(cursorValue(encodeCursor(stamp, id))).toEqual([stamp, id]);
    expect(
      page(
        [
          { id, stamp },
          { id: '20000000-0000-4000-8000-000000000002', stamp },
        ],
        1,
      ).nextCursor,
    ).toBe(encodeCursor(stamp, id));
  });
  it('rejects malformed values before SQL receives them', () => {
    for (const raw of [
      'invalid',
      Buffer.from(JSON.stringify(['1', id])).toString('base64url'),
      Buffer.from(JSON.stringify(['2026-11-02 10:00:00+00', 'not-an-id'])).toString('base64url'),
    ])
      expect(() => cursorValue(raw)).toThrow('nextCursor');
  });
});
