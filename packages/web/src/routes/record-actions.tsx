import type { ForgetResult, PresentedRecord } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Combine, MoreHorizontal, ShieldX, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import {
  Button,
  Dialog,
  Form,
  FormField,
  Input,
  InteractionLink,
  MenuButton,
  MenuList,
  Muted,
  Notice,
  Popover,
  RecordLink,
  Row,
  Stack,
} from '../ui/index.js';
import { MergePicker } from './merge.js';
import { QueryError, recordTitle as title, useReport } from './state.js';
import { describeImpact, forgetConfirmation } from './write-model.js';

/**
 * The record's actions menu, in the sheet and on the record page: merge a
 * duplicate in, delete, and erase for privacy (admin). `onGone` leaves the
 * screen after the record is deleted or erased; `requestedId` is the ID the
 * screen was opened with, which differs from the record's after a merge.
 */
export function RecordActions({
  record,
  requestedId,
  onGone,
}: {
  record: PresentedRecord;
  requestedId: string;
  onGone: () => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const [menu, setMenu] = useState(false),
    [action, setAction] = useState<'merge' | 'delete' | 'forget' | null>(null);
  const canWrite = canMutate(session),
    canErase = canMutate(session, 'admin');
  if (!canWrite) return null;
  const choose = (next: typeof action) => {
    setMenu(false);
    setAction(next);
  };
  const close = () => setAction(null);
  // Leave first, then drop the record's queries (under both IDs) so nothing
  // refetches a record that no longer exists, and refresh the rest.
  const leave = () => {
    const wid = session.workspace.id;
    onGone();
    for (const id of new Set([record.id, requestedId]))
      client.removeQueries({ queryKey: [wid, 'record', id] });
    void client.invalidateQueries({ queryKey: [wid] });
  };
  return (
    <>
      <Popover
        label="Record actions"
        align="end"
        open={menu}
        onOpenChange={setMenu}
        trigger={
          <Button variant="ghost" size="icon" aria-label="Record actions" title="Record actions">
            <MoreHorizontal size={16} />
          </Button>
        }
      >
        <MenuList>
          <MenuButton onClick={() => choose('merge')}>
            <Combine size={14} />
            Merge a duplicate…
          </MenuButton>
          <MenuButton destructive onClick={() => choose('delete')}>
            <Trash2 size={14} />
            Delete…
          </MenuButton>
          {canErase ? (
            <MenuButton destructive onClick={() => choose('forget')}>
              <ShieldX size={14} />
              Erase for privacy…
            </MenuButton>
          ) : null}
        </MenuList>
      </Popover>
      {action === 'merge' ? <MergePicker record={record} onClose={close} /> : null}
      {action === 'delete' ? <DeleteDialog record={record} onClose={close} onGone={leave} /> : null}
      {action === 'forget' ? <ForgetDialog record={record} onClose={close} onGone={leave} /> : null}
    </>
  );
}

type ActionProps = {
  record: PresentedRecord;
  onClose: () => void;
  /** Leaves the screen of a record that no longer exists. */
  onGone: () => void;
};

function DeleteDialog({ record, onClose, onGone }: ActionProps) {
  const { session, schema } = useWorkspace(),
    report = useReport();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // Counted by the server over every cascading link, at any depth.
  const impact = useQuery({
    queryKey: [session.workspace.id, 'deleteImpact', record.id],
    queryFn: ({ signal }) => api.deleteImpact(record.id, signal),
  });
  const linked = impact.data?.records ?? [];
  async function remove() {
    setBusy(true);
    setError('');
    try {
      const result = await api.deleteRecord(record.id);
      const others = result.deletedRecordIds.filter((id) => id !== record.id).length;
      report(
        others
          ? `Deleted ${title(record)} and ${others} linked ${others === 1 ? 'record' : 'records'}.`
          : `Deleted ${title(record)}.`,
      );
      onGone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Delete ${title(record)}?`}
      description="It disappears from lists, search and the records that link to it. Its history stays stored, but it can’t be restored from the app."
    >
      <Stack>
        {error ? <Notice error>{error}</Notice> : null}
        {impact.error ? (
          <QueryError error={impact.error} retry={() => void impact.refetch()} />
        ) : null}
        {impact.isPending ? <Notice>Checking linked records…</Notice> : null}
        {linked.length ? (
          <Notice error>
            Deleting it also deletes {describeImpact(linked, schema.objects)} linked to it.
          </Notice>
        ) : null}
        <Row>
          <Button
            variant="destructive"
            disabled={busy || !impact.data}
            onClick={() => void remove()}
          >
            {busy ? 'Deleting…' : 'Delete record'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

/** The hard delete for a privacy request (ARCHITECTURE.md 2.1). */
function ForgetDialog({ record, onClose, onGone }: ActionProps) {
  const report = useReport();
  const [typed, setTyped] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const word = forgetConfirmation(record);
  async function erase() {
    if (typed.trim() !== word || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.forget(record.id);
      report(<ForgetReport label={title(record)} result={result} />);
      onGone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Erase ${title(record)} permanently?`}
      description="For privacy requests. Unlike delete, nothing is kept and nothing can be restored."
    >
      <Form onSubmit={() => void erase()}>
        {error ? <Notice error>{error}</Notice> : null}
        <Stack>
          <Muted>This erases, for good:</Muted>
          <Muted>· the record and any records merged into it, with their history and facts;</Muted>
          <Muted>
            · every interaction they took part in, whole, including what others said in it;
          </Muted>
          <Muted>· values and facts on other records that came only from those interactions.</Muted>
          <Muted>
            Their emails and phones are blocked, so no record can add them again. Other records may
            still mention them; you’ll get a list to check.
          </Muted>
        </Stack>
        <FormField label={`Type “${word}” to confirm`}>
          <Input
            aria-label="Confirmation"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </FormField>
        <Row>
          <Button type="submit" variant="destructive" disabled={busy || typed.trim() !== word}>
            {busy ? 'Erasing…' : 'Erase permanently'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Form>
    </Dialog>
  );
}

const SHOWN = 10;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What `forget` removed, and the live rows that may still mention the person. */
function ForgetReport({ label, result }: { label: string; result: ForgetResult }) {
  const { counts, reviewCandidates: c } = result;
  const linked = [
    ...c.records.map((id) => <CandidateRecord key={id} id={id} />),
    ...c.interactions.map((id) => <CandidateInteraction key={id} id={id} />),
  ];
  return (
    <Stack>
      <span>
        Erased {label}: {plural(counts.records, 'record', 'records')},{' '}
        {plural(counts.interactions, 'interaction', 'interactions')},{' '}
        {plural(counts.facts, 'fact', 'facts')} and {plural(counts.assertions, 'value', 'values')}.{' '}
        {plural(counts.suppressedHandles, 'email or phone is', 'emails and phones are')} blocked
        from coming back.
      </span>
      {linked.length || c.facts.length ? (
        <Stack>
          <span>These may still mention them. Check each one:</span>
          <Row>{linked.slice(0, SHOWN)}</Row>
          {linked.length > SHOWN ? <span>And {linked.length - SHOWN} more.</span> : null}
          {c.facts.length ? (
            <span>
              {plural(c.facts.length, 'fact', 'facts')} on other records{' '}
              {c.facts.length === 1 ? 'matches' : 'match'} their name or contact details.
            </span>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
function CandidateRecord({ id }: { id: string }) {
  const { session } = useWorkspace();
  const record = useQuery({
    queryKey: [session.workspace.id, 'record', id, 'label'],
    queryFn: ({ signal }) => api.record(id, [], signal),
  });
  return <RecordLink id={id}>{record.data ? title(record.data) : 'Record'}</RecordLink>;
}
function CandidateInteraction({ id }: { id: string }) {
  const { session } = useWorkspace();
  const interaction = useQuery({
    queryKey: [session.workspace.id, 'interaction', id],
    queryFn: ({ signal }) => api.interaction(id, signal),
  });
  return (
    <InteractionLink id={id}>{interaction.data?.title || 'Untitled interaction'}</InteractionLink>
  );
}
