import type { FieldView, QueryInput } from '@retainer/shared';
import { SORTABLE_TYPES } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, useWorkspace } from '../api/client.js';
import { filterValue, operatorsFor } from '../fields/common.js';
import { fields } from '../fields/index.js';
import {
  Button,
  Dialog,
  Empty,
  Input,
  Label,
  Muted,
  Notice,
  Page,
  RecordLink,
  Row,
  Select,
  Stack,
  Table,
  Td,
  Tr,
} from '../ui/index.js';
import { QueryError, useView } from './state.js';
export function ObjectPage() {
  const { object: name } = useParams({ strict: false }) as { object: string };
  const { session, schema } = useWorkspace();
  const { search, setSearch } = useView();
  const object = schema.objects.find((o) => o.nameSingular === name || o.namePlural === name);
  const [columnsOpen, setColumnsOpen] = useState(false),
    [error, setError] = useState('');
  const key = `retainer:columns:v1:${session.workspace.id}:${name}`;
  const [preferences, setPreferences] = useState<Record<string, string[]>>({});
  let saved: string[] | undefined = preferences[key];
  if (!saved) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) saved = parsed;
    } catch {
      /* Fall back to schema defaults. */
    }
  }
  const visible =
    saved ??
    object?.fields.filter((f) => f.type !== 'json' && !f.readOnly).map((f) => f.name) ??
    [];
  const columns = (object?.fields ?? [])
    .filter((f) => f.name === object?.labelField || visible.includes(f.name))
    .sort((a, b) => Number(b.name === object?.labelField) - Number(a.name === object?.labelField));
  const [filterField, setFilterField] = useState(''),
    [operator, setOperator] = useState('eq'),
    [value, setValue] = useState<unknown>('');
  const selected = object?.fields.find((f) => f.name === filterField);
  let input: QueryInput = { limit: 50, cursor: search.cursor, include: ['relationReferences'] };
  let parseError = '';
  try {
    input = {
      ...input,
      filter: search.filter ? JSON.parse(search.filter) : undefined,
      sort: search.sort ? JSON.parse(search.sort) : undefined,
    };
  } catch {
    parseError = 'This address contains an invalid filter or sort';
  }
  const query = useQuery({
    queryKey: [session.workspace.id, 'records', name, input],
    queryFn: ({ signal }) => api.queryRecords(name, input, signal),
    enabled: !!object && !parseError,
  });
  function applyFilter() {
    if (!selected) return;
    try {
      const v = filterValue(selected, operator, value);
      void setSearch({
        filter: JSON.stringify({ [selected.name]: { [operator]: v } }),
        cursor: undefined,
      });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function saveColumns(next: string[]) {
    setPreferences((p) => ({ ...p, [key]: next }));
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setError('Column preferences could not be saved in this browser');
    }
  }
  if (!object)
    return (
      <Page title="Object unavailable">
        <Notice error>This object is no longer in the schema.</Notice>
      </Page>
    );
  return (
    <Page
      eyebrow="Objects"
      title={object.labelPlural}
      description={`${object.fields.length} fields · ${object.description ?? 'Agent-written records, with their sources.'}`}
      actions={<Button onClick={() => setColumnsOpen(true)}>Columns</Button>}
    >
      <Row>
        <Select
          aria-label="Filter field"
          value={filterField}
          onChange={(e) => {
            const f = object.fields.find((f) => f.name === e.target.value);
            setFilterField(e.target.value);
            setOperator(f ? (operatorsFor(f)[0] ?? 'isNull') : 'eq');
            setValue(f?.type === 'boolean' ? true : f?.type === 'number' ? 0 : '');
          }}
        >
          <option value="">Filter by…</option>
          {object.fields
            .filter((f) => f.isFilterable)
            .map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
        </Select>
        {selected ? (
          <>
            <Select
              aria-label="Filter operator"
              value={operator}
              onChange={(e) => {
                setOperator(e.target.value);
                setValue(e.target.value === 'isNull' ? true : '');
              }}
            >
              {operatorsFor(selected).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </Select>
            <FilterControl field={selected} value={value} operator={operator} onChange={setValue} />
            <Button onClick={applyFilter}>Apply filter</Button>
          </>
        ) : null}
        {search.filter ? (
          <Button onClick={() => void setSearch({ filter: undefined, cursor: undefined })}>
            Clear filters
          </Button>
        ) : null}
        <Select
          aria-label="Sort records"
          value={search.sort ?? ''}
          onChange={(e) => void setSearch({ sort: e.target.value || undefined, cursor: undefined })}
        >
          <option value="">Default order</option>
          {[
            ...object.fields
              .filter((f) => f.isFilterable && SORTABLE_TYPES.includes(f.type))
              .map((f) => ({ name: f.name, label: f.label })),
            { name: 'updatedAt', label: 'Updated' },
            { name: 'createdAt', label: 'Created' },
          ].flatMap((f) =>
            ['asc', 'desc'].map((direction) => (
              <option
                key={`${f.name}:${direction}`}
                value={JSON.stringify([{ field: f.name, direction }])}
              >
                {f.label} · {direction === 'asc' ? 'ascending' : 'descending'}
              </option>
            )),
          )}
        </Select>
      </Row>
      {search.filter ? <Muted>Filter: {search.filter}</Muted> : null}
      {error || parseError ? <Notice error>{error || parseError}</Notice> : null}
      {query.error ? <QueryError error={query.error} retry={() => void query.refetch()} /> : null}
      {query.isPending && !parseError ? <Notice>Loading records…</Notice> : null}
      {query.data?.records.length ? (
        <Table headers={columns.map((f) => f.label)}>
          {query.data.records.map((r) => (
            <Tr key={r.id}>
              {columns.map((f, i) => {
                const Display = fields[f.type].Display;
                return (
                  <Td first={i === 0} key={f.name}>
                    {i === 0 ? (
                      <RecordLink id={r.id}>
                        <Display
                          field={f}
                          value={r.fields[f.name]}
                          compact
                          references={query.data?.relationReferences}
                        />
                      </RecordLink>
                    ) : (
                      <Display
                        field={f}
                        value={r.fields[f.name]}
                        compact
                        references={query.data?.relationReferences}
                      />
                    )}
                  </Td>
                );
              })}
            </Tr>
          ))}
        </Table>
      ) : query.data ? (
        <Empty
          title="No records found"
          description="Try another filter, or ask your agent to add records."
        />
      ) : null}
      <Row>
        {search.cursor ? (
          <Button onClick={() => void setSearch({ cursor: undefined })}>First page</Button>
        ) : null}
        {query.data?.nextCursor ? (
          <Button onClick={() => void setSearch({ cursor: query.data?.nextCursor ?? undefined })}>
            Next 50 records
          </Button>
        ) : null}
      </Row>
      <Dialog open={columnsOpen} onOpenChange={setColumnsOpen} title="Visible columns">
        <Stack>
          {object.fields.map((f) => (
            <Label key={f.name}>
              <Input
                type="checkbox"
                checked={f.name === object.labelField || visible.includes(f.name)}
                disabled={f.name === object.labelField}
                onChange={(e) =>
                  saveColumns(
                    e.target.checked ? [...visible, f.name] : visible.filter((n) => n !== f.name),
                  )
                }
              />
              {f.label}
            </Label>
          ))}
        </Stack>
      </Dialog>
    </Page>
  );
}
function FilterControl(props: {
  field: FieldView;
  value: unknown;
  operator: string;
  onChange: (v: unknown) => void;
}) {
  const Filter = fields[props.field.type].Filter;
  return <Filter {...props} />;
}
