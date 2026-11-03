import { RetainerApiError } from '@retainer/sdk';
import type { AssertionView, FieldView, PresentedRecord } from '@retainer/shared';
import { validateFieldValue } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { History, Maximize2, Pencil } from 'lucide-react';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { FieldPicker, PICKERS } from '../fields/common.js';
import { fields } from '../fields/index.js';
import { ActorBadge, AssertionSource, SourcedValue } from '../provenance/index.js';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  InteractionLink,
  Muted,
  Notice,
  ObjectLink,
  Panel,
  PanelBody,
  Property,
  PropertyEditor,
  PropertyList,
  RecordLink,
  Row,
  Section,
  Sheet,
  Stack,
  Tabs,
} from '../ui/index.js';
import { RecordActions } from './record-actions.js';
import { QueryError } from './state.js';
import { isWritable } from './write-model.js';

export function AssertionCard({ assertion }: { assertion: AssertionView }) {
  const { schema } = useWorkspace();
  const field = schema.objects
    .find((o) => o.nameSingular === assertion.object)
    ?.fields.find((f) => f.name === assertion.field);
  const Display = field ? fields[field.type].Display : null;
  return (
    <Panel>
      <Stack>
        <Row>
          <Badge>{assertion.status}</Badge>
          <RecordLink id={assertion.recordId}>
            {assertion.recordLabel || 'Untitled record'}
          </RecordLink>
          <Muted>{field?.label ?? assertion.field}</Muted>
        </Row>
        {field && Display ? (
          <Display
            field={field}
            value={assertion.value}
            references={assertion.relationReferences}
          />
        ) : (
          <Muted>Field unavailable</Muted>
        )}
        <AssertionSource assertion={assertion} />
      </Stack>
    </Panel>
  );
}

export function useRecord(id: string) {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [session.workspace.id, 'record', id],
    queryFn: ({ signal }) => api.record(id, undefined, signal),
  });
}

/** Where the memory tabs keep their tab and page: the URL on the record page, local state in the sheet. */
type MemoryNav = {
  tab?: string;
  cursor?: string;
  set: (change: { tab?: string; cursor?: string }) => void;
};
const TABS = [
  { value: 'facts', label: 'Facts' },
  { value: 'interactions', label: 'Interactions' },
  { value: 'tasks', label: 'Open tasks' },
];
const memoryTab = (raw: string | undefined) =>
  TABS.some((t) => t.value === raw) ? (raw as string) : 'facts';

/** A record opened from a list, in a sheet over it. */
export function RecordSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { schema } = useWorkspace();
  const record = useRecord(id);
  // Tab and page belong to one record; opening another row starts it fresh.
  const [memory, setMemory] = useState<{ id: string; tab?: string; cursor?: string }>({ id });
  const nav = memory.id === id ? memory : { id };
  const r = record.data;
  const object = schema.objects.find((o) => o.nameSingular === r?.object);
  return (
    <Sheet
      onClose={onClose}
      eyebrow={object?.labelSingular}
      title={r ? r.label || 'Untitled record' : 'Record'}
      description="Record details. Click a value to edit it."
      actions={
        <>
          {r ? <RecordActions record={r} requestedId={id} onGone={onClose} /> : null}
          <Button asChild variant="ghost" size="icon">
            <Link
              to="/r/$id"
              params={{ id: r?.id ?? id }}
              aria-label="Open full page"
              title="Open full page"
            >
              <Maximize2 size={15} />
            </Link>
          </Button>
        </>
      }
    >
      {r ? (
        <RecordView
          key={r.id}
          record={r}
          requestedId={id}
          nav={{ ...nav, set: (change) => setMemory({ ...nav, ...change }) }}
        />
      ) : record.error ? (
        <QueryError error={record.error} retry={() => void record.refetch()} />
      ) : (
        <Notice>Loading record…</Notice>
      )}
    </Sheet>
  );
}

