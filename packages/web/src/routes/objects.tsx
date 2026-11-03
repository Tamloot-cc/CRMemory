import type {
  AggregateInput,
  AggregateOp,
  AggregateResult,
  FieldView,
  ObjectView,
  QueryInput,
} from '@retainer/shared';
import { aggregateOps } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns3,
  Combine,
  ListFilter,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { filterValue, operatorsFor, PICKERS } from '../fields/common.js';
import { fields } from '../fields/index.js';
import {
  Button,
  CheckLabel,
  DataGrid,
  EditableCell,
  Empty,
  FilterChip,
  FooterButton,
  Form,
  GridFooter,
  type GridSelection,
  IconLabel,
  Input,
  Inset,
  Menu,
  MenuChoice,
  MenuChoices,
  MenuItem,
  MenuLabel,
  MenuList,
  Muted,
  Notice,
  OptionList,
  Page,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Popover,
  RecordLink,
  Segmented,
  SelectMenu,
  Toolbar,
} from '../ui/index.js';
import { CreateRecordDialog } from './create-record.js';
import {
  addClause,
  aggregateLabel,
  type ColumnPrefs,
  defaultColumnOrder,
  defaultColumnWidth,
  describeClause,
  encodeFilter,
  encodeSort,
  type FilterClause,
  type FilterParts,
  formatAggregate,
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
import { MergeDialog } from './merge.js';
import { BulkDeleteDialog } from './record-actions.js';
import { InlineEditor, RecordSheet } from './record-view.js';
import { QueryError, recordTitle, useView } from './state.js';
import { isWritable } from './write-model.js';

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
    [creating, setCreating] = useState(false),
    [bulk, setBulk] = useState<'merge' | 'delete' | null>(null);
  const writable = canMutate(session);
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
  // Totals over every record the view matches, not just this page.
  const footerOps = prefs?.aggregates ?? {};
  const aggregateInput: AggregateInput = {
    filter: view.query.filter,
    // By name, so reordering columns doesn't refetch the same totals.
    aggregates: [...columns]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((f) => {
        const op = footerOps[f.name];
        return op && aggregateOps(f).includes(op) ? [{ field: f.name, op }] : [];
      }),
  };
  const totals = useQuery({
    queryKey: [workspace, 'aggregate', name, aggregateInput],
    queryFn: ({ signal }) => api.aggregate(name, aggregateInput, signal),
    enabled: !view.error,
    placeholderData: (previous) => previous,
  });

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
      (records ?? []).map((r) => {
        const label = recordTitle(r);
        return {
          id: r.id,
          label,
          cells: columns.map((f, i) => {
            const Display = fields[f.type].Display;
            const shown = (
              <Display
                key={f.name}
                field={f}
                value={r.fields[f.name]}
                compact
                references={references}
              />
            );
            const cell =
              i === 0 ? (
                <RecordLink key={f.name} id={r.id} inSheet>
                  {r.label ? shown : label}
                </RecordLink>
              ) : (
                shown
              );
            if (!writable || !isWritable(f)) return cell;
            return (
              <EditableCell
                key={f.name}
                label={`${f.label} of ${label}`}
                wide={!PICKERS[f.type]}
                editor={(close) => (
                  <InlineEditor
                    record={{ ...r, relationReferences: references }}
                    field={f}
                    onDone={close}
                  />
                )}
              >
                {cell}
              </EditableCell>
            );
          }),
        };
      }),
    [records, columns, references, writable],
  );

  // Selection belongs to one page of one view, and only to rows still shown.
  const selectionKey = `${viewKey}|${search.cursor ?? ''}`;
  const [picked, setPicked] = useState<{ key: string; ids: string[] }>({
    key: selectionKey,
    ids: [],
  });
  const shownIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedIds = useMemo(
    () => (picked.key === selectionKey ? shownIds.filter((id) => picked.ids.includes(id)) : []),
    [picked, selectionKey, shownIds],
  );
  const selectRows = useCallback(
    (ids: string[]) => setPicked({ key: selectionKey, ids }),
    [selectionKey],
  );
  const selection = useMemo<GridSelection | undefined>(() => {
    if (!writable) return undefined;
    const selected = new Set(selectedIds);
    return {
      selected,
      onToggle: (id) =>
        selectRows(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]),
      onToggleAll: () => selectRows(selectedIds.length === shownIds.length ? [] : shownIds),
    };
  }, [writable, selectedIds, shownIds, selectRows]);

  const footer = columns.map((f) => (
    <FooterCell
      key={f.name}
      field={f}
      op={footerOps[f.name]}
      result={totals.data}
      onChange={(op) => {
        const { [f.name]: _, ...rest } = footerOps;
        patchPrefs({ aggregates: op ? { ...rest, [f.name]: op } : rest });
      }}
    />
  ));
  const openRow = useCallback((id: string) => void setSearch({ record: id }), [setSearch]);

  function savePrefs(next: ColumnPrefs) {
    setPrefs(next);
    if (!saveColumnPrefs(() => localStorage, workspace, name, next))
      setError('Column preferences could not be saved in this browser');
  }
  /** Changes some preferences and keeps the rest. */
  const patchPrefs = (patch: Partial<ColumnPrefs>) =>
    savePrefs({ order, widths: {}, ...prefs, ...patch });
  const saveOrder = (next: string[]) => patchPrefs({ order: next });
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
          {writable ? (
            <Button variant="primary" size="small" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New {object.labelSingular.toLowerCase()}
            </Button>
          ) : null}
        </>
      }
    >
      {selectedIds.length ? (
        <Toolbar
          end={
            <Button variant="ghost" size="small" onClick={() => selectRows([])}>
              Clear selection
            </Button>
          }
        >
          <Muted>{selectedIds.length} selected</Muted>
          {selectedIds.length === 2 ? (
            <Button size="small" onClick={() => setBulk('merge')}>
              <Combine size={14} />
              Merge…
            </Button>
          ) : null}
          <Button variant="destructive" size="small" onClick={() => setBulk('delete')}>
            <Trash2 size={14} />
            Delete…
          </Button>
        </Toolbar>
      ) : (
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
      )}
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
            patchPrefs({ widths: { ...prefs?.widths, [column]: width } })
          }
          onReorder={(column, target) => saveOrder(moveColumn(order, column, target))}
          onOpenRow={openRow}
          selectedRow={search.record}
          rows={rows}
          selection={selection}
          footer={footer}
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
          {pageRange(pages, search.cursor, rows.length, PAGE_SIZE, totals.data?.total)}
          {nextCursor && !totals.data ? ' · more available' : ''}
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
      {bulk === 'merge' && selectedIds.length === 2 ? (
        <MergeDialog ids={selectedIds as [string, string]} onClose={() => setBulk(null)} />
      ) : null}
      {bulk === 'delete' && selectedIds.length ? (
        <BulkDeleteDialog
          ids={selectedIds}
          noun={[object.labelSingular.toLowerCase(), object.labelPlural.toLowerCase()]}
          onClose={() => setBulk(null)}
          onDone={(failed, deleted) => {
            setBulk(null);
            selectRows(failed);
            if (search.record && deleted.includes(search.record))
              void setSearch({ record: undefined });
          }}
        />
      ) : null}
      {search.record ? (
        <RecordSheet id={search.record} onClose={() => void setSearch({ record: undefined })} />
      ) : null}
    </Page>
  );
}

