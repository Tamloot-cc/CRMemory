import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
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
  RecordLink,
  Row,
  Stack,
  Tabs,
} from '../ui/index.js';
import { CandidateRecord } from './record-actions.js';
import { AssertionCard } from './record-view.js';
import { QueryError, useView } from './state.js';
export function InteractionPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { session } = useWorkspace(),
    client = useQueryClient(),
    { search, setSearch } = useView();
  const tab = search.tab === 'facts' ? 'facts' : 'assertions';
  const query = useQuery({
    queryKey: [session.workspace.id, 'interaction', id],
    queryFn: ({ signal }) => api.interaction(id, signal),
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
  async function retract() {
    setBusy(true);
    try {
      const result = await api.retractInteraction(id);
      setMessage(
        `Interaction retracted: ${result.retractedAssertions} assertions retracted, ${result.recomputedRecordIds.length} records recomputed, ${result.hiddenFactIds.length} facts hidden.`,
      );
      setDeleted(true);
      setConfirm(false);
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (deleted)
    return (
      <Page title="Interaction retracted">
        <Notice>{message}</Notice>
      </Page>
    );
  if (!query.data)
    return (
      <Page title="Interaction">
        {query.error ? <QueryError error={query.error} /> : <Notice>Loading interaction…</Notice>}
      </Page>
    );
  const i = query.data;
  return (
    <Page
      eyebrow={i.kind}
      title={i.title || 'Untitled interaction'}
      description={`${i.channel} · ${new Date(i.occurredAt).toLocaleString()}`}
      actions={
        canMutate(session) ? (
          <Button onClick={() => setConfirm(true)}>Retract interaction</Button>
        ) : null
      }
    >
      {message ? <Notice>{message}</Notice> : null}
      <Panel title="Summary">
        <Stack>
          {i.summary ? <p>{i.summary}</p> : <Muted>No summary</Muted>}
          <ActorBadge actor={i.createdBy} />
        </Stack>
      </Panel>
      <Panel title="Participants">
        <Stack>
          {i.participants.matched.map((p) => (
            <Row key={p.id}>
              <RecordLink id={p.recordId ?? ''}>{p.handle || 'Matched participant'}</RecordLink>
              {p.role ? <Badge>{p.role}</Badge> : null}
            </Row>
          ))}
          {i.participants.unmatched.map((p) => (
            <Row key={p.id}>
              <span>{p.handle || 'Unknown participant'}</span>
              <Badge tone="pending">{p.reason}</Badge>
              {p.role ? <Badge>{p.role}</Badge> : null}
              {p.candidates?.map((id) => (
                <RecordLink key={id} id={id}>
                  Candidate record
                </RecordLink>
              ))}
            </Row>
          ))}
          {!i.participants.matched.length && !i.participants.unmatched.length ? (
            <Muted>No participants</Muted>
          ) : null}
        </Stack>
      </Panel>
      {i.about?.length ? (
        <Panel title="About">
          <Stack>
            {i.about.map((id) => (
              <CandidateRecord key={id} id={id} />
            ))}
          </Stack>
        </Panel>
      ) : null}
      <Tabs
        value={tab}
        onChange={(tab) => void setSearch({ tab, cursor: undefined })}
        items={[
          { value: 'assertions', label: 'Field assertions' },
          { value: 'facts', label: 'Facts citing this interaction' },
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
                    .filter((s) => s.interaction === id && s.quote)
                    .map((s) => (
                      <blockquote key={`${s.interaction}:${s.quote}`}>{s.quote}</blockquote>
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
        title="Retract this interaction?"
        description="Its assertions will be retracted and affected records recomputed. Facts with no other live sources will be hidden."
      >
        <Button variant="destructive" disabled={busy} onClick={() => void retract()}>
          Retract interaction
        </Button>
      </Dialog>
    </Page>
  );
}
