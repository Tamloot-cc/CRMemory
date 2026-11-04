import type {
  FieldView,
  ObjectView,
  SchemaDescription,
  Session,
  TimelineItem,
  TimelinePage,
} from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import {
  groupByDay,
  parseTimelineFilters,
  RecordTimeline,
  type TimelineSearch,
  timelineParams,
  timelineSearch,
} from './record-timeline.js';

// Links need a router; plain anchors are enough to find them by name.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const base = {
  description: null,
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'workspace',
  isProtected: false,
} as const;
const stage: FieldView = {
  ...base,
  type: 'select',
  name: 'stage',
  label: 'Stage',
  settings: {
    options: [
      { value: 'new', label: 'New' },
      { value: 'won', label: 'Won' },
    ],
  },
};
const owner: FieldView = {
  ...base,
  type: 'relation',
  name: 'owner',
  label: 'Account owner',
  settings: { targetObject: 'person', relationCardinality: 'many_to_one', rollUpEvents: true },
};
const people: FieldView = {
  ...base,
  type: 'relation',
  name: 'people',
  label: 'People',
  settings: { targetObject: 'person', inverseField: 'company', isInverse: true },
};
const company = {
  nameSingular: 'company',
  labelSingular: 'Company',
  class: 'entity',
  fields: [stage, owner, people],
} as unknown as ObjectView;
const person = {
  nameSingular: 'person',
  labelSingular: 'Person',
  class: 'entity',
  fields: [
    {
      ...owner,
      name: 'employer',
      label: 'Employer',
      settings: { targetObject: 'company', rollUpEvents: true },
    },
  ],
} as unknown as ObjectView;
const meeting = {
  nameSingular: 'meeting',
  labelSingular: 'Meeting',
  class: 'event',
  fields: [],
} as unknown as ObjectView;
const call = {
  nameSingular: 'call',
  labelSingular: 'Call',
  class: 'event',
  fields: [],
} as unknown as ObjectView;

const A = '10000000-0000-4000-8000-00000000000a';
const event: TimelineItem = {
  kind: 'event',
  id: 'e1',
  // Close to noon UTC, so it falls on the same local day as the claim below in any time zone.
  at: '2026-11-03T12:30:00.000Z',
  type: 'meeting',
  title: 'Renewal call',
  summary: 'Agreed on a two-year term.',
  via: { kind: 'rollup', field: 'employer', record: 'p1' },
};
const lostClaim: TimelineItem = {
  kind: 'field_change',
  id: 'a1',
  at: '2026-11-03T12:00:00.000Z',
  field: 'stage',
  value: 'won',
  status: 'superseded',
  current: false,
  actor: { type: 'agent', id: 'scout', name: 'Scout' },
  confidence: 0.6,
  source: { id: 'e1', type: 'meeting', title: 'Renewal call', occurredAt: event.at },
};
const ownerSet: TimelineItem = {
  kind: 'field_change',
  id: 'a2',
  at: '2026-11-02T12:00:00.000Z',
  field: 'owner',
  value: A,
  status: 'active',
  current: true,
  actor: { type: 'user', id: 'maayan', name: 'Maayan' },
  confidence: 1,
  source: null,
  relationReferences: { [A]: { id: A, object: 'person', label: 'Avi Cohen' } },
};
const fact: TimelineItem = {
  kind: 'fact',
  id: 'f1',
  at: '2026-11-01T12:00:00.000Z',
  content: 'Prefers quarterly invoicing',
  factKind: 'stated',
  status: 'superseded',
  validTo: null,
  writtenBy: { type: 'agent', id: 'scout', name: 'Scout' },
  sources: [
    { event: 'e1', quote: 'quarterly works best' },
    { event: null, internal: true, quote: null },
  ],
};
const page = (items: TimelineItem[], nextCursor: string | null = null): TimelinePage => ({
  record: 'c1',
  items,
  nextCursor,
});

