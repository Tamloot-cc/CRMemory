import { useNavigate, useParams } from '@tanstack/react-router';
import { useWorkspace } from '../api/client.js';
import { Notice, Page } from '../ui/index.js';
import { RecordActions } from './record-actions.js';
import { RecordView, useRecord } from './record-view.js';
import { objectLabel, QueryError, recordTitle, useView } from './state.js';

export function RecordPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { schema } = useWorkspace();
  const { search, setSearch } = useView();
  const navigate = useNavigate();
  const record = useRecord(id);
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
      eyebrow={objectLabel(schema, r.object)}
      title={recordTitle(r)}
      description={`Last updated ${new Date(r.updatedAt).toLocaleString()}`}
      actions={
        <RecordActions
          record={r}
          requestedId={id}
          onGone={() => void navigate({ to: '/o/$object', params: { object: r.object } })}
        />
      }
    >
      <RecordView
        key={r.id}
        record={r}
        requestedId={id}
        nav={{
          tab: search.tab,
          cursor: search.cursor,
          kind: search.kind,
          fields: search.fields,
          eventTypes: search.eventTypes,
          set: (change) => void setSearch(change),
        }}
      />
    </Page>
  );
}
