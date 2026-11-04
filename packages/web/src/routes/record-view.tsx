import { RetainerApiError } from '@retainer/sdk';
import type { AssertionView, FieldView, ObjectView, PresentedRecord } from '@retainer/shared';
import {
  isCollectionRelation,
  isInverseRelation,
  isPolymorphic,
  TASK_DONE_OPTION,
  validateFieldValue,
} from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { History, Maximize2, Pencil } from 'lucide-react';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { FieldPicker, pickerFor } from '../fields/common.js';
import { fields } from '../fields/index.js';
import { ActorBadge, AssertionSource, FactSources, SourcedValue } from '../provenance/index.js';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  EventLink,
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
import { EventDetailsView, ViaLabel } from './event-details.js';
import { CandidateRecord, RecordActions } from './record-actions.js';
import { RecordTimeline, type TimelineSearch } from './record-timeline.js';
import {
  eventTitle,
  objectByName,
  objectLabel,
  QueryError,
  recordTitle,
  relationsTo,
} from './state.js';
import { isWritable } from './write-model.js';

export function AssertionCard({ assertion }: { assertion: AssertionView }) {
  const { schema } = useWorkspace();
  const field = objectByName(schema, assertion.object)?.fields.find(
    (f) => f.name === assertion.field,
  );
  const Display = field ? fields[field.type].Display : null;
  return (
    <Panel>
      <Stack>
        <Row>
          <Badge>{assertion.status}</Badge>
          <RecordLink id={assertion.recordId}>
            {recordTitle({ label: assertion.recordLabel })}
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

/**
 * A filter condition for "this relation points at `id`": `eq` on a
 * single-record field, `containsAny` on a set. A many_to_many field, owning
 * or inverse, pairs with a set on the other side too.
 */
export const pointsAt = (field: FieldView, id: string) =>
  isCollectionRelation(field) ? { containsAny: [id] } : { eq: id };

/**
 * Polymorphic relations that may point at records of `object`, with the
 * object each belongs to. They have no field on this side, so a record finds
 * what links to it by filtering on them.
 */
export function polymorphicLinksTo(objects: ObjectView[], object: string) {
  return objects.flatMap((o) =>
    relationsTo(o.fields, object)
      .filter((f) => isPolymorphic(f) && f.isFilterable)
      .map((field) => ({ object: o, field })),
  );
}

/**
 * Where the memory tabs keep their tab, page and timeline filters: the URL
 * on the record page, local state in the sheet.
 */
type MemoryState = { tab?: string; cursor?: string } & TimelineSearch;
type MemoryNav = MemoryState & { set: (change: MemoryState) => void };
const TABS = [
  { value: 'facts', label: 'Facts' },
  { value: 'events', label: 'Events' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'tasks', label: 'Open tasks' },
];
const memoryTab = (raw: string | undefined) =>
  TABS.some((t) => t.value === raw) ? (raw as string) : 'facts';

/** A record opened from a list, in a sheet over it. */
export function RecordSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { schema } = useWorkspace();
  const record = useRecord(id);
  // Tab and page belong to one record; opening another row starts it fresh.
  const [memory, setMemory] = useState<{ id: string } & MemoryState>({ id });
  const nav = memory.id === id ? memory : { id };
  const r = record.data;
  const object = r ? objectByName(schema, r.object) : undefined;
  return (
    <Sheet
      onClose={onClose}
      eyebrow={object?.labelSingular}
      title={r ? recordTitle(r) : 'Record'}
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
  const events = useQuery({
    queryKey: [session.workspace.id, 'recordEvents', rid, cursor],
    queryFn: ({ signal }) => api.recordEvents(rid, { cursor, signal }),
    enabled: tab === 'events',
  });
  // Every record the page's events name, so no link fetches its own label.
  const eventReferences = events.data?.references ?? {};
  const hist = useQuery({
    queryKey: [session.workspace.id, 'assertions', rid, history?.name, historyCursor],
    queryFn: ({ signal }) =>
      api.assertions(rid, { field: history?.name, cursor: historyCursor, signal }),
    enabled: !!history,
  });
  // Found by role, not name: a workspace may rename the task object and its fields.
  const task = schema.objects.find((o) => o.baseObject === 'task');
  const taskStatus = task?.fields.find((f) => f.baseField === 'taskStatus');
  const taskDue = task?.fields.find((f) => f.baseField === 'taskDueDate');
  const links = task ? relationsTo(task.fields, r.object).filter((f) => f.isFilterable) : [];
  const taskFilter = {
    and: [
      ...(taskStatus ? [{ [taskStatus.name]: { neq: TASK_DONE_OPTION } }] : []),
      { or: links.map((f) => ({ [f.name]: pointsAt(f, rid) })) },
    ],
  };
  const tasks = useQuery({
    queryKey: [session.workspace.id, 'tasks', rid, cursor],
    queryFn: ({ signal }) =>
      api.queryRecords(
        task?.nameSingular ?? 'task',
        {
          filter: taskFilter,
          limit: 50,
          cursor,
          sort: taskDue ? [{ field: taskDue.name, direction: 'asc' }] : [],
        },
        signal,
      ),
    enabled: tab === 'tasks' && !!task && links.length > 0,
  });
  const object = objectByName(schema, r.object),
    canWrite = canMutate(session);
  const own = object?.fields.filter((f) => !isInverseRelation(f)) ?? [];
  const inverse = object?.fields.filter(isInverseRelation) ?? [];
  const incoming = polymorphicLinksTo(schema.objects, r.object);
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
      {r.event ? (
        <Section title="Event">
          <EventDetailsView id={r.id} event={r.event} editable={canWrite} />
          <Row>
            <EventLink id={r.id}>Open event and the claims citing it</EventLink>
          </Row>
        </Section>
      ) : null}
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
      {inverse.length || incoming.length ? (
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
                        filter={JSON.stringify({
                          // The other side holds this record: as its value, or in its set.
                          [f.settings.inverseField]: pointsAt(f, rid),
                        })}
                      >
                        View related records
                      </ObjectLink>
                    ) : null}
                  </Stack>
                </Property>
              );
            })}
            {incoming.map(({ object: o, field: f }) => (
              <Property
                key={`${o.nameSingular}.${f.name}`}
                label={`${o.labelSingular} → ${f.label}`}
              >
                <ObjectLink
                  object={o.nameSingular}
                  filter={JSON.stringify({ [f.name]: pointsAt(f, rid) })}
                >
                  View {o.labelPlural.toLowerCase()} linking here
                </ObjectLink>
              </Property>
            ))}
          </PropertyList>
        </Section>
      ) : null}
      <Stack>
        <Tabs
          value={tab}
          onChange={(tab) =>
            nav.set({
              tab,
              cursor: undefined,
              kind: undefined,
              fields: undefined,
              eventTypes: undefined,
            })
          }
          items={TABS}
        />
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
                  <FactSources sources={f.sources} />
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
        {tab === 'events' ? (
          <Stack>
            {events.error ? <QueryError error={events.error} /> : null}
            {events.isPending ? <Notice>Loading events…</Notice> : null}
            {events.data?.items.map((e) => (
              <Panel key={e.id}>
                <Stack>
                  <Row>
                    <Badge>{objectLabel(schema, e.object)}</Badge>
                    <EventLink id={e.id}>{eventTitle(e.event)}</EventLink>
                    <Muted>{new Date(e.event.occurredAt).toLocaleString()}</Muted>
                    <ViaLabel
                      via={e.via}
                      eventObject={objectByName(schema, e.object)}
                      recordObject={object}
                      references={eventReferences}
                    />
                  </Row>
                  {e.event.summary ? <p>{e.event.summary}</p> : null}
                  <Row>
                    {e.event.participants.matched.map((p) => (
                      <CandidateRecord key={p.id} id={p.recordId} references={eventReferences} />
                    ))}
                    {e.event.participants.unmatched.map((p) => (
                      <Badge key={p.id}>
                        {p.handle || 'Unknown'} · {p.reason}
                      </Badge>
                    ))}
                  </Row>
                </Stack>
              </Panel>
            ))}
            {events.data && !events.data.items.length ? <Empty title="No events yet" /> : null}
            {events.data?.nextCursor ? (
              <Button onClick={() => nav.set({ cursor: events.data?.nextCursor ?? undefined })}>
                Next page of events
              </Button>
            ) : null}
          </Stack>
        ) : null}
        {tab === 'timeline' ? (
          <RecordTimeline
            recordId={rid}
            object={object}
            search={{ kind: nav.kind, fields: nav.fields, eventTypes: nav.eventTypes }}
            onSearchChange={(change) => nav.set(change)}
          />
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
 * Whether a draft holds the value already stored. A set compares as members
 * in ID order, as the server keeps it; the order they were picked in is not
 * a change.
 */
export function sameValue(field: FieldView, draft: unknown, current: unknown) {
  const shape = (v: unknown) =>
    isCollectionRelation(field) && Array.isArray(v) ? [...new Set(v)].sort() : (v ?? null);
  return JSON.stringify(shape(draft)) === JSON.stringify(shape(current));
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
  const picker = pickerFor(field);
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
    if (sameValue(field, next, current)) return onDone(outside);
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
      onOutside={() => {
        if (busy) return;
        // While the editor shows a problem (a stale write, a write kept only
        // in history, a rejected value), clicking away leaves it: only an
        // explicit Save or Retry writes again.
        if (error || stale) onDone(true);
        else void save(draft, true);
      }}
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
              // One save at a time: a pick while one is in flight would show
              // as chosen but never be written.
              if (busy) return;
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
