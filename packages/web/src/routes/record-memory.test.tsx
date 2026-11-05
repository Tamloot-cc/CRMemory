import type {
  FieldView,
  ObjectView,
  PresentedRecord,
  SchemaDescription,
  Session,
} from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import { defaultMemoryTab, MemoryTabs, memoryTabs, taskLinksTo } from './record-memory.js';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const relation = (name: string, targets: string[]) =>
  ({
    name,
    label: name,
    type: 'relation',
    isFilterable: true,
    settings: {
      relationCardinality: 'many_to_one',
      ...(targets.length > 1 ? { targetObjects: targets } : { targetObject: targets[0] }),
    },
  }) as unknown as FieldView;

const object = (name: string, extra: Partial<ObjectView> = {}) =>
  ({
    nameSingular: name,
    labelSingular: name,
    labelPlural: `${name}s`,
    class: 'entity',
    fields: [],
    ...extra,
  }) as unknown as ObjectView;

const task = object('task', {
  baseObject: 'task',
  fields: [
    {
      name: 'state',
      baseField: 'taskStatus',
      type: 'select',
      settings: {},
    } as unknown as FieldView,
    relation('regarding', ['company', 'person']),
  ],
});
const schema = {
  objects: [
    object('company'),
    object('person'),
    object('deal'),
    object('conversation', { class: 'event' }),
    task,
  ],
} as unknown as SchemaDescription;

const labels = (tabs: { label: string }[]) => tabs.map((t) => t.label);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('which tabs a record has', () => {
  const entity = { isEvent: false, hasTasks: true, developer: false };

  it('gives an entity its memory, comments first', () => {
    expect(labels(memoryTabs(entity))).toEqual([
      'Comments',
      'Facts',
      'Activity',
      'Timeline',
      'Open tasks',
    ]);
  });

  it('shows Open tasks only where a task relation can point, found by role', () => {
    expect(taskLinksTo(schema, 'company').links.map((f) => f.name)).toEqual(['regarding']);
    expect(taskLinksTo(schema, 'deal').links).toEqual([]);
    const renamed = { objects: [{ ...task, nameSingular: 'todo' }] };
    expect(taskLinksTo(renamed, 'person').task?.nameSingular).toBe('todo');
    expect(taskLinksTo(renamed, 'person').status?.name).toBe('state');
    expect(taskLinksTo({ objects: [object('company')] }, 'company').links).toEqual([]);
    expect(labels(memoryTabs({ ...entity, hasTasks: false }))).not.toContain('Open tasks');
  });

  it('gives an event comments, claims and history, and none of what an entity has (5.1)', () => {
    expect(labels(memoryTabs({ ...entity, isEvent: true }))).toEqual([
      'Comments',
      'Claims',
      'History',
    ]);
  });

  it('adds JSON in the developer view', () => {
    expect(labels(memoryTabs({ ...entity, developer: true })).at(-1)).toBe('JSON');
  });

  it('keeps Facts on an event only when facts are stored on it, so none become unreachable', () => {
    const event = { ...entity, isEvent: true };
    const counts = { comments: 0, facts: 2, openTasks: 0, claims: 0 };
    expect(memoryTabs({ ...event, counts }).map((t) => [t.label, t.count])).toEqual([
      ['Comments', undefined],
      ['Claims', undefined],
      ['History', undefined],
      ['Facts', 2],
    ]);
    expect(labels(memoryTabs({ ...event, counts: { ...counts, facts: 0 } }))).not.toContain(
      'Facts',
    );
    expect(defaultMemoryTab(true, counts)).toBe('comments');
  });

  it('counts only what there is, and never fans out to count activity', () => {
    const tabs = memoryTabs({
      ...entity,
      counts: { comments: 2, facts: 0, openTasks: 3, claims: 9 },
    });
    expect(tabs.map((t) => [t.label, t.count])).toEqual([
      ['Comments', 2],
      ['Facts', undefined],
      ['Activity', undefined],
      ['Timeline', undefined],
      ['Open tasks', 3],
    ]);
    expect(
      memoryTabs({
        ...entity,
        isEvent: true,
        counts: { comments: 0, facts: 0, openTasks: 1, claims: 4 },
      }).map((t) => t.count),
    ).toEqual([undefined, 4, undefined]);
  });

  it('opens where people wrote something, then on what agents remember', () => {
    expect(defaultMemoryTab(false)).toBe('facts');
    expect(defaultMemoryTab(false, { comments: 0, facts: 2, openTasks: 0, claims: 0 })).toBe(
      'facts',
    );
    expect(defaultMemoryTab(false, { comments: 1, facts: 2, openTasks: 0, claims: 0 })).toBe(
      'comments',
    );
    expect(defaultMemoryTab(true)).toBe('comments');
  });
});

