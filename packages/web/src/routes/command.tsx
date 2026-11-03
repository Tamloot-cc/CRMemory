import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, useWorkspace } from '../api/client.js';
import { Badge, Button, Dialog, Input, Muted, Notice, Stack, Truncate } from '../ui/index.js';
import { QueryError, recordTitle, sortObjects, useDebounced } from './state.js';
import { groupRecordHits } from './write-model.js';

/**
 * ⌘K: keyword search across the workspace (`POST /v1/search`), grouped as
 * records by object, then facts, then interactions; and a jump to any object.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session, schema } = useWorkspace();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const typed = text.trim();
  const query = useDebounced(typed);
  const results = useQuery({
    queryKey: [session.workspace.id, 'search', query],
    enabled: open && !!query,
    queryFn: ({ signal }) => api.search({ query, limit: 8 }, signal),
    placeholderData: (previous) => previous,
  });
  const go: typeof navigate = (options) => {
    onOpenChange(false);
    return navigate(options);
  };
  const objects = sortObjects(schema.objects).filter((o) =>
    o.labelPlural.toLowerCase().includes(typed.toLowerCase()),
  );
  const data = query ? results.data : undefined;
  const found = data ? data.records.length + data.facts.length + data.interactions.length : 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Find anything"
      description="Search records, facts and interactions by keyword, or jump to an object."
    >
      <Input
        aria-label="Search the workspace"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search names, notes, emails…"
      />
      {results.error && query ? <QueryError error={results.error} /> : null}
      {query && results.isFetching && !data ? <Notice>Searching…</Notice> : null}
      {data && !found && !results.isFetching ? <Muted>Nothing matches “{query}”.</Muted> : null}
      {data
        ? groupRecordHits(data.records, schema.objects).map((group) => (
            <section key={group.object} aria-label={group.label}>
              <Stack>
                <Muted>{group.label}</Muted>
                {group.hits.map((hit) => (
                  <Button
                    key={hit.id}
                    onClick={() => void go({ to: '/r/$id', params: { id: hit.id } })}
                  >
                    {recordTitle(hit)}
                    {hit.match === 'similar_label' ? <Badge>similar name</Badge> : null}
                  </Button>
                ))}
              </Stack>
            </section>
          ))
        : null}
      {data?.facts.length ? (
        <section aria-label="Facts">
          <Stack>
            <Muted>Facts</Muted>
            {data.facts.map((fact) => (
              <Button
                key={fact.id}
                onClick={() =>
                  void go({
                    to: '/r/$id',
                    params: { id: fact.record },
                    search: { tab: 'facts' },
                  })
                }
              >
                <Truncate>{fact.content}</Truncate>
              </Button>
            ))}
          </Stack>
        </section>
      ) : null}
      {data?.interactions.length ? (
        <section aria-label="Interactions">
          <Stack>
            <Muted>Interactions</Muted>
            {data.interactions.map((hit) => (
              <Button
                key={hit.id}
                onClick={() => void go({ to: '/i/$id', params: { id: hit.id } })}
              >
                {hit.title || 'Untitled interaction'}
                <Badge>{hit.kind}</Badge>
                <Muted>{new Date(hit.occurredAt).toLocaleDateString()}</Muted>
              </Button>
            ))}
          </Stack>
        </section>
      ) : null}
      {objects.length ? (
        <section aria-label="Objects">
          <Stack>
            <Muted>Go to</Muted>
            {objects.map((o) => (
              <Button
                key={o.nameSingular}
                onClick={() => void go({ to: '/o/$object', params: { object: o.nameSingular } })}
              >
                {o.labelPlural}
              </Button>
            ))}
          </Stack>
        </section>
      ) : null}
    </Dialog>
  );
}