/** The timeline with its filters in local state, standing in for the URL. */
function Harness({ initial = {} }: { initial?: TimelineSearch }) {
  const [search, setSearch] = useState(initial);
  return (
    <RecordTimeline
      recordId="c1"
      object={company}
      search={search}
      onSearchChange={(change) => setSearch((prev) => ({ ...prev, ...change }))}
    />
  );
}
function renderTimeline(initial?: TimelineSearch) {
  const workspace = {
    session: { workspace: { id: 'w1' } } as unknown as Session,
    schema: { objects: [company, person, meeting, call] } as unknown as SchemaDescription,
  };
  // Record labels are fetched per link; answer them without a server.
  vi.spyOn(api, 'record').mockResolvedValue({
    id: 'p1',
    object: 'person',
    label: 'Dana Levi',
  } as never);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider value={workspace}>
        <Harness initial={initial} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('timeline filters', () => {
  const filters = (kind: string | undefined, fields = '', eventTypes = '') =>
    parseTimelineFilters({ kind, fields, eventTypes });

  it('sends no types for all, so a lone field or event-type filter narrows as the server says', () => {
    expect(timelineParams(filters(undefined))).toEqual({});
    expect(timelineParams(filters(undefined, 'stage'))).toEqual({ fields: ['stage'] });
    expect(timelineParams(filters(undefined, '', 'meeting,call'))).toEqual({
      eventTypes: ['meeting', 'call'],
    });
    expect(timelineParams(filters(undefined, 'stage', 'call'))).toEqual({
      fields: ['stage'],
      eventTypes: ['call'],
    });
  });

  it('sends types whenever one kind is chosen, without filters for kinds it leaves out', () => {
    expect(timelineParams(filters('event', 'stage', 'call'))).toEqual({
      types: ['event'],
      eventTypes: ['call'],
    });
    expect(timelineParams(filters('field_change', 'stage,owner', 'call'))).toEqual({
      types: ['field_change'],
      fields: ['stage', 'owner'],
    });
    expect(timelineParams(filters('fact', 'stage', 'call'))).toEqual({ types: ['fact'] });
  });

  it('reads an unknown kind as all and writes all as no parameter', () => {
    expect(parseTimelineFilters({ kind: 'bogus' })).toEqual({
      kind: 'all',
      fields: [],
      eventTypes: [],
    });
    expect(timelineSearch({ kind: 'all', fields: [], eventTypes: [] })).toEqual({
      kind: undefined,
      fields: undefined,
      eventTypes: undefined,
    });
    expect(timelineSearch({ kind: 'event', fields: [], eventTypes: ['call', 'meeting'] })).toEqual({
      kind: 'event',
      fields: undefined,
      eventTypes: 'call,meeting',
    });
  });

  it('groups items by local day in the order given', () => {
    const groups = groupByDay([event, lostClaim, ownerSet, fact]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['e1', 'a1'], ['a2'], ['f1']]);
  });
});

