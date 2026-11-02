import { useParams } from '@tanstack/react-router';
import { useWorkspace } from '../api/client.js';
import { Notice, Page } from '../ui/index.js';
import { RecordView, useRecord } from './record-view.js';
import { QueryError, useView } from './state.js';

export function RecordPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { schema } = useWorkspace();
  const { search, setSearch } = useView();
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
  const object = schema.objects.find((o) => o.nameSingular === r.object);
  return (
    <Page
      eyebrow={object?.labelSingular ?? r.object}
      title={r.label || 'Untitled record'}
      description={`Last updated ${new Date(r.updatedAt).toLocaleString()}`}
    >
      <RecordView
        key={r.id}
        record={r}
        requestedId={id}
        nav={{
          tab: search.tab,
          cursor: search.cursor,
          set: (change) => void setSearch(change),
        }}
      />
    </Page>
  );
}
