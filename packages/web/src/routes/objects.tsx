import type { FieldView, ObjectView, QueryInput } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ArrowUpDown, ChevronLeft, ChevronRight, Columns3, ListFilter, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { filterValue, operatorsFor } from '../fields/common.js';
import { fields } from '../fields/index.js';
import {
  Button,
  CheckLabel,
  DataGrid,
  Empty,
  FilterChip,
  Form,
  GridFooter,
  Input,
  Inset,
  Label,
  MenuHeader,
  MenuItem,
  MenuList,
  Muted,
  Notice,
  Page,
  Popover,
  RecordLink,
  Select,
  Toolbar,
} from '../ui/index.js';
import { CreateRecordDialog } from './create-record.js';
import {
  addClause,
  type ColumnPrefs,
  defaultColumnOrder,
  defaultColumnWidth,
  describeClause,
  encodeFilter,
  encodeSort,
  type FilterClause,
  type FilterParts,
  isSortable,
  loadColumnPrefs,
  moveColumn,
  nextSort,
  operatorLabel,
  type PageTrail,
  pageRange,
  parseListSearch,
  recordNextPage,
  resolveColumns,
  type SortState,
  saveColumnPrefs,
  setColumnVisible,
  shiftColumn,
} from './list-state.js';
import { RecordSheet } from './record-view.js';
import { QueryError, useView } from './state.js';

const PAGE_SIZE = 50;
const BUILT_IN_SORTS = [
  { name: 'updatedAt', label: 'Updated' },
  { name: 'createdAt', label: 'Created' },
];

export function ObjectPage() {
  const { object: name } = useParams({ strict: false }) as { object: string };
  const { session, schema } = useWorkspace();
  const object = schema.objects.find((o) => o.nameSingular === name || o.namePlural === name);
  if (!object)
    return (
      <Page title="Object unavailable">
        <Notice error>This object is no longer in the schema.</Notice>
      </Page>
    );
  // Remount per object so saved column preferences are read once, on mount.
  return <ObjectList key={`${session.workspace.id}:${name}`} name={name} object={object} />;
}