describe('RecordTimeline', () => {
  it('shows events, field changes and facts with their provenance', async () => {
    const timeline = vi
      .spyOn(api, 'timeline')
      .mockResolvedValue(page([event, lostClaim, ownerSet, fact]));
    renderTimeline();
    expect(await screen.findByRole('link', { name: 'Renewal call' })).toBeTruthy();
    expect(timeline).toHaveBeenCalledWith('c1', { cursor: undefined, signal: expect.anything() });

    // Event: type, title link, summary and a rollup sentence naming the source record.
    expect(screen.getAllByText('Meeting').length).toBeGreaterThan(0);
    expect(screen.getByText('Agreed on a two-year term.')).toBeTruthy();
    expect(screen.getByText('Rolled up via Employer of')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Dana Levi' })).toBeTruthy();

    // A claim that isn't the current value says so, and implies no diff.
    const lost = screen.getByText('Stage set to').closest('li') as HTMLElement;
    expect(within(lost).getByText('Won')).toBeTruthy();
    expect(within(lost).getByText('Not the current value')).toBeTruthy();
    expect(within(lost).getByText('Scout')).toBeTruthy();
    expect(within(lost).getByText('Confidence 60%')).toBeTruthy();
    expect(within(lost).getByRole('link', { name: /Renewal call ·/ })).toBeTruthy();
    expect(lost.textContent).not.toMatch(/changed|from New|previous/i);

    // A relation value is named through the item's references; the current value is unlabelled.
    const current = screen.getByText('Account owner set to').closest('li') as HTMLElement;
    expect(within(current).getByText('Avi Cohen')).toBeTruthy();
    expect(within(current).queryByText('Not the current value')).toBeNull();
    expect(within(current).getByText('Maayan')).toBeTruthy();

    // Fact: content, status, an event source with its quote and an internal note.
    const f = screen.getByText('Prefers quarterly invoicing').closest('li') as HTMLElement;
    expect(within(f).getByText('Superseded')).toBeTruthy();
    expect(within(f).getByRole('link', { name: 'Source event' })).toBeTruthy();
    expect(within(f).getByText('quarterly works best')).toBeTruthy();
    expect(within(f).getByText('Internal note')).toBeTruthy();

    // Three days, newest first.
    expect(screen.getAllByRole('list', { name: /^Timeline for / })).toHaveLength(3);
  });

  it('marks an ended fact and names a field the schema no longer has', async () => {
    vi.spyOn(api, 'timeline').mockResolvedValue(
      page([
        { ...fact, status: 'ended', validTo: '2026-11-02T00:00:00.000Z', sources: [] },
        { ...ownerSet, field: 'gone', value: 'x' },
      ]),
    );
    renderTimeline();
    expect(await screen.findByText(/^Ended /)).toBeTruthy();
    expect(screen.getByText('gone set to')).toBeTruthy();
    expect(screen.getByText('"x"')).toBeTruthy();
  });

  it('loads older pages with the cursor and the same filters', async () => {
    const timeline = vi
      .spyOn(api, 'timeline')
      .mockResolvedValueOnce(page([event], 'cursor-1'))
      .mockResolvedValueOnce(page([fact]));
    renderTimeline({ kind: 'event', eventTypes: 'meeting' });
    await screen.findByRole('link', { name: 'Renewal call' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Prefers quarterly invoicing')).toBeTruthy();
    // The first page stays; nothing more to load.
    expect(screen.getByRole('link', { name: 'Renewal call' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(timeline.mock.calls.map((c) => c[1])).toEqual([
      { types: ['event'], eventTypes: ['meeting'], cursor: undefined, signal: expect.anything() },
      { types: ['event'], eventTypes: ['meeting'], cursor: 'cursor-1', signal: expect.anything() },
    ]);
  });

  it('starts from the newest page when a filter changes', async () => {
    const timeline = vi
      .spyOn(api, 'timeline')
      .mockResolvedValueOnce(page([event, lostClaim], 'cursor-1'))
      .mockResolvedValueOnce(page([event, lostClaim]))
      .mockResolvedValue(page([lostClaim]));
    renderTimeline();
    await screen.findByRole('link', { name: 'Renewal call' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await vi.waitFor(() => expect(timeline).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: 'Field changes' }));
    await vi.waitFor(() => expect(timeline).toHaveBeenCalledTimes(3));
    expect(timeline.mock.calls[2]?.[1]).toEqual({
      types: ['field_change'],
      cursor: undefined,
      signal: expect.anything(),
    });
    // Field changes have no event types to pick from.
    expect(screen.queryByRole('button', { name: /^Event types/ })).toBeNull();

    // Fields come from the record's own fields, not its inverse relations.
    await userEvent.click(screen.getByRole('button', { name: /^Fields/ }));
    expect(screen.queryByRole('option', { name: 'People' })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: 'Stage' }));
    await vi.waitFor(() =>
      expect(timeline.mock.calls.at(-1)?.[1]).toEqual({
        types: ['field_change'],
        fields: ['stage'],
        cursor: undefined,
        signal: expect.anything(),
      }),
    );
  });

  it('notes what a lone filter narrows "all" to and clears filters', async () => {
    const timeline = vi.spyOn(api, 'timeline').mockResolvedValue(page([]));
    renderTimeline({ eventTypes: 'call' });
    expect(await screen.findByText('Nothing matches these filters')).toBeTruthy();
    expect(screen.getByText('Showing events of the chosen types.')).toBeTruthy();
    expect(timeline.mock.calls[0]?.[1]).toMatchObject({ eventTypes: ['call'] });
    expect(timeline.mock.calls[0]?.[1]).not.toHaveProperty('types');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Nothing on the timeline yet')).toBeTruthy();
    expect(timeline.mock.calls.at(-1)?.[1]).toEqual({
      cursor: undefined,
      signal: expect.anything(),
    });
  });
});