/** A column's footer: what it computes over the whole view, chosen from a menu. */
function FooterCell({
  field,
  op,
  result,
  onChange,
}: {
  field: FieldView;
  op: AggregateOp | undefined;
  result: AggregateResult | undefined;
  onChange: (op: AggregateOp | undefined) => void;
}) {
  const ops = aggregateOps(field);
  if (!ops.length) return null;
  const value = op ? result?.values.find((v) => v.field === field.name && v.op === op) : undefined;
  return (
    <Menu
      label={`Calculate ${field.label}`}
      trigger={
        <FooterButton aria-label={`Calculate ${field.label}`}>
          {!op ? 'Calculate' : value ? formatAggregate(field, value) : aggregateLabel(field, op)}
        </FooterButton>
      }
    >
      <MenuChoices
        value={op ?? 'none'}
        onChange={(next) => onChange(next === 'none' ? undefined : (next as AggregateOp))}
      >
        <MenuChoice value="none">None</MenuChoice>
        {ops.map((o) => (
          <MenuChoice key={o} value={o}>
            {aggregateLabel(field, o)}
          </MenuChoice>
        ))}
      </MenuChoices>
    </Menu>
  );
}

/** A field's name with its type's icon. */
function FieldLabel({ field }: { field: FieldView }) {
  return <IconLabel icon={fields[field.type].icon}>{field.label}</IconLabel>;
}
const fieldOption = (f: FieldView) => ({
  value: f.name,
  label: f.label,
  content: <FieldLabel field={f} />,
});

