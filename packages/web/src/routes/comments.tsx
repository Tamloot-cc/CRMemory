import type { Actor, PresentedComment, Session } from '@retainer/shared';
import { MAX_COMMENT_LENGTH, sameActor } from '@retainer/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, UserRound } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import {
  Badge,
  Button,
  Code,
  Dialog,
  Empty,
  Entry,
  EntryComposer,
  EntryList,
  EntryLoading,
  EntryName,
  EntryText,
  EntryTime,
  LoadMore,
  Muted,
  Notice,
  PropertyEditor,
  Row,
  Stack,
  Textarea,
} from '../ui/index.js';
import { useDeveloper } from './developer.js';
import { byCursor, QueryError } from './state.js';

/** Near the limit, the box says how much is left. */
const SHOW_LENGTH_FROM = 9_000;

/** Who may change a comment (4.1). Only `user` actors write, so an agent's session may do neither. */
export function commentPermissions(comment: Pick<PresentedComment, 'author'>, session: Session) {
  const writes = canMutate(session);
  const author = sameActor(comment.author, session.actor);
  return {
    edit: writes && author,
    delete: (writes && author) || canMutate(session, 'admin'),
  };
}

/**
 * Oldest first, as a conversation reads. The API pages newest first, so each
 * earlier page goes above what is shown.
 */
export const conversationOrder = (pages: { items: PresentedComment[] }[]) =>
  pages.flatMap((p) => p.items).reverse();

type CommentDraft = { body: string; key: string };

/**
 * Drafts outlive the tab and the sheet, kept here for the visit and only in
 * memory: a person's half-written remark is never written to the browser's
 * storage. Each is per workspace, person and record.
 */
const drafts = new Map<string, CommentDraft>();
const draftId = (workspace: string, actor: Actor, record: string) =>
  JSON.stringify([workspace, actor.type, actor.id, record]);

/**
 * A draft's text and its idempotency key. The key changes with the text, so a
 * retry after a lost response posts once, and an edited retry is a new comment
 * rather than a refused reuse of the key.
 */
function useCommentDraft(recordId: string) {
  const { session } = useWorkspace();
  const id = draftId(session.workspace.id, session.actor, recordId);
  const [draft, setDraft] = useState<CommentDraft>(
    () => drafts.get(id) ?? { body: '', key: crypto.randomUUID() },
  );
  return {
    draft,
    setBody(body: string) {
      const next = { body, key: crypto.randomUUID() };
      drafts.set(id, next);
      setDraft(next);
    },
    clear() {
      drafts.delete(id);
      setDraft({ body: '', key: crypto.randomUUID() });
    },
  };
}

const lengthProblem = (body: string) => body.length > MAX_COMMENT_LENGTH;

const authorName = (author: Actor) => author.name || author.id;

/** A record's comments and, for people who may write, the box to add one. */
export function CommentsPanel({ recordId }: { recordId: string }) {
  const { session } = useWorkspace(),
    developer = useDeveloper();
  const queryKey = [session.workspace.id, 'comments', recordId];
  const comments = useInfiniteQuery({
    queryKey,
    queryFn: ({ signal, pageParam }) => api.listComments(recordId, { cursor: pageParam, signal }),
    ...byCursor,
  });
  const items = conversationOrder(comments.data?.pages ?? []);
  const writable = canMutate(session);
  return (
    <>
      {developer ? (
        <Row>
          <Code>{`GET /v1/records/${recordId}/comments`}</Code>
        </Row>
      ) : null}
      {comments.error ? (
        <QueryError error={comments.error} retry={() => void comments.refetch()} />
      ) : null}
      {comments.isPending ? <EntryLoading label="Loading comments…" /> : null}
      {comments.hasNextPage ? (
        <LoadMore
          loading={comments.isFetchingNextPage}
          onClick={() => void comments.fetchNextPage()}
        >
          Load earlier comments
        </LoadMore>
      ) : null}
      {comments.data && !items.length ? (
        <Empty
          quiet
          title="No comments yet"
          description={
            writable
              ? 'Tell the team something about this record. Comments are for people; agents read them but never cite them.'
              : 'Nobody on the team has written anything here.'
          }
        />
      ) : null}
      {items.length ? (
        <EntryList label="Comments">
          {items.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </EntryList>
      ) : null}
      {writable ? <CommentBox recordId={recordId} /> : null}
    </>
  );
}

function CommentRow({ comment }: { comment: PresentedComment }) {
  const { session } = useWorkspace(),
    client = useQueryClient(),
    developer = useDeveloper();
  const allowed = commentPermissions(comment, session);
  const [editing, setEditing] = useState(false),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api.deleteComment(comment.id);
      setConfirm(false);
      await refreshComments(client, session.workspace.id, comment.record);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Entry
      icon={UserRound}
      title={
        <>
          <EntryName>{authorName(comment.author)}</EntryName>
          {comment.editedAt ? <Muted small>edited</Muted> : null}
        </>
      }
      time={<EntryTime at={comment.createdAt} />}
      actions={
        !editing && (allowed.edit || allowed.delete) ? (
          <>
            {allowed.edit ? (
              <Button
                variant="ghost"
                size="iconSmall"
                aria-label="Edit comment"
                title="Edit"
                onClick={() => setEditing(true)}
              >
                <Pencil size={13} />
              </Button>
            ) : null}
            {allowed.delete ? (
              <Button
                variant="ghost"
                size="iconSmall"
                aria-label="Delete comment"
                title="Delete"
                onClick={() => setConfirm(true)}
              >
                <Trash2 size={13} />
              </Button>
            ) : null}
          </>
        ) : null
      }
      footer={
        developer ? (
          <>
            <Code>{comment.id}</Code>
            <Code>{`${comment.author.type}:${comment.author.id}`}</Code>
          </>
        ) : null
      }
    >
      {editing ? (
        <EditComment comment={comment} onDone={() => setEditing(false)} />
      ) : (
        <EntryText>{comment.body}</EntryText>
      )}
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
        title="Delete this comment?"
        description="It disappears for everyone on the team. This can't be undone here."
      >
        <Stack>
          {error ? <Notice error>{error}</Notice> : null}
          <Row>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete comment
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </Row>
        </Stack>
      </Dialog>
    </Entry>
  );
}