describe('MemoryTabs', () => {
  const record = (over: Partial<PresentedRecord>) =>
    ({
      id: 'r1',
      object: 'company',
      label: 'Acme',
      fields: {},
      createdBy: { type: 'user', id: 'dana' },
      ...over,
    }) as unknown as PresentedRecord;

  function show(r: PresentedRecord, tab?: string) {
    const set = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceContext.Provider
          value={{
            session: {
              workspace: { id: 'w1' },
              actor: { type: 'user', id: 'dana' },
              scopes: ['read', 'write'],
            } as unknown as Session,
            schema,
          }}
        >
          <MemoryTabs record={r} nav={{ tab, set }} />
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
    return set;
  }

  it('falls back to where the record opens when the address names a tab it lacks', () => {
    vi.spyOn(api, 'listComments').mockResolvedValue({ items: [], nextCursor: null } as never);
    show(record({ object: 'conversation', event: {} as never }), 'facts');
    expect(screen.getByRole('button', { name: 'Comments' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByRole('button', { name: 'Facts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open tasks' })).toBeNull();
  });

  it('asks for the new tab and clears the last tab’s timeline filters', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [], nextCursor: null } as never);
    const set = show(record({ object: 'deal' }));
    expect(screen.queryByRole('button', { name: 'Open tasks' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(set).toHaveBeenCalledWith({
      tab: 'timeline',
      kind: undefined,
      fields: undefined,
      eventTypes: undefined,
    });
  });

  it('pages a list by adding to it, keeping what is shown', async () => {
    const fact = (id: string, content: string) => ({
      id,
      record: 'r1',
      content,
      kind: 'stated',
      validFrom: '2026-11-01T09:00:00.000Z',
      validTo: null,
      writtenBy: { type: 'agent', id: 'bot' },
      sources: [],
    });
    const facts = vi
      .spyOn(api, 'facts')
      .mockResolvedValueOnce({ facts: [fact('f1', 'one')], nextCursor: 'c2' } as never)
      .mockResolvedValueOnce({ facts: [fact('f2', 'two')], nextCursor: null } as never);
    show(record({}));
    expect(await screen.findByText('one')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('two')).toBeTruthy();
    expect(screen.getByText('one')).toBeTruthy();
    expect(facts.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c2' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByRole('button', { name: /First page|Next page/ })).toBeNull();
  });

  it('reads a task’s status and due date from its role fields, not their names', async () => {
    const status = {
      name: 'state',
      label: 'State',
      baseField: 'taskStatus',
      type: 'select',
      settings: { options: [{ value: 'in_progress', label: 'In progress' }] },
    } as unknown as FieldView;
    const renamed = { ...task, fields: [status, relation('regarding', ['company', 'person'])] };
    vi.spyOn(api, 'queryRecords').mockResolvedValue({
      records: [{ id: 't1', object: 'task', label: 'Send deck', fields: { state: 'in_progress' } }],
      nextCursor: null,
    } as never);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceContext.Provider
          value={{
            session: {
              workspace: { id: 'w1' },
              actor: { type: 'user', id: 'dana' },
              scopes: ['read'],
            } as unknown as Session,
            schema: { objects: [object('company'), renamed] } as unknown as SchemaDescription,
          }}
        >
          <MemoryTabs record={record({})} nav={{ tab: 'tasks', set: vi.fn() }} />
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Send deck')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.queryByText('in_progress')).toBeNull();
  });
});
