import type { PresentedComment, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { CommentsPanel, commentPermissions, conversationOrder } from './comments.js';

const dana = { type: 'user', id: 'dana', name: 'Dana' } as const;
const noa = { type: 'user', id: 'noa', name: 'Noa' } as const;
const bot = { type: 'agent', id: 'bot' } as const;

const session = (
  actor: Session['actor'] = dana,
  scopes: Session['scopes'] = ['read', 'write'],
): Session => ({ workspace: { id: 'w1' }, actor, scopes }) as unknown as Session;

const comment = (over: Partial<PresentedComment> = {}): PresentedComment => ({
  id: 'k1',
  record: 'r1',
  body: 'Prefers mornings',
  author: dana,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  editedAt: null,
  ...over,
});

const page = (items: PresentedComment[], nextCursor: string | null = null) => ({
  record: 'r1',
  items,
  total: items.length,
  nextCursor,
});

function show(as: Session = session(), recordId = 'r1') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider value={{ session: as, schema: { objects: [] } } as never}>
        <CommentsPanel recordId={recordId} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('who may change a comment', () => {
  it('lets the author edit and delete, and an admin only delete', () => {
    expect(commentPermissions(comment(), session())).toEqual({ edit: true, delete: true });
    expect(commentPermissions(comment(), session(noa))).toEqual({ edit: false, delete: false });
    expect(commentPermissions(comment(), session(noa, ['read', 'write', 'admin']))).toEqual({
      edit: false,
      delete: true,
    });
  });

  it('gives an agent or a read-only key nothing, even as the author', () => {
    expect(commentPermissions(comment({ author: bot }), session(bot, ['admin']))).toEqual({
      edit: false,
      delete: false,
    });
    expect(commentPermissions(comment(), session(dana, ['read']))).toEqual({
      edit: false,
      delete: false,
    });
  });
});

describe('comments panel', () => {
  it('reads oldest first, with earlier pages loaded above', async () => {
    const newest = comment({ id: 'k3', body: 'third' });
    const middle = comment({ id: 'k2', body: 'second' });
    const oldest = comment({ id: 'k1', body: 'first' });
    expect(
      conversationOrder([{ items: [newest, middle] }, { items: [oldest] }]).map((c) => c.body),
    ).toEqual(['first', 'second', 'third']);

    const list = vi
      .spyOn(api, 'listComments')
      .mockResolvedValueOnce(page([newest, middle], 'next') as never)
      .mockResolvedValueOnce(page([oldest]) as never);
    show();
    expect(await screen.findByText('third')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier comments' }));
    await screen.findByText('first');
    expect(list.mock.calls[1]?.[1]).toMatchObject({ cursor: 'next' });
    const shown = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(shown[0]).toContain('first');
    expect(shown[2]).toContain('third');
    expect(screen.queryByRole('button', { name: 'Load earlier comments' })).toBeNull();
  });

  it('says so when there are none, and offers no box to an agent or a reader', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue(page([]) as never);
    show(session(bot));
    expect(await screen.findByText('No comments yet')).toBeTruthy();
    expect(screen.queryByLabelText('Add a comment')).toBeNull();
    cleanup();
    show(session(dana, ['read']));
    expect(await screen.findByText('No comments yet')).toBeTruthy();
    expect(screen.queryByLabelText('Add a comment')).toBeNull();
  });

  it('posts on ⌘Enter, adds a line on Enter, and retries a lost post with the same key', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue(page([]) as never);
    const add = vi
      .spyOn(api, 'addComment')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(comment() as never);
    show(session(dana), 'retry');
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Add a comment');
    await userEvent.type(box, 'line one{Enter}line two');
    expect(add).not.toHaveBeenCalled();
    expect(box.value).toBe('line one\nline two');

    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(await screen.findByText(/was not posted: network down/)).toBeTruthy();
    expect(box.value).toBe('line one\nline two');

    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(box.value).toBe(''));
    const [first, second] = add.mock.calls;
    expect(first?.[1]).toEqual({ body: 'line one\nline two' });
    expect(second?.[2]).toBe(first?.[2]);
    expect(second?.[2]).toBeTruthy();
  });

  it('uses a new key once the text changes, since it is then another comment', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue(page([]) as never);
    const add = vi
      .spyOn(api, 'addComment')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(comment() as never);
    show(session(dana), 'rewrite');
    const box = await screen.findByLabelText('Add a comment');
    await userEvent.type(box, 'first');
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByText(/was not posted/);
    await userEvent.type(box, ' try');
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add.mock.calls[1]?.[2]).not.toBe(add.mock.calls[0]?.[2]);
  });

  it('keeps a draft for the visit, per record, and refuses blank or overlong text', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue(page([]) as never);
    const view = show(session(dana), 'draft-a');
    const post = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Post comment' });
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Add a comment');
    expect(post().disabled).toBe(true);
    await userEvent.type(box, '   ');
    expect(post().disabled).toBe(true);
    await userEvent.type(box, 'half written');
    view.unmount();

    show(session(dana), 'draft-b');
    expect((await screen.findByLabelText<HTMLTextAreaElement>('Add a comment')).value).toBe('');
    cleanup();
    show(session(dana), 'draft-a');
    expect((await screen.findByLabelText<HTMLTextAreaElement>('Add a comment')).value).toBe(
      '   half written',
    );
    cleanup();
    show(session(noa), 'draft-a');
    expect((await screen.findByLabelText<HTMLTextAreaElement>('Add a comment')).value).toBe('');
  });

  it('edits in place: the same text is offered, Escape puts it back, Save writes it', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue(page([comment()]) as never);
    const edit = vi
      .spyOn(api, 'editComment')
      .mockResolvedValue(comment({ body: 'Prefers evenings' }) as never);
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit comment' }));
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit comment' });
    expect(box.value).toBe('Prefers mornings');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Edit comment' })).toBeNull();
    expect(edit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Edit comment' }));
    const again = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit comment' });
    await userEvent.clear(again);
    await userEvent.type(again, 'Prefers evenings');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith('k1', { body: 'Prefers evenings' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit comment' })).toBeNull());
  });

  it('shows who wrote it and that it was edited, and hides what this person cannot do', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue(
      page([
        comment({ editedAt: '2026-11-02T09:00:00.000Z' }),
        comment({ id: 'k2', author: noa }),
      ]) as never,
    );
    show();
    expect(await screen.findByText('edited')).toBeTruthy();
    expect(screen.getByText('Noa')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Edit comment' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete comment' })).toHaveLength(1);
  });

  it('asks before deleting', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue(page([comment()]) as never);
    const remove = vi
      .spyOn(api, 'deleteComment')
      .mockResolvedValue({ id: 'k1', deleted: true } as never);
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete comment' }));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete comment' }));
    const confirm = screen.getAllByRole('button', { name: 'Delete comment' }).at(-1);
    await userEvent.click(confirm as HTMLElement);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('k1'));
  });
});
