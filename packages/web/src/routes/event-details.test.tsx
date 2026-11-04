import type { EventDetails, ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import { EventDetailsView, ViaLabel } from './event-details.js';

const meeting = {
  nameSingular: 'meeting',
  class: 'event',
  fields: [{ name: 'deal', label: 'Deal' }],
} as unknown as ObjectView;
const company = {
  nameSingular: 'company',
  class: 'entity',
  fields: [{ name: 'people', label: 'People' }],
} as unknown as ObjectView;

function renderIn(children: ReactNode) {
  const workspace = {
    session: { workspace: { id: 'w1' } } as unknown as Session,
    schema: { objects: [meeting, company] } as unknown as SchemaDescription,
  };
  // Record labels are fetched per link; answer them without a server.
  vi.spyOn(api, 'record').mockResolvedValue({ id: 'r', label: 'Dana Levi' } as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

// Links need a router; plain anchors are enough to find them by name.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

afterEach(() => vi.restoreAllMocks());

describe('ViaLabel', () => {
  it('names how the event is attached, using field labels', () => {
    renderIn(
      <>
        <ViaLabel via={{ kind: 'participant' }} />
        <ViaLabel via={{ kind: 'about' }} />
        <ViaLabel via={{ kind: 'field', field: 'deal' }} eventObject={meeting} />
        <ViaLabel via={{ kind: 'field', field: 'renamedAway' }} eventObject={meeting} />
        <ViaLabel via={{ kind: 'rollup', field: 'people', record: 'p1' }} recordObject={company} />
      </>,
    );
    expect(screen.getByText('Participant')).toBeTruthy();
    expect(screen.getByText('About')).toBeTruthy();
    expect(screen.getByText('Via field Deal')).toBeTruthy();
    expect(screen.getByText('Via field renamedAway')).toBeTruthy();
    expect(screen.getByText('Via People')).toBeTruthy();
  });
});

const event: EventDetails = {
  occurredAt: '2026-10-20T10:00:00.000Z',
  channel: null,
  externalId: null,
  title: 'Renewal call',
  summary: null,
  participants: {
    matched: [{ id: 'l1', handle: 'dana@acme.test', role: 'host', recordId: 'p1' }],
    unmatched: [{ id: 'l2', handle: '+15550100', role: null, reason: 'phone_only' }],
  },
  about: [],
};

describe('EventDetailsView', () => {
  it('shows unmatched reasons and erased identity, read-only without write access', async () => {
    renderIn(<EventDetailsView id="e1" event={event} editable={false} />);
    expect(screen.getByText('Phone only')).toBeTruthy();
    expect(screen.getAllByText('Erased for privacy')).toHaveLength(2);
    expect(await screen.findByRole('link', { name: 'Dana Levi' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add participant…' })).toBeNull();
  });

  it('removes a participant by its link ID', async () => {
    const remove = vi.spyOn(api, 'removeParticipant').mockResolvedValue({} as never);
    renderIn(<EventDetailsView id="e1" event={event} editable />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove +15550100' }));
    expect(remove).toHaveBeenCalledWith('e1', 'l2');
  });

  it('adds a participant by handle and role', async () => {
    const add = vi.spyOn(api, 'addEventLinks').mockResolvedValue({} as never);
    renderIn(<EventDetailsView id="e1" event={event} editable />);
    await userEvent.click(screen.getByRole('button', { name: 'Add participant…' }));
    await userEvent.type(screen.getByLabelText('Participant email or phone'), 'avi@acme.test');
    await userEvent.type(screen.getByLabelText('Participant role'), 'guest');
    await userEvent.click(screen.getByRole('button', { name: 'Add participant' }));
    expect(add).toHaveBeenCalledWith('e1', {
      participants: [{ handle: 'avi@acme.test', role: 'guest' }],
    });
  });
});
