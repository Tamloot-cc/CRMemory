import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { fields } from '../fields/index.js';
import { ActorBadge } from '../provenance/index.js';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Muted,
  Notice,
  Page,
  Panel,
  Property,
  PropertyList,
  RecordLink,
  Row,
  Stack,
  Tabs,
} from '../ui/index.js';
import { EventDetailsView } from './event-details.js';
import { AssertionCard } from './record-view.js';
import { eventTitle, objectByName, QueryError, useView } from './state.js';

/**
 * One event (`GET /v1/events/:id`): its type, time, channel, participants and
 * `about` records, its other fields, and the claims that cite it.
 */
export function EventPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { session, schema } = useWorkspace(),
    client = useQueryClient(),
    { search, setSearch } = useView();
  const tab = search.tab === 'facts' ? 'facts' : 'assertions';
  const query = useQuery({
    queryKey: [session.workspace.id, 'event', id],
    queryFn: ({ signal }) => api.event(id, signal),
  });
  const claims = useQuery({
    queryKey: [session.workspace.id, 'claims', id, tab, search.cursor],
    queryFn: ({ signal }) => api.claims(id, { [`${tab}Cursor`]: search.cursor, signal }),
    enabled: !!query.data,
  });
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [deleted, setDeleted] = useState(false);
  const canWrite = canMutate(session);
  async function remove() {
    setBusy(true);
    try {
      const result = await api.deleteEvent(id);
      setMessage(
        `Event deleted: ${result.retractedAssertions} assertions retracted, ${result.recomputedRecordIds.length} records recomputed, ${result.hiddenFactIds.length} facts hidden.`,
      );
      setDeleted(true);
      setConfirm(false);
      client.removeQueries({ queryKey: [session.workspace.id, 'event', id] });
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (deleted)
    return (
      <Page title="Event deleted">
        <Notice>{message}</Notice>
      </Page>
    );
  const r = query.data;
  if (!r?.event)
    return (
      <Page title="Event">
        {query.error ? (
          <QueryError error={query.error} retry={() => void query.refetch()} />
        ) : r ? (
          <Notice error>This record is not an event.</Notice>
        ) : (
          <Notice>Loading event…</Notice>
        )}
      </Page>
    );
  const e = r.event;
  const type = objectByName(schema, r.object);
  // Title and summary show above; the type's other fields are listed here.
  const others = (type?.fields ?? []).filter(
    (f) => !f.coreRole && f.settings.relationCardinality !== 'one_to_many',
  );
  return (
    <Page
      eyebrow={type?.labelSingular ?? r.object}
      title={eventTitle(e)}
      description={`${e.channel ?? 'Channel erased'} · ${new Date(e.occurredAt).toLocaleString()}`}
      actions={
        <>
          <Button asChild variant="ghost" size="small">
            <Link to="/r/$id" params={{ id: r.id }}>
              {canWrite ? 'Edit fields' : 'Open as record'}
            </Link>
          </Button>
          {canWrite ? <Button onClick={() => setConfirm(true)}>Delete event</Button> : null}
        </>
      }
    >
      {message ? <Notice>{message}</Notice> : null}
      <Panel title="Summary">
        <Stack>
          {e.summary ? <p>{e.summary}</p> : <Muted>No summary</Muted>}
          <ActorBadge actor={r.createdBy} />
        </Stack>
      </Panel>
      <Panel title="Details">
        <EventDetailsView id={r.id} event={e} editable={canWrite} />
      </Panel>
      {others.length ? (
        <Panel title="Fields">
          <PropertyList>
            {others.map((f) => {
              const Display = fields[f.type].Display;
              return (
                <Property key={f.name} label={f.label}>
                  <Display field={f} value={r.fields[f.name]} references={r.relationReferences} />
                </Property>
              );
            })}
          </PropertyList>
        </Panel>
      ) : null}
      <Tabs
        value={tab}
        onChange={(tab) => void setSearch({ tab, cursor: undefined })}
        items={[
          { value: 'assertions', label: 'Field assertions' },
          { value: 'facts', label: 'Facts citing this event' },
        ]}
      />
      {claims.error ? <QueryError error={claims.error} /> : null}
      {claims.isPending ? <Notice>Loading claims…</Notice> : null}
      <Stack>
        {tab === 'assertions'
          ? claims.data?.assertions.map((a) => <AssertionCard key={a.id} assertion={a} />)
          : claims.data?.facts.map((f) => (
              <Panel key={f.id}>
                <Stack>
                  <p>{f.content}</p>
                  {f.status ? <Badge>{f.status}</Badge> : null}
                  <RecordLink id={f.record}>View record</RecordLink>
                  <ActorBadge actor={f.writtenBy} />
                  {f.sources
                    .filter((s) => s.event === id && s.quote)
                    .map((s) => (
                      <blockquote key={`${s.event}:${s.quote}`}>{s.quote}</blockquote>
                    ))}
                </Stack>
              </Panel>
            ))}
        {claims.data &&
        !(tab === 'assertions' ? claims.data.assertions : claims.data.facts).length ? (
          <Empty title="No claims in this section" />
        ) : null}
      </Stack>
      <Row>
        {search.cursor ? (
          <Button onClick={() => void setSearch({ cursor: undefined })}>First page</Button>
        ) : null}
        {claims.data?.nextCursors[tab] ? (
          <Button
            onClick={() => void setSearch({ cursor: claims.data?.nextCursors[tab] ?? undefined })}
          >
            Next page
          </Button>
        ) : null}
      </Row>
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
        title="Delete this event?"
        description="The values it recorded are retracted and affected records recomputed. Facts with no other live sources are hidden."
      >
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          Delete event
        </Button>
      </Dialog>
    </Page>
  );
}