function ObjectList({ name, object }: { name: string; object: ObjectView }) {
  const { session } = useWorkspace();
  const { search, setSearch } = useView();
  const workspace = session.workspace.id;
  const [error, setError] = useState(''),
    [creating, setCreating] = useState(false);
  const [prefs, setPrefs] = useState(() => loadColumnPrefs(() => localStorage, workspace, name));

  const view = parseListSearch(search);
  const { clauses, custom, sort } = view;
  const input: QueryInput = {
    limit: PAGE_SIZE,
    cursor: search.cursor,
    include: ['relationReferences'],
    ...view.query,
  };
  const query = useQuery({
    queryKey: [workspace, 'records', name, input],
    queryFn: ({ signal }) => api.queryRecords(name, input, signal),
    enabled: !view.error,
  });

  // Cursors only go forward; remember each page's predecessor for "Previous".
  const viewKey = `${search.filter ?? ''}|${search.sort ?? ''}`;
  const [trail, setTrail] = useState<{ key: string; pages: PageTrail }>({
    key: viewKey,
    pages: {},
  });
  const pages = trail.key === viewKey ? trail.pages : {};

  const columns = useMemo(() => resolveColumns(object, prefs), [object, prefs]);
  const order = useMemo(
    () => columns.filter((f) => f.name !== object.labelField).map((f) => f.name),
    [columns, object],
  );
  const gridColumns = useMemo(
    () =>
      columns.map((f, i) => ({
        id: f.name,
        label: f.label,
        width: prefs?.widths[f.name] ?? defaultColumnWidth(f, i === 0),
        sortable: isSortable(f),
        pinned: i === 0,
      })),
    [columns, prefs],
  );
  const references = query.data?.relationReferences;
  const records = query.data?.records;
  const rows = useMemo(
    () =>
      (records ?? []).map((r) => ({
        id: r.id,
        cells: columns.map((f, i) => {
          const Display = fields[f.type].Display;
          const cell = (
            <Display
              key={f.name}
              field={f}
              value={r.fields[f.name]}
              compact
              references={references}
            />
          );
          return i === 0 ? (
            <RecordLink key={f.name} id={r.id} inSheet>
              {r.label ? cell : 'Untitled record'}
            </RecordLink>
          ) : (
            cell
          );
        }),
      })),
    [records, columns, references],
  );
  const openRow = useCallback((id: string) => void setSearch({ record: id }), [setSearch]);

  function savePrefs(next: ColumnPrefs) {
    setPrefs(next);
    if (!saveColumnPrefs(() => localStorage, workspace, name, next))
      setError('Column preferences could not be saved in this browser');
  }
  const saveOrder = (next: string[]) => savePrefs({ order: next, widths: prefs?.widths ?? {} });
  const setFilter = (next: FilterParts | undefined) =>
    void setSearch({ filter: next && encodeFilter(next), cursor: undefined });
  const nextCursor = query.data?.nextCursor;
  const previous = search.cursor ? pages[search.cursor] : undefined;

  return (
    <Page
      layout="fill"
      eyebrow="Objects"
      title={object.labelPlural}
      actions={
        <>
          <ColumnsMenu
            object={object}
            columns={columns}
            order={order}
            onChange={saveOrder}
            onReset={() => savePrefs({ order: defaultColumnOrder(object), widths: {} })}
          />
          {canMutate(session) ? (
            <Button variant="primary" size="small" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New {object.labelSingular.toLowerCase()}
            </Button>
          ) : null}
        </>
      }
    >
      <Toolbar
        end={
          <SortMenu
            object={object}
            sort={sort}
            onChange={(next) => void setSearch({ sort: encodeSort(next), cursor: undefined })}
          />
        }
      >
        {clauses.map((c, i) => (
          <FilterChip
            key={`${c.field}:${c.operator}:${JSON.stringify(c.value)}`}
            {...describeClause(
              c,
              object.fields.find((f) => f.name === c.field),
            )}
            onRemove={() => setFilter({ clauses: clauses.filter((_, j) => j !== i), custom })}
          />
        ))}
        {custom.map((part, i) => (
          <FilterChip
            key={JSON.stringify(part)}
            field="Custom filter"
            value={JSON.stringify(part)}
            removeLabel={
              custom.length > 1 ? `Remove custom filter ${i + 1}` : 'Remove custom filter'
            }
            onRemove={() => setFilter({ clauses, custom: custom.filter((_, j) => j !== i) })}
          />
        ))}
        <FilterMenu
          object={object}
          onApply={(clause) => {
            setError('');
            setFilter({ clauses: addClause(clauses, clause), custom });
          }}
          onError={setError}
        />
        {clauses.length + custom.length > 1 ? (
          <Button variant="ghost" size="small" onClick={() => setFilter(undefined)}>
            Clear filters
          </Button>
        ) : null}
      </Toolbar>
      {error || view.error || query.error ? (
        <Inset>
          {error || view.error ? <Notice error>{error || view.error}</Notice> : null}
          {query.error ? (
            <QueryError error={query.error} retry={() => void query.refetch()} />
          ) : null}
        </Inset>
      ) : null}
      {query.isPending && !view.error ? (
        <Inset>
          <Notice>Loading records…</Notice>
        </Inset>
      ) : rows.length ? (
        <DataGrid
          label={object.labelPlural}
          columns={gridColumns}
          sort={sort ? { column: sort.field, direction: sort.direction } : undefined}
          onSort={(column) => void setSearch({ sort: nextSort(sort, column), cursor: undefined })}
          onResize={(column, width) =>
            savePrefs({ order, widths: { ...prefs?.widths, [column]: width } })
          }
          onReorder={(column, target) => saveOrder(moveColumn(order, column, target))}
          onOpenRow={openRow}
          selectedRow={search.record}
          rows={rows}
        />
      ) : query.data ? (
        <Inset>
          <Empty
            title="No records found"
            description={
              search.filter
                ? 'No records match these filters.'
                : `Ask your agent to add records${canMutate(session) ? ', or create one with the New button' : ', and they will show up here'}.`
            }
          />
        </Inset>
      ) : null}
      {query.data ? (
        <GridFooter
          end={
            <>
              <Button
                variant="ghost"
                size="small"
                disabled={!search.cursor}
                onClick={() => void setSearch({ cursor: previous?.previous })}
              >
                <ChevronLeft size={14} />
                {search.cursor && !previous ? 'First page' : 'Previous'}
              </Button>
              <Button
                variant="ghost"
                size="small"
                disabled={!nextCursor}
                onClick={() => {
                  if (!nextCursor) return;
                  setTrail({
                    key: viewKey,
                    pages: recordNextPage(pages, search.cursor, nextCursor),
                  });
                  void setSearch({ cursor: nextCursor });
                }}
              >
                Next
                <ChevronRight size={14} />
              </Button>
            </>
          }
        >
          {pageRange(pages, search.cursor, rows.length, PAGE_SIZE)}
          {nextCursor ? ' · more available' : ''}
        </GridFooter>
      ) : null}
      {creating ? (
        <CreateRecordDialog
          object={object}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void setSearch({ record: id });
          }}
        />
      ) : null}
      {search.record ? (
        <RecordSheet id={search.record} onClose={() => void setSearch({ record: undefined })} />
      ) : null}
    </Page>
  );
}

