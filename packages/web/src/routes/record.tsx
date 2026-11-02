import { RetainerApiError } from '@retainer/sdk';
import type { AssertionView, FieldView, PresentedRecord } from '@retainer/shared';
import { validateFieldValue } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { fields } from '../fields/index.js';
import { ActorBadge, AssertionSource, SourcedValue } from '../provenance/index.js';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  FieldRow,
  InteractionLink,
  Muted,
  Notice,
  ObjectLink,
  Page,
  Panel,
  RecordLink,
  Row,
  Stack,
  Tabs,
} from '../ui/index.js';
import { QueryError, useView } from './state.js';
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
function Editor({
  record,
  field,
  onClose,
}: {
  record: PresentedRecord;
  field: FieldView;
  onClose: () => void;
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
      } else onClose();
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Edit ${field.label}`}
      description="Your changes are attributed to your personal API key."
    >
      <Stack>
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
          {field.isNullable ? (
            <Button disabled={busy} onClick={() => setDraft(null)}>
              Clear value
            </Button>
          ) : null}
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : stale ? 'Retry with latest version' : 'Save'}
          </Button>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}
export function RecordPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { session, schema } = useWorkspace(),
    client = useQueryClient();
  const { search, setSearch } = useView();
  const tab = ['facts', 'interactions', 'tasks'].includes(search.tab ?? '')
    ? (search.tab ?? 'facts')
    : 'facts';
  const record = useQuery({
    queryKey: [session.workspace.id, 'record', id],
    queryFn: ({ signal }) => api.record(id, undefined, signal),
  });
  const [edit, setEdit] = useState<FieldView | null>(null),
    [history, setHistory] = useState<FieldView | null>(null),
    [historyCursor, setHistoryCursor] = useState<string>(),
    [retract, setRetract] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const rid = record.data?.id ?? id;
  const facts = useQuery({
    queryKey: [session.workspace.id, 'facts', rid, search.cursor],
    queryFn: ({ signal }) => api.facts(rid, { cursor: search.cursor, signal }),
    enabled: !!record.data && tab === 'facts',
  });
  const interactions = useQuery({
    queryKey: [session.workspace.id, 'recordInteractions', rid, search.cursor],
    queryFn: ({ signal }) => api.recordInteractions(rid, { cursor: search.cursor, signal }),
    enabled: !!record.data && tab === 'interactions',
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
        f.settings.targetObject === record.data?.object &&
        f.settings.relationCardinality === 'many_to_one',
    ) ?? [];
  const taskFilter = {
    and: [{ status: { neq: 'done' } }, { or: links.map((f) => ({ [f.name]: { eq: rid } })) }],
  };
  const tasks = useQuery({
    queryKey: [session.workspace.id, 'tasks', rid, search.cursor],
    queryFn: ({ signal }) =>
      api.queryRecords(
        'task',
        {
          filter: taskFilter,
          limit: 50,
          cursor: search.cursor,
          sort: [{ field: 'dueDate', direction: 'asc' }],
        },
        signal,
      ),
    enabled: tab === 'tasks' && !!record.data && links.length > 0,
  });
  const object = schema.objects.find((o) => o.nameSingular === record.data?.object),
    canWrite = canMutate(session);
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
  if (!record.data)
    return (
      <Page title="Record">
        {record.error ? (
          <QueryError error={record.error} retry={() => void record.refetch()} />
        ) : (
          <Notice>Loading record…</Notice>
        )}
      </Page>
    );
  const r = record.data;
  return (
    <Page
      eyebrow={object?.labelSingular ?? r.object}
      title={r.label || 'Untitled record'}
      description={`Last updated ${new Date(r.updatedAt).toLocaleString()}`}
    >
      {r.id !== id ? (
        <Notice>This record was merged. You’re viewing the surviving record.</Notice>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
      <Panel title="Fields">
        <Stack>
          {object?.fields
            .filter((f) => f.settings.relationCardinality !== 'one_to_many')
            .map((f) => {
              const Display = fields[f.type].Display;
              return (
                <FieldRow key={f.name} label={f.label}>
                  <Row>
                    <SourcedValue
                      field={f}
                      provenance={r.provenance?.[f.name]}
                      viewer={session.actor}
                    >
                      <Display
                        field={f}
                        value={r.fields[f.name]}
                        references={r.relationReferences}
                      />
                    </SourcedValue>
                    {canWrite && !f.readOnly && f.type !== 'json' ? (
                      <Button size="small" onClick={() => setEdit(f)}>
                        Edit {f.label}
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() => {
                        setHistory(f);
                        setHistoryCursor(undefined);
                      }}
                    >
                      History of {f.label}
                    </Button>
                  </Row>
                </FieldRow>
              );
            })}
        </Stack>
      </Panel>
      {object?.fields.some((f) => f.settings.relationCardinality === 'one_to_many') ? (
        <Panel title="Relations">
          {object.fields
            .filter((f) => f.settings.relationCardinality === 'one_to_many')
            .map((f) => {
              const Display = fields[f.type].Display;
              return (
                <FieldRow key={f.name} label={f.label}>
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
                </FieldRow>
              );
            })}
        </Panel>
      ) : null}
      <Tabs
        value={tab}
        onChange={(tab) => void setSearch({ tab, cursor: undefined })}
        items={[
          { value: 'facts', label: 'Facts' },
          { value: 'interactions', label: 'Interactions' },
          { value: 'tasks', label: 'Open tasks' },
        ]}
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
            <Button onClick={() => void setSearch({ cursor: facts.data?.nextCursor ?? undefined })}>
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
              onClick={() => void setSearch({ cursor: interactions.data?.nextCursor ?? undefined })}
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
            <Button onClick={() => void setSearch({ cursor: tasks.data?.nextCursor ?? undefined })}>
              Load more tasks
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {search.cursor ? (
        <Button onClick={() => void setSearch({ cursor: undefined })}>Back to first page</Button>
      ) : null}
      {edit ? (
        <Editor key={edit.name} field={edit} record={r} onClose={() => setEdit(null)} />
      ) : null}
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
    </Page>
  );
}