/**
 * Editing a comment in place. ⌘/Ctrl+Enter saves; Escape puts it back. A
 * click elsewhere leaves it open, so text isn't lost by reaching for a tab.
 */
function EditComment({ comment, onDone }: { comment: PresentedComment; onDone: () => void }) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const [body, setBody] = useState(comment.body),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const empty = !body.trim();
  async function save() {
    if (busy || empty || lengthProblem(body)) return;
    setBusy(true);
    setError('');
    try {
      await api.editComment(comment.id, { body });
      // The count is the same, so the record need not be read again.
      await client.invalidateQueries({
        queryKey: [session.workspace.id, 'comments', comment.record],
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <PropertyEditor
      busy={busy}
      onSave={() => void save()}
      onCancel={() => {
        if (!busy) onDone();
      }}
      onOutside={() => {}}
      footer={
        <>
          <Button size="small" variant="ghost" disabled={busy} title="Esc" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="small"
            variant="primary"
            disabled={busy || empty || lengthProblem(body)}
            title="⌘/Ctrl+Enter"
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {error ? <Notice error>{error}</Notice> : null}
      <Textarea
        prose
        aria-label="Edit comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
    </PropertyEditor>
  );
}

/** The box at the bottom of the list. Enter adds a line; ⌘/Ctrl+Enter posts. */
function CommentBox({ recordId }: { recordId: string }) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const { draft, setBody, clear } = useCommentDraft(recordId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const empty = !draft.body.trim();
  const tooLong = lengthProblem(draft.body);
  async function post() {
    if (busy || empty || tooLong) return;
    setBusy(true);
    setError('');
    try {
      await api.addComment(recordId, { body: draft.body }, draft.key);
      clear();
      await refreshComments(client, session.workspace.id, recordId);
    } catch (e) {
      setError(`Your comment was not posted: ${(e as Error).message}. Try again; it posts once.`);
    } finally {
      setBusy(false);
    }
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void post();
    }
  }
  return (
    <EntryComposer
      input={
        <>
          {error ? <Notice error>{error}</Notice> : null}
          <Textarea
            prose
            aria-label="Add a comment"
            placeholder="Add a comment…"
            value={draft.body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </>
      }
      hint={
        draft.body.length >= SHOW_LENGTH_FROM ? (
          <Badge tone={tooLong ? 'error' : 'neutral'}>
            {draft.body.length.toLocaleString()} / {MAX_COMMENT_LENGTH.toLocaleString()}
          </Badge>
        ) : (
          <Muted small>⌘/Ctrl+Enter to post</Muted>
        )
      }
      action={
        <Button
          size="small"
          variant="primary"
          disabled={busy || empty || tooLong}
          onClick={() => void post()}
        >
          {busy ? 'Posting…' : 'Post comment'}
        </Button>
      }
    />
  );
}

/** The list, and the record, whose tab shows the count. */
function refreshComments(
  client: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  recordId: string,
) {
  return Promise.all([
    client.invalidateQueries({ queryKey: [workspaceId, 'comments', recordId] }),
    client.invalidateQueries({ queryKey: [workspaceId, 'record'] }),
  ]);
}