/** Pick a field to sort by; the direction applies to whichever is chosen. */
function SortMenu({
  object,
  sort,
  onChange,
}: {
  object: ObjectView;
  sort: SortState | undefined;
  onChange: (sort: SortState | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const options = [
    ...object.fields.filter(isSortable).map(fieldOption),
    ...BUILT_IN_SORTS.map((s) => ({ value: s.name, label: s.label })),
  ];
  const current = sort ? (options.find((o) => o.value === sort.field)?.label ?? sort.field) : '';
  const shownDirection = sort?.direction ?? direction;
  return (
    <Popover
      label="Sort records"
      align="end"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="small">
          <ArrowUpDown size={14} />
          {sort ? `${current} ${sort.direction === 'asc' ? '↑' : '↓'}` : 'Sort'}
        </Button>
      }
    >
      <OptionList
        label="Sort by"
        placeholder="Search fields…"
        searchable={options.length > 7}
        options={options}
        selected={sort ? [sort.field] : []}
        onPick={(field) => {
          onChange({ field, direction: shownDirection });
          setOpen(false);
        }}
      />
      <PanelFooter>
        <Segmented
          label="Sort direction"
          value={shownDirection}
          options={[
            { value: 'asc', label: 'Ascending', icon: <ArrowUp size={12} /> },
            { value: 'desc', label: 'Descending', icon: <ArrowDown size={12} /> },
          ]}
          onChange={(next) => {
            setDirection(next);
            if (sort) onChange({ field: sort.field, direction: next });
          }}
        />
        {sort ? (
          <Button variant="ghost" size="small" onClick={() => onChange(undefined)}>
            <X size={14} />
            Clear
          </Button>
        ) : null}
      </PanelFooter>
    </Popover>
  );
}

/** First the field to filter on, from a searchable list; then its condition and value. */
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
  function choose(name: string) {
    const f = object.fields.find((f) => f.name === name);
    setField(name);
    setOperator(f ? (operatorsFor(f)[0] ?? 'isNull') : 'eq');
    setValue(f?.type === 'boolean' ? true : f?.type === 'number' ? 0 : '');
  }
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
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setField('');
      }}
      trigger={
        <Button variant="ghost" size="small">
          <ListFilter size={14} />
          Filter
        </Button>
      }
    >
      {selected ? (
        <>
          <PanelHeader
            title={<FieldLabel field={selected} />}
            back={{ label: 'Choose another field', onClick: () => setField('') }}
          />
          <PanelBody>
            <Form onSubmit={apply} autoFocus>
              <SelectMenu
                label="Filter operator"
                fill
                value={operator}
                options={operatorsFor(selected).map((o) => ({
                  value: o,
                  label: operatorLabel(o),
                }))}
                onChange={(next) => {
                  setOperator(next);
                  setValue(next === 'isNull' ? true : '');
                }}
              />
              <FilterControl
                field={selected}
                value={value}
                operator={operator}
                onChange={setValue}
              />
              <Button type="submit" variant="primary">
                Apply filter
              </Button>
            </Form>
          </PanelBody>
        </>
      ) : (
        <OptionList
          label="Filter by"
          placeholder="Search fields…"
          options={object.fields.filter((f) => f.isFilterable).map(fieldOption)}
          empty="No fields match"
          onPick={choose}
        />
      )}
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
      <PanelHeader
        title="Columns"
        action={
          <Button variant="ghost" size="small" onClick={onReset}>
            Reset
          </Button>
        }
      />
      <MenuList>
        <MenuLabel>Shown</MenuLabel>
        {label ? (
          <MenuItem>
            <CheckLabel>
              <Input type="checkbox" checked disabled />
              <FieldLabel field={label} />
            </CheckLabel>
          </MenuItem>
        ) : null}
        {shown.map((f, i) => (
          <MenuItem
            key={f.name}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="iconSmall"
                  aria-label={`Move ${f.label} left`}
                  title="Move left"
                  disabled={i === 0}
                  onClick={() => onChange(shiftColumn(order, f.name, -1))}
                >
                  <ChevronUp size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="iconSmall"
                  aria-label={`Move ${f.label} right`}
                  title="Move right"
                  disabled={i === shown.length - 1}
                  onClick={() => onChange(shiftColumn(order, f.name, 1))}
                >
                  <ChevronDown size={14} />
                </Button>
              </>
            }
          >
            <CheckLabel>
              <Input
                type="checkbox"
                checked
                onChange={() => onChange(setColumnVisible(order, f.name, false))}
              />
              <FieldLabel field={f} />
            </CheckLabel>
          </MenuItem>
        ))}
        {hidden.length ? <MenuLabel>Hidden</MenuLabel> : null}
        {hidden.map((f) => (
          <MenuItem key={f.name} muted>
            <CheckLabel>
              <Input
                type="checkbox"
                checked={false}
                onChange={() => onChange(setColumnVisible(order, f.name, true))}
              />
              <FieldLabel field={f} />
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
