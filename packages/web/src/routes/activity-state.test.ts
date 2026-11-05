import { describe, expect, it } from 'vitest';
import {
  dayHeading,
  feedQuery,
  feedSearch,
  filterCount,
  groupByDay,
  parseFeedSearch,
  rangeText,
} from './activity-state.js';

/** Local midnight of a day, as the feed computes it, in ISO. */
const midnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();
const at = (y: number, m: number, d: number, h = 12) => ({
  event: { occurredAt: new Date(y, m - 1, d, h).toISOString() },
});

describe('feed filters in the address', () => {
  it('reads types, source, days and a linked record, ignoring malformed parts', () => {
    expect(
      parseFeedSearch({
        eventTypes: 'conversation, note,conversation,,',
        channel: '  gmail ',
        from: '2026-11-01',
        to: '2026-02-30',
        linked: ' 0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607 ',
      }),
    ).toEqual({
      types: ['conversation', 'note'],
      channel: 'gmail',
      from: '2026-11-01',
      linked: '0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607',
    });
    expect(parseFeedSearch({ channel: '   ', from: 'yesterday' })).toEqual({ types: [] });
    // A linked value that is not a record ID would fail the whole query; it is dropped.
    expect(parseFeedSearch({ linked: 'acme' })).toEqual({ types: [] });
  });

  it('writes them back, clearing what is unset', () => {
    const filters = { types: ['note'], channel: 'web', to: '2026-11-05' };
    expect(feedSearch(filters)).toEqual({
      eventTypes: 'note',
      channel: 'web',
      from: undefined,
      to: '2026-11-05',
      linked: undefined,
    });
    expect(parseFeedSearch(feedSearch(filters))).toEqual(filters);
    expect(feedSearch({ types: [] }).eventTypes).toBeUndefined();
  });

  it('counts a date range and a type list once each', () => {
    expect(filterCount({ types: [] })).toBe(0);
    expect(
      filterCount({ types: ['a', 'b'], from: '2026-11-01', to: '2026-11-02', linked: 'r' }),
    ).toBe(3);
  });

  it('says a range in words', () => {
    expect(rangeText('2026-11-01', undefined)).toMatch(/^from /);
    expect(rangeText(undefined, '2026-11-05')).toMatch(/^until /);
    expect(rangeText('2026-11-01', '2026-11-05')).toContain(' – ');
    expect(rangeText('2026-11-01', '2026-11-01')).not.toContain('–');
  });
});

describe('the feed query', () => {
  it('reads every type newest first, with labels for the records it names', () => {
    expect(feedQuery({ types: [] })).toEqual({
      limit: 30,
      sort: [{ field: 'occurredAt', direction: 'desc' }],
      include: ['relationReferences'],
    });
  });

  it('filters one type with eq and several with in', () => {
    expect(feedQuery({ types: ['note'] }).filter).toEqual({ type: { eq: 'note' } });
    expect(feedQuery({ types: ['note', 'conversation'] }).filter).toEqual({
      type: { in: ['note', 'conversation'] },
    });
  });

  it('runs a day range from local midnight to local midnight after the last day', () => {
    expect(
      feedQuery({ types: [], channel: 'zoom', from: '2026-11-01', to: '2026-11-05' }).filter,
    ).toEqual({
      and: [
        { channel: { eq: 'zoom' } },
        { occurredAt: { gte: midnight(2026, 11, 1) } },
        { occurredAt: { lt: midnight(2026, 11, 6) } },
      ],
    });
  });

  it('finds the events attached to one record', () => {
    expect(feedQuery({ types: [], linked: 'c1' }).linked).toEqual({ record: 'c1' });
  });
});

describe('grouping by day', () => {
  const now = new Date(2026, 10, 5, 15);

  it('names today and yesterday, and dates the rest, with the year only when it differs', () => {
    expect(dayHeading('2026-11-05', now)).toBe('Today');
    expect(dayHeading('2026-11-04', now)).toBe('Yesterday');
    const earlier = dayHeading('2026-11-01', now);
    expect(earlier).not.toMatch(/Today|Yesterday|2026/);
    expect(dayHeading('2025-11-01', now)).toContain('2025');
  });

  it('keeps the feed’s order and puts each event on its local day', () => {
    const groups = groupByDay(
      [at(2026, 11, 5, 14), at(2026, 11, 5, 9), at(2026, 11, 4, 23), at(2026, 10, 30)],
      now,
    );
    expect(groups.map((g) => [g.heading, g.events.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [dayHeading('2026-10-30', now), 1],
    ]);
    expect(groups[0]?.day).toBe('2026-11-05');
  });

  it('adds a later page’s events to a day already shown', () => {
    const groups = groupByDay([at(2026, 11, 5, 14), at(2026, 11, 4), at(2026, 11, 5, 8)], now);
    expect(groups.map((g) => g.events.length)).toEqual([2, 1]);
  });
});