/** A record's fields, relations and memory, shared by the record page and the sheet. */
export function RecordView({
  record: r,
  requestedId,
  nav,
}: {
  record: PresentedRecord;
  requestedId: string;
  nav: MemoryNav;
}) {
  const { session, schema } = useWorkspace(),
    client = useQueryClient();
  const tab = memoryTab(nav.tab),
    cursor = nav.cursor;
  const [history, setHistory] = useState<FieldView | null>(null),
    [historyCursor, setHistoryCursor] = useState<string>(),
    [retract, setRetract] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const rid = r.id;
  const facts = useQuery({
    queryKey: [session.workspace.id, 'facts', rid, cursor],
    queryFn: ({ signal }) => api.facts(rid, { cursor, signal }),
    enabled: tab === 'facts',
  });
  const interactions = useQuery({
    queryKey: [session.workspace.id, 'recordInteractions', rid, cursor],
    queryFn: ({ signal }) => api.recordInteractions(rid, { cursor, signal }),
    enabled: tab === 'interactions',
  });
  const hist = useQuery({
    queryKey: [session.workspace.id, 'assertions', rid, history?.name, historyCursor],
    queryFn: ({ signal }) =>
      api.assertions(rid, { field: history?.name, cursor: historyCursor, signal }),
    enabled: !!history,
  });
  const task = schema.objects.find((o) => o.nameSingular === 'task');
  const links =
    task?.fields.filter(
      (f) =>
        f.type === 'relation' &&
        f.isFilterable &&
        f.settings.targetObject === r.object &&
        f.settings.relationCardinality === 'many_to_one',
    ) ?? [];
  const taskFilter = {
    and: [{ status: { neq: 'done' } }, { or: links.map((f) => ({ [f.name]: { eq: rid } })) }],
  };
  const tasks = useQuery({
    queryKey: [session.workspace.id, 'tasks', rid, cursor],
    queryFn: ({ signal }) =>
      api.queryRecords(
        'task',
        {
          filter: taskFilter,
          limit: 50,
          cursor,
          sort: [{ field: 'dueDate', direction: 'asc' }],
        },
        signal,
      ),
    enabled: tab === 'tasks' && links.length > 0,
  });
  const object = schema.objects.find((o) => o.nameSingular === r.object),
    canWrite = canMutate(session);
  const own = object?.fields.filter((f) => f.settings.relationCardinality !== 'one_to_many') ?? [];
  const inverse =
    object?.fields.filter((f) => f.settings.relationCardinality === 'one_to_many') ?? [];
  async function retractFact() {
    if (!retract) return;
    setBusy(true);
    try {
      await api.retractFact(retract);
      setRetract(null);
      setMessage('Fact retracted');
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {r.id !== requestedId ? (
        <Notice>This record was merged. You’re viewing the surviving record.</Notice>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
      <Section title="Fields">
        <PropertyList>
          {own.map((f) => (
            <FieldProperty
              key={f.name}
              record={r}
              field={f}
              editable={canWrite && isWritable(f)}
              onHistory={() => {
                setHistory(f);
                setHistoryCursor(undefined);
              }}
            />
          ))}
        </PropertyList>
      </Section>
      {inverse.length ? (
        <Section title="Relations">
          <PropertyList>
            {inverse.map((f) => {
              const Display = fields[f.type].Display;
              return (
                <Property key={f.name} label={f.label}>
                  <Stack>
                    <Display
                      field={f}
                      value={
                        Array.isArray(r.fields[f.name])
                          ? (r.fields[f.name] as string[]).slice(0, 5)
                          : []
                      }
                      references={r.relationReferences}
                    />
                    {f.settings.targetObject && f.settings.inverseField ? (
                      <ObjectLink
                        object={f.settings.targetObject}
                        filter={JSON.stringify({ [f.settings.inverseField]: { eq: rid } })}
                      >
                        View related records
                      </ObjectLink>
                    ) : null}
                  </Stack>
                </Property>
              );
            })}
          </PropertyList>
        </Section>
      ) : null}
      <Stack>
        <Tabs value={tab} onChange={(tab) => nav.set({ tab, cursor: undefined })} items={TABS} />
        {tab === 'facts' ? (
          <Stack>
            {facts.error ? <QueryError error={facts.error} /> : null}
            {facts.isPending ? <Notice>Loading facts…</Notice> : null}
            {facts.data?.facts.map((f) => (
              <Panel key={f.id}>
                <Stack>
                  <p>{f.content}</p>
                  <Row>
                    <ActorBadge actor={f.writtenBy} />
                    <Muted>Valid from {new Date(f.validFrom).toLocaleString()}</Muted>
                  </Row>
                  {f.sources.map((s) => (
                    <Stack key={s.interaction}>
                      <InteractionLink id={s.interaction}>Source interaction</InteractionLink>
                      {s.quote ? <blockquote>{s.quote}</blockquote> : null}
                    </Stack>
                  ))}
                  {canWrite ? <Button onClick={() => setRetract(f.id)}>Retract fact</Button> : null}
                </Stack>
              </Panel>
            ))}
            {facts.data && !facts.data.facts.length ? <Empty title="No facts yet" /> : null}
            {facts.data?.nextCursor ? (
              <Button onClick={() => nav.set({ cursor: facts.data?.nextCursor ?? undefined })}>
                Next page of facts
              </Button>
            ) : null}
          </Stack>
        ) : null}
        {tab === 'interactions' ? (
          <Stack>
            {interactions.error ? <QueryError error={interactions.error} /> : null}
            {interactions.isPending ? <Notice>Loading interactions…</Notice> : null}
            {interactions.data?.items.map((i) => (
              <Panel key={i.id}>
                <Stack>
                  <Row>
                    <Badge>{i.kind}</Badge>
                    <InteractionLink id={i.id}>{i.title || 'Untitled interaction'}</InteractionLink>
                    <Muted>{new Date(i.occurredAt).toLocaleString()}</Muted>
                  </Row>
                  {i.summary ? <p>{i.summary}</p> : null}
                  <Row>
                    {i.participants.matched.map((p) => (
                      <RecordLink key={`${p.recordId}:${p.role}:${p.handle}`} id={p.recordId ?? ''}>
                        {p.handle || 'Participant'}
                      </RecordLink>
                    ))}
                    {i.participants.unmatched.map((p) => (
                      <Badge key={`${p.handle}:${p.role}:${p.reason}`}>
                        {p.handle || 'Unknown'} · {p.reason}
                      </Badge>
                    ))}
                  </Row>
                </Stack>
              </Panel>
            ))}
            {interactions.data && !interactions.data.items.length ? (
              <Empty title="No interactions yet" />
            ) : null}
            {interactions.data?.nextCursor ? (
              <Button
                onClick={() => nav.set({ cursor: interactions.data?.nextCursor ?? undefined })}
              >
                Next page of interactions
              </Button>
            ) : null}
          </Stack>
        ) : null}
        {tab === 'tasks' ? (
          <Stack>
            {tasks.error ? <QueryError error={tasks.error} /> : null}
            {tasks.isPending && links.length ? <Notice>Loading tasks…</Notice> : null}
            {tasks.data?.records.map((t) => (
              <Panel key={t.id}>
                <Row>
                  <RecordLink id={t.id}>{t.label || 'Untitled task'}</RecordLink>
                  <Badge>{String(t.fields.status ?? '')}</Badge>
                  {t.fields.dueDate ? <Muted>{String(t.fields.dueDate)}</Muted> : null}
                </Row>
              </Panel>
            ))}
            {!links.length || (tasks.data && !tasks.data.records.length) ? (
              <Empty title="No open tasks" />
            ) : null}
            {tasks.data?.nextCursor ? (
              <Button onClick={() => nav.set({ cursor: tasks.data?.nextCursor ?? undefined })}>
                Next page of tasks
              </Button>
            ) : null}
          </Stack>
        ) : null}
        {cursor ? <Button onClick={() => nav.set({ cursor: undefined })}>First page</Button> : null}
      </Stack>
      <Dialog
        open={!!history}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
        title={`History of ${history?.label ?? 'field'}`}
      >
        <Stack>
          {hist.error ? <QueryError error={hist.error} /> : null}
          {hist.isPending ? <Notice>Loading history…</Notice> : null}
          {hist.data?.items.map((a) => (
            <AssertionCard key={a.id} assertion={a} />
          ))}
          {hist.data && !hist.data.items.length ? (
            <Muted>No assertions for this field.</Muted>
          ) : null}
          <Row>
            {historyCursor ? (
              <Button onClick={() => setHistoryCursor(undefined)}>First page</Button>
            ) : null}
            {hist.data?.nextCursor ? (
              <Button onClick={() => setHistoryCursor(hist.data?.nextCursor ?? undefined)}>
                Next page of history
              </Button>
            ) : null}
          </Row>
        </Stack>
      </Dialog>
      <Dialog
        open={!!retract}
        onOpenChange={(open) => {
          if (!open && !busy) setRetract(null);
        }}
        title="Retract this fact?"
        description="It will disappear from current memory. Its history remains stored."
      >
        <Button variant="destructive" disabled={busy} onClick={() => void retractFact()}>
          Retract fact
        </Button>
      </Dialog>
    </>
  );
}

/** One field: its value with provenance, edited in place when clicked. */
function FieldProperty({
  record,
  field,
  editable,
  onHistory,
}: {
  record: PresentedRecord;
  field: FieldView;
  editable: boolean;
  onHistory: () => void;
}) {
  const { session } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const Display = fields[field.type].Display;
  function done(outside = false) {
    // Commit the close first, so the Edit button exists to take focus back;
    // after a click elsewhere, focus stays where the click put it.
    flushSync(() => setEditing(false));
    if (!outside) editButton.current?.focus();
  }
  return (
    <Property
      label={field.label}
      onEdit={editable ? () => setEditing(true) : undefined}
      editor={editing ? <InlineEditor record={record} field={field} onDone={done} /> : null}
      actions={
        <>
          {editable ? (
            <Button
              ref={editButton}
              variant="ghost"
              size="iconSmall"
              aria-label={`Edit ${field.label}`}
              title="Edit"
              onClick={() => setEditing(true)}
            >
              <Pencil size={13} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="iconSmall"
            aria-label={`History of ${field.label}`}
            title="History"
            onClick={onHistory}
          >
            <History size={13} />
          </Button>
        </>
      }
    >
      <SourcedValue
        field={field}
        provenance={record.provenance?.[field.name]}
        viewer={session.actor}
      >
        <Display
          field={field}
          value={record.fields[field.name]}
          references={record.relationReferences}
        />
      </SourcedValue>
    </Property>
  );
}

/**
 * Saves one field with the record's `updatedAt` as the precondition. A stale
 * write keeps the draft open beside the latest value; retrying is explicit.
 *
 * Fields chosen from a list open on the list: one choice saves on the pick,
 * several when the list is left (a click outside, Enter with nothing
 * highlighted, or ⌘/Ctrl+Enter). Other fields open a small form. Either way a
 * click outside saves a changed draft, and Escape drops it. `onDone` is told
 * whether a click outside closed the editor, so focus can stay where it went.
 */
export function InlineEditor({
  record,
  field,
  onDone,
}: {
  record: PresentedRecord;
  field: FieldView;
  onDone: (outside?: boolean) => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const current = record.fields[field.name] ?? null;
  const [draft, setDraft] = useState<unknown>(current),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false);
  const { Input, Display } = fields[field.type];
  const picker = PICKERS[field.type];
  // Wait only for the record (the next save's precondition); the rest of the
  // workspace, including the list behind a sheet, refreshes in the background.
  async function refresh() {
    void client.invalidateQueries({
      queryKey: [session.workspace.id],
      predicate: (q) => q.queryKey[1] !== 'record',
    });
    await client.invalidateQueries({ queryKey: [session.workspace.id, 'record'] });
  }
  async function save(next: unknown = draft, outside = false) {
    if (busy) return;
    // Nothing to write: leave without adding to the field's history.
    if (JSON.stringify(next ?? null) === JSON.stringify(current)) return onDone(outside);
    setBusy(true);
    try {
      const value = validateFieldValue(field, next);
      const result = await api.patchRecord(record.id, {
        values: { [field.name]: value },
        expectedUpdatedAt: record.updatedAt,
      });
      await refresh();
      if (result.fields[field.name] !== 'applied') {
        setError('Saved to history; the current value was not replaced.');
      } else onDone(outside);
    } catch (e) {
      if (e instanceof RetainerApiError && e.status === 412) {
        setStale(true);
        setError(
          'This record changed. Your draft is preserved below. Compare it with the current value before retrying.',
        );
        await refresh();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const problems =
    error || stale ? (
      <>
        {error ? <Notice error>{error}</Notice> : null}
        {stale ? (
          <Panel title="Current value">
            <Display field={field} value={current} references={record.relationReferences} />
          </Panel>
        ) : null}
      </>
    ) : null;
  const saveLabel = busy ? 'Saving…' : stale ? 'Retry with latest version' : 'Save';
  return (
    <PropertyEditor
      kind={picker ? 'picker' : 'form'}
      busy={busy}
      onSave={() => void save()}
      onCancel={() => {
        if (!busy) onDone();
      }}
      onOutside={() => void save(draft, true)}
      footerStart={
        !picker && field.isNullable ? (
          <Button size="small" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
            Clear
          </Button>
        ) : null
      }
      footer={
        // A list saves by being picked from; it shows a button only to retry.
        picker && !stale ? null : (
          <>
            {picker ? null : (
              <Button
                size="small"
                variant="ghost"
                disabled={busy}
                title="Esc"
                onClick={() => onDone()}
              >
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" size="small" disabled={busy} title="Enter">
              {saveLabel}
            </Button>
          </>
        )
      }
    >
      {picker ? (
        <>
          {problems ? <PanelBody>{problems}</PanelBody> : null}
          <FieldPicker
            field={field}
            value={draft}
            references={record.relationReferences}
            onChange={(next) => {
              setDraft(next);
              if (picker === 'one') void save(next);
            }}
          />
        </>
      ) : (
        <>
          {problems}
          <Input
            field={field}
            value={draft}
            references={record.relationReferences}
            onChange={setDraft}
          />
        </>
      )}
    </PropertyEditor>
  );
}
