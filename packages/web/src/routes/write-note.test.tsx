import type { ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import { NOTE_CHANNEL, noteInput, WriteNoteDialog } from './write-note.js';

afterEach(() => vi.restoreAllMocks());

const draft = { title: '', body: '', occurredAt: '2026-11-05T10:00:00.000Z', about: [] };

describe('a note to log', () => {
  it('goes to the web channel with its external ID, leaving out what is empty', () => {
    expect(noteInput('note', 'x1', { ...draft, title: '  Pricing  ', body: ' ' })).toEqual({
      type: 'note',
      channel: NOTE_CHANNEL,
      externalId: 'x1',
      occurredAt: draft.occurredAt,
      title: 'Pricing',
    });
    expect(noteInput('note', 'x1', { ...draft, body: 'Call back', about: ['c1'] })).toEqual({
      type: 'note',
      channel: 'web',
      externalId: 'x1',
      occurredAt: draft.occurredAt,
      summary: 'Call back',
      about: ['c1'],
    });
  });

  it('is saved once: a retry after a failure sends the same external ID', async () => {
    const note = {
      nameSingular: 'note',
      labelSingular: 'Note',
      class: 'event',
      baseObject: 'note',
      fields: [
        { name: 'title', label: 'Title', type: 'text', coreRole: 'title', settings: {} },
        { name: 'summary', label: 'Summary', type: 'text', coreRole: 'summary', settings: {} },
      ],
    } as unknown as ObjectView;
    const log = vi
      .spyOn(api, 'logEvent')
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ id: 'e1', type: 'note', created: false } as never);
    const saved = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceContext.Provider
          value={{
            session: {
              workspace: { id: 'w1' },
              actor: { type: 'user', id: 'dana' },
              scopes: ['write'],
            } as unknown as Session,
            schema: { objects: [note] } as unknown as SchemaDescription,
          }}
        >
          <WriteNoteDialog onClose={vi.fn()} onSaved={saved} />
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
    const save = screen.getByRole('button', { name: 'Save note' });
    // Nothing to save until there is a title or a body.
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('Title'), 'Pricing call');
    await userEvent.click(save);
    expect(await screen.findByText(/The note was not saved: Network error/)).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(saved).toHaveBeenCalledWith('e1');
    const [first, second] = log.mock.calls.map((c) => c[0]);
    expect(first?.externalId).toBeTruthy();
    expect(second).toEqual(first);
    expect(first).toMatchObject({ type: 'note', channel: 'web', title: 'Pricing call' });
  });
});
