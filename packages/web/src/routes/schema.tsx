import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import {
  Badge,
  Button,
  Empty,
  Muted,
  Notice,
  Page,
  Panel,
  Row,
  Stack,
  Table,
  Td,
  Tr,
} from '../ui/index.js';
import { SchemaChangeCard } from './review.js';
import { QueryError, useView } from './state.js';
export function SchemaPage() {
  const { session, schema } = useWorkspace(),
    client = useQueryClient(),
    { search, setSearch } = useView();
  const changes = useQuery({
    queryKey: [session.workspace.id, 'schemaChanges', 'all', search.cursor],
    queryFn: ({ signal }) => api.schemaChanges({ cursor: search.cursor, signal }),
  });
  const templates = useQuery({
    queryKey: [session.workspace.id, 'templates'],
    queryFn: ({ signal }) => api.templates(signal),
    enabled: !schema.workspace.templates.length,
  });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function apply(name: string) {
    setBusy(true);
    try {
      await api.applyTemplate(name);
      setMessage('Template applied');
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      eyebrow="Workspace structure"
      title="Schema"
      description={`Version ${schema.workspace.schemaVersion} · Agents propose changes. People approve them.`}
    >
      {message ? <Notice>{message}</Notice> : null}
      {!schema.workspace.templates.length ? (
        <Panel title="Choose a template">
          <Stack>
            {templates.error ? <QueryError error={templates.error} /> : null}
            {templates.data?.templates.map((t) => (
              <Row key={t.name}>
                <strong>{t.label}</strong>
                <Muted>{t.description}</Muted>
                {canMutate(session, 'schema:write') ? (
                  <Button disabled={busy} onClick={() => void apply(t.name)}>
                    Apply {t.label}
                  </Button>
                ) : null}
              </Row>
            ))}
          </Stack>
        </Panel>
      ) : null}
      {schema.objects.map((o) => (
        <Panel key={o.nameSingular} title={o.labelPlural}>
          <Stack>
            <Row>
              <Badge>{o.owner}</Badge>
              <Muted>
                {o.nameSingular} · Label field: {o.labelField || 'none'}
              </Muted>
            </Row>
            <Table headers={['Field', 'Type', 'Flags', 'Owner']}>
              {o.fields.map((f) => (
                <Tr key={f.name}>
                  <Td first>
                    {f.label}
                    <br />
                    <Muted>{f.name}</Muted>
                  </Td>
                  <Td>
                    <Badge>{f.type}</Badge>
                  </Td>
                  <Td>
                    <Row>
                      {!f.isNullable ? <Badge>Required</Badge> : null}
                      {f.isUnique ? <Badge>Unique</Badge> : null}
                      {f.isFilterable ? <Badge>Filterable</Badge> : null}
                      {f.isSearchable ? <Badge>Searchable</Badge> : null}
                      {f.readOnly ? <Badge>Read only</Badge> : null}
                    </Row>
                  </Td>
                  <Td>{f.owner}</Td>
                </Tr>
              ))}
            </Table>
          </Stack>
        </Panel>
      ))}
      <Panel title="Change history">
        <Stack>
          {changes.error ? <QueryError error={changes.error} /> : null}
          {changes.isPending ? <Notice>Loading history…</Notice> : null}
          {changes.data?.changes.map((change) => (
            <SchemaChangeCard
              key={change.id}
              change={change}
              allowed={false}
              busy={false}
              onDecision={() => {}}
            />
          ))}
          {changes.data && !changes.data.changes.length ? <Empty title="No changes yet" /> : null}
          <Row>
            {search.cursor ? (
              <Button onClick={() => void setSearch({ cursor: undefined })}>First page</Button>
            ) : null}
            {changes.data?.nextCursor ? (
              <Button
                onClick={() => void setSearch({ cursor: changes.data?.nextCursor ?? undefined })}
              >
                Load more changes
              </Button>
            ) : null}
          </Row>
        </Stack>
      </Panel>
    </Page>
  );
}
