import type { FieldView, SavedView } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import {
  andFilter,
  boardGroups,
  changesToSave,
  dayOf,
  effectiveSearch,
  filterParam,
  groupCondition,
  hasChanges,
  monthDays,
  movedTo,
  parseMonth,
  rangeCondition,
  sortParam,
  toggleHidden,
  viewColumns,
  weekStartsOn,
} from './views-state.js';

const field = (name: string, extra: Partial<FieldView> = {}) =>
  ({
    name,
    label: name[0]?.toUpperCase() + name.slice(1),
    type: 'text',
    readOnly: false,
    settings: {},
    isFilterable: true,
    ...extra,
  }) as FieldView;
const stage = field('stage', {
  type: 'select',
  settings: {
    options: [
      { value: 'lead', label: 'Lead' },
      { value: 'won', label: 'Won' },
    ],
  },
});

const view = (extra: Partial<SavedView> = {}) =>
  ({
    id: 'v1',
    object: 'deal',
    name: 'Pipeline',
    kind: 'table',
    visibility: 'workspace',
    position: 1,
    filter: null,
    sort: null,
    columns: null,
    groupBy: null,
    hiddenGroups: [],
    groupAggregate: null,
    dateField: null,
    issues: [],
    ...extra,
  }) as SavedView;

describe('a saved view and the address', () => {
  const saved = view({
    filter: { stage: { eq: 'won' } },
    sort: [{ field: 'name', direction: 'asc' }],
  });

  it("runs the view's filter and sort unless the address has its own", () => {
    expect(effectiveSearch(saved, {})).toEqual({
      filter: '{"stage":{"eq":"won"}}',
      sort: '[{"field":"name","direction":"asc"}]',
    });
    expect(effectiveSearch(saved, { filter: '{"name":{"contains":"a"}}' }).filter).toBe(
      '{"name":{"contains":"a"}}',
    );
    // `{}` and `[]` mean "none" over a view that has some.
    expect(effectiveSearch(saved, { filter: '{}', sort: '[]' })).toEqual({
      filter: undefined,
      sort: undefined,
    });
    expect(effectiveSearch(undefined, {})).toEqual({ filter: undefined, sort: undefined });
  });

  it('writes no override when a change goes back to the saved view', () => {
    expect(filterParam('{"stage":{"eq":"won"}}', saved)).toBeUndefined();
    expect(filterParam('{"stage":{"eq":"lead"}}', saved)).toBe('{"stage":{"eq":"lead"}}');
    expect(filterParam(undefined, saved)).toBe('{}');
    expect(filterParam(undefined, view())).toBeUndefined();
    expect(filterParam('{"x":1}', undefined)).toBe('{"x":1}');
    expect(sortParam('[{"field":"name","direction":"asc"}]', saved)).toBeUndefined();
    expect(sortParam(undefined, saved)).toBe('[]');
    expect(sortParam('[{"field":"name","direction":"desc"}]', saved)).toBe(
      '[{"field":"name","direction":"desc"}]',
    );
  });

  it('notices changes, and compares filters as the chips write them', () => {
    expect(hasChanges(saved, {})).toBe(false);
    expect(hasChanges(undefined, { filter: '{"x":1}' })).toBe(false);
    // The same condition written the long way is not a change.
    expect(hasChanges(saved, { filter: '{"and":[{"stage":{"eq":"won"}}]}' })).toBe(false);
    expect(hasChanges(saved, { filter: '{}' })).toBe(true);
    expect(hasChanges(saved, { sort: '[]' })).toBe(true);
    // An address that isn't JSON is a change, not a crash; the list reports it.
    expect(hasChanges(saved, { filter: '[object Object]' })).toBe(true);
    expect(changesToSave(saved, { filter: 'nope' }).filter).toBeNull();
  });

  it('saves the changes, with null for none', () => {
    expect(changesToSave(saved, { filter: '{}' })).toEqual({
      filter: null,
      sort: [{ field: 'name', direction: 'asc' }],
    });
    expect(changesToSave(saved, { filter: '{"stage":{"eq":"lead"}}', sort: '[]' })).toEqual({
      filter: { stage: { eq: 'lead' } },
      sort: null,
    });
  });

  it("reads a view's columns as column preferences", () => {
    expect(viewColumns(view())).toBeUndefined();
    expect(
      viewColumns(view({ columns: { order: ['stage'], aggregates: { amount: 'sum' } } })),
    ).toEqual({ order: ['stage'], widths: {}, aggregates: { amount: 'sum' } });
  });

  it('ANDs a condition onto a filter that may be absent', () => {
    expect(andFilter(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(andFilter({}, { a: 1 })).toEqual({ a: 1 });
    expect(andFilter({ b: 2 }, { a: 1 })).toEqual({ and: [{ b: 2 }, { a: 1 }] });
  });
});

describe('board columns', () => {
  it("are the field's options now, then no value, then values no longer an option", () => {
    expect(boardGroups(stage, ['lead', 'lost', null]).map((g) => [g.key, g.label])).toEqual([
      ['v:lead', 'Lead'],
      ['v:won', 'Won'],
      ['none', 'No stage'],
      ['v:lost', 'lost'],
    ]);
  });

  it('put a record in a column by its value, or by having none', () => {
    expect(groupCondition(stage, 'won')).toEqual({ stage: { eq: 'won' } });
    expect(groupCondition(stage, null)).toEqual({ stage: { isNull: true } });
  });

  it('hide and show', () => {
    expect(toggleHidden([], null)).toEqual([null]);
    expect(toggleHidden(['won', null], 'won')).toEqual([null]);
  });
});

describe('calendar', () => {
  const date = field('closeDate', { type: 'date' });
  const dateTime = field('startsAt', { type: 'date_time' });

  it('reads the month from the address, or shows this one', () => {
    const today = new Date(2026, 10, 3);
    expect(parseMonth('2026-02', today)).toEqual(new Date(2026, 1, 1));
    expect(parseMonth('soon', today)).toEqual(new Date(2026, 10, 1));
    expect(parseMonth(undefined, today)).toEqual(new Date(2026, 10, 1));
  });

  it('shows whole weeks from the week of the 1st, starting where the viewer does', () => {
    // November 2026 starts on a Sunday and ends on a Monday.
    const sunday = monthDays(new Date(2026, 10, 1), 0);
    expect(sunday).toHaveLength(35);
    expect(sunday[0]).toEqual(new Date(2026, 10, 1));
    expect(sunday.at(-1)).toEqual(new Date(2026, 11, 5));
    const monday = monthDays(new Date(2026, 10, 1), 1);
    expect(monday[0]).toEqual(new Date(2026, 9, 26));
    expect(monday).toHaveLength(42);
    expect(weekStartsOn('en-US')).toBe(0);
    expect(weekStartsOn('en-GB')).toBe(1);
  });

  it('finds records from the first to the last day shown', () => {
    const first = new Date(2026, 10, 1),
      last = new Date(2026, 11, 5);
    expect(rangeCondition(date, first, last)).toEqual({
      closeDate: { gte: '2026-11-01', lte: '2026-12-05' },
    });
    expect(rangeCondition(dateTime, first, last)).toEqual({
      startsAt: { gte: first.toISOString(), lt: new Date(2026, 11, 6).toISOString() },
    });
  });

  it("places a date on its day and a date-time on the viewer's day", () => {
    expect(dayOf(date, '2026-11-03')).toBe('2026-11-03');
    const evening = new Date(2026, 10, 3, 23, 30);
    expect(dayOf(dateTime, evening.toISOString())).toBe('2026-11-03');
    expect(dayOf(date, null)).toBeUndefined();
    expect(dayOf(dateTime, 'not a date')).toBeUndefined();
  });

  it('moves a date to the day, and a date-time to the day at the same time', () => {
    expect(movedTo(date, '2026-11-03', '2026-11-20')).toBe('2026-11-20');
    const from = new Date(2026, 10, 3, 9, 30);
    expect(movedTo(dateTime, from.toISOString(), '2026-11-20')).toBe(
      new Date(2026, 10, 20, 9, 30).toISOString(),
    );
  });
});
