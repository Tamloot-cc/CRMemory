import { RetainerApiError } from '@retainer/sdk';
import type { AssertionView, FieldView, PresentedRecord } from '@retainer/shared';
import { validateFieldValue } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { History, Maximize2, Pencil } from 'lucide-react';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
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
  Property,
  PropertyEditor,
  PropertyList,
  RecordLink,
  Row,
  Section,
  Sheet,
  Stack,
  Tabs,
  useReturnFocus,
} from '../ui/index.js';
import { QueryError } from './state.js';

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
export type MemoryNav = {
  tab: string;
  cursor?: string;
  set: (change: { tab?: string; cursor?: string }) => void;
};
const TABS = [
  { value: 'facts', label: 'Facts' },
  { value: 'interactions', label: 'Interactions' },
  { value: 'tasks', label: 'Open tasks' },
];
export const memoryTab = (raw: string | undefined) =>
  TABS.some((t) => t.value === raw) ? (raw as string) : 'facts';

/** A record opened from a list, in a sheet over it. */
export function RecordSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { schema } = useWorkspace();
  const record = useRecord(id);
  const [memory, setMemory] = useState<{ tab: string; cursor?: string }>({ tab: 'facts' });
  const r = record.data;
  const object = schema.objects.find((o) => o.nameSingular === r?.object);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      eyebrow={object?.labelSingular}
      title={r ? r.label || 'Untitled record' : 'Record'}
      actions={
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
      }
    >
      {r ? (
        <RecordView
          key={r.id}
          record={r}
          requestedId={id}
          nav={{
            ...memory,
            set: (change) => setMemory((m) => ({ ...m, ...change })),
          }}
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
              editable={canWrite && !f.readOnly && f.type !== 'json'}
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
                Load more facts
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
                Load more interactions
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
                Load more tasks
              </Button>
            ) : null}
          </Stack>
        ) : null}
        {cursor ? (
          <Button onClick={() => nav.set({ cursor: undefined })}>Back to first page</Button>
        ) : null}
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
                Load more history
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
  const editButton = useReturnFocus(editing);
  const Display = fields[field.type].Display;
  return (
    <Property
      label={field.label}
      editing={editing}
      onEdit={editable ? () => setEditing(true) : undefined}
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
      {editing ? (
        <InlineEditor record={record} field={field} onDone={() => setEditing(false)} />
      ) : (
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
      )}
    </Property>
  );
}

/**
 * Saves one field with the record's `updatedAt` as the precondition. A stale
 * write keeps the draft open beside the latest value; retrying is explicit.
 */
function InlineEditor({
  record,
  field,
  onDone,
}: {
  record: PresentedRecord;
  field: FieldView;
  onDone: () => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const [draft, setDraft] = useState<unknown>(record.fields[field.name] ?? null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false);
  const Input = fields[field.type].Input,
    Display = fields[field.type].Display;
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const value = validateFieldValue(field, draft);
      const result = await api.patchRecord(record.id, {
        values: { [field.name]: value },
        expectedUpdatedAt: record.updatedAt,
      });
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
      if (result.fields[field.name] !== 'applied') {
        setError('Saved to history; the current value was not replaced.');
      } else onDone();
    } catch (e) {
      if (e instanceof RetainerApiError && e.status === 412) {
        setStale(true);
        setError(
          'This record changed. Your draft is preserved below. Compare it with the current value before retrying.',
        );
        await client.invalidateQueries({ queryKey: [session.workspace.id] });
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <PropertyEditor
      onSave={() => void save()}
      onCancel={() => {
        if (!busy) onDone();
      }}
    >
      {error ? <Notice error>{error}</Notice> : null}
      {stale ? (
        <Panel title="Current value">
          <Display
            field={field}
            value={record.fields[field.name]}
            references={record.relationReferences}
          />
        </Panel>
      ) : null}
      <Input field={field} value={draft} onChange={setDraft} />
      <Row>
        <Button type="submit" variant="primary" size="small" disabled={busy}>
          {busy ? 'Saving…' : stale ? 'Retry with latest version' : 'Save'}
        </Button>
        <Button size="small" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        {field.isNullable ? (
          <Button size="small" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
            Clear value
          </Button>
        ) : null}
        <Muted>Enter to save · Esc to cancel</Muted>
      </Row>
    </PropertyEditor>
  );
}