function SortMenu({
  object,
  sort,
  onChange,
}: {
  object: ObjectView;
  sort: SortState | undefined;
  onChange: (sort: SortState | undefined) => void;
}) {
  const options = [
    ...object.fields.filter(isSortable).map((f) => ({ name: f.name, label: f.label })),
    ...BUILT_IN_SORTS,
  ];
  const current = sort ? (options.find((o) => o.name === sort.field)?.label ?? sort.field) : '';
  return (
    <Popover
      label="Sort records"
      align="end"
      trigger={
        <Button variant="ghost" size="small">
          <ArrowUpDown size={14} />
          {sort ? `${current} ${sort.direction === 'asc' ? '↑' : '↓'}` : 'Sort'}
        </Button>
      }
    >
      <Label>
        Sort by
        <Select
          aria-label="Sort records"
          value={sort ? `${sort.field}:${sort.direction}` : ''}
          onChange={(e) => {
            const [field = '', direction] = e.target.value.split(':');
            onChange(
              field && (direction === 'asc' || direction === 'desc')
                ? { field, direction }
                : undefined,
            );
          }}
        >
          <option value="">Default order</option>
          {options.flatMap((f) =>
            (['asc', 'desc'] as const).map((direction) => (
              <option key={`${f.name}:${direction}`} value={`${f.name}:${direction}`}>
                {f.label} · {direction === 'asc' ? 'ascending' : 'descending'}
              </option>
            )),
          )}
        </Select>
      </Label>
      <Muted>Or click a column header to sort by it.</Muted>
    </Popover>
  );
}

function FilterMenu({
  object,
  onApply,
  onError,
}: {
  object: ObjectView;
  onApply: (clause: FilterClause) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [field, setField] = useState(''),
    [operator, setOperator] = useState('eq'),
    [value, setValue] = useState<unknown>('');
  const selected = object.fields.find((f) => f.name === field);
  function apply() {
    if (!selected) return;
    try {
      onApply({ field: selected.name, operator, value: filterValue(selected, operator, value) });
      setOpen(false);
      setField('');
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <Popover
      label="Add a filter"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="small">
          <ListFilter size={14} />
          Filter
        </Button>
      }
    >
      <Form onSubmit={apply}>
        <Label>
          Field
          <Select
            aria-label="Filter field"
            value={field}
            onChange={(e) => {
              const f = object.fields.find((f) => f.name === e.target.value);
              setField(e.target.value);
              setOperator(f ? (operatorsFor(f)[0] ?? 'isNull') : 'eq');
              setValue(f?.type === 'boolean' ? true : f?.type === 'number' ? 0 : '');
            }}
          >
            <option value="">Choose a field…</option>
            {object.fields
              .filter((f) => f.isFilterable)
              .map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
          </Select>
        </Label>
        {selected ? (
          <>
            <Label>
              Condition
              <Select
                aria-label="Filter operator"
                value={operator}
                onChange={(e) => {
                  setOperator(e.target.value);
                  setValue(e.target.value === 'isNull' ? true : '');
                }}
              >
                {operatorsFor(selected).map((o) => (
                  <option key={o} value={o}>
                    {operatorLabel(o)}
                  </option>
                ))}
              </Select>
            </Label>
            <FilterControl field={selected} value={value} operator={operator} onChange={setValue} />
            <Button type="submit" variant="primary">
              Apply filter
            </Button>
          </>
        ) : null}
      </Form>
    </Popover>
  );
}

/** `columns` is what the grid shows, label first; `order` is the rest by name. */
function ColumnsMenu({
  object,
  columns,
  order,
  onChange,
  onReset,
}: {
  object: ObjectView;
  columns: FieldView[];
  order: string[];
  onChange: (order: string[]) => void;
  onReset: () => void;
}) {
  const label = columns.find((f) => f.name === object.labelField);
  const shown = columns.filter((f) => f !== label);
  const hidden = object.fields.filter(
    (f) => f.name !== object.labelField && !order.includes(f.name),
  );
  return (
    <Popover
      label="Visible columns"
      align="end"
      trigger={
        <Button size="small">
          <Columns3 size={14} />
          Columns
        </Button>
      }
    >
      <MenuHeader
        title="Visible columns"
        action={
          <Button variant="ghost" size="small" onClick={onReset}>
            Reset
          </Button>
        }
      />
      <MenuList>
        {label ? (
          <MenuItem>
            <CheckLabel>
              <Input type="checkbox" checked disabled />
              <span>{label.label}</span>
            </CheckLabel>
          </MenuItem>
        ) : null}
        {shown.map((f, i) => (
          <MenuItem key={f.name}>
            <CheckLabel>
              <Input
                type="checkbox"
                checked
                onChange={() => onChange(setColumnVisible(order, f.name, false))}
              />
              <span>{f.label}</span>
            </CheckLabel>
            <Button
              variant="ghost"
              size="small"
              aria-label={`Move ${f.label} left`}
              disabled={i === 0}
              onClick={() => onChange(shiftColumn(order, f.name, -1))}
            >
              <ChevronLeft size={14} />
            </Button>
            <Button
              variant="ghost"
              size="small"
              aria-label={`Move ${f.label} right`}
              disabled={i === shown.length - 1}
              onClick={() => onChange(shiftColumn(order, f.name, 1))}
            >
              <ChevronRight size={14} />
            </Button>
          </MenuItem>
        ))}
        {hidden.map((f) => (
          <MenuItem key={f.name} muted>
            <CheckLabel>
              <Input
                type="checkbox"
                checked={false}
                onChange={() => onChange(setColumnVisible(order, f.name, true))}
              />
              <span>{f.label}</span>
            </CheckLabel>
          </MenuItem>
        ))}
      </MenuList>
    </Popover>
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
