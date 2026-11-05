import type {
  AggregateInput,
  AggregateOp,
  AggregateResult,
  FieldView,
  ObjectView,
  QueryInput,
  SavedView,
  UpdateViewInput,
} from '@retainer/shared';
import { aggregateOps } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookmarkPlus,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns3,
  Combine,
  ListFilter,
  Plus,
  Save,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { filterValue, pickerFor } from '../fields/common.js';
import { fields } from '../fields/index.js';
import {
  ApiName,
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
import { BoardView } from './board-view.js';
import { CalendarView } from './calendar-view.js';
import { CreateRecordDialog } from './create-record.js';
import { useApiName } from './developer.js';
import {
  DEFAULT_EVENT_SORT,
  eventListObject,
  isEventColumn,
  LoggedByAgents,
  listFilterOperators,
  occurredCalendar,
  ParticipantsCell,
  withEventValues,
} from './event-list.js';
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
  shownColumnPrefs,
} from './list-state.js';
import { MergeDialog } from './merge.js';
import { BulkDeleteDialog } from './record-actions.js';
import { InlineEditor, RecordSheet } from './record-view.js';
import { QueryError, recordTitle, useView, type ViewSearch } from './state.js';
import {
  DeleteViewDialog,
  useSaveView,
  ViewDialog,
  ViewOptions,
  ViewSwitcher,
} from './view-bar.js';
import {
  changesToSave,
  effectiveSearch,
  filterParam,
  hasChanges,
  sortParam,
  viewColumns,
  viewsKey,
} from './views-state.js';
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
  return <ObjectList key={`${session.workspace.id}:${name}`} name={name} schemaObject={object} />;
}

function ObjectList({ name, schemaObject }: { name: string; schemaObject: ObjectView }) {
  const { session, schema } = useWorkspace();
  const { search, setSearch } = useView();
  const apiName = useApiName();
  // An event type lists its built-in columns and links beside its fields (5.3).
  const object = useMemo(() => eventListObject(schemaObject, schema), [schemaObject, schema]);
  const workspace = session.workspace.id;
  const [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [bulk, setBulk] = useState<'merge' | 'delete' | null>(null),
    [viewDialog, setViewDialog] = useState<'new' | 'edit' | 'delete' | null>(null);
  const writable = canMutate(session);
  // Events are created only by logging them, and cannot be merged.
  const isEvent = object.class === 'event';
  const [localPrefs, setLocalPrefs] = useState(() =>
    loadColumnPrefs(() => localStorage, workspace, name),
  );
  // Column changes to a saved view this key cannot save, kept for the visit.
  const [unsaved, setUnsaved] = useState<Record<string, ColumnPrefs>>({});

  // Saved views (ARCHITECTURE.md 1.4): `?view=` picks one; without it, all records.
  // Keyed by the singular name, as the view dialogs are, whichever name the address uses.
  const objectName = object.nameSingular;
  const views = useQuery({
    queryKey: viewsKey(workspace, objectName),
    queryFn: ({ signal }) => api.views(objectName, signal),
  });
  const saved = search.view ? views.data?.views.find((v) => v.id === search.view) : undefined;
  const missingView = !!search.view && views.isSuccess && !saved;
  // An event list offers a calendar of when events happened without a saved view.
  const occurred = useMemo(() => occurredCalendar(object), [object]);
  const calendarLayout = isEvent && !search.view && search.layout === 'calendar';
  const kind = saved?.kind ?? (calendarLayout ? 'calendar' : 'table');
  const selectView = useCallback(
    (id: string | undefined, options: { replace?: boolean } = {}) => {
      rememberView(workspace, objectName, id);
      void setSearch(
        {
          view: id,
          filter: undefined,
          sort: undefined,
          cursor: undefined,
          month: undefined,
          layout: undefined,
        },
        options,
      );
    },
    [workspace, objectName, setSearch],
  );
  const opening = useLastView(
    workspace,
    objectName,
    search,
    // If views fail to load, all records it is.
    views.data?.views ?? (views.isError ? [] : undefined),
    selectView,
  );
  // Until the view is known, nothing loads, so the wrong records never flash.
  const resolving = opening || (!!search.view && views.isPending);

  // The URL's filter and sort are unsaved changes on top of the view.
  const effective = effectiveSearch(saved, search);
  const changed = hasChanges(saved, search);
  const view = parseListSearch(effective);
  const { clauses, custom } = view;
  // Events are read newest first unless a sort is chosen; the header shows it.
  const implicitSort = isEvent && !view.query.sort;
  const querySort = implicitSort ? DEFAULT_EVENT_SORT : view.query.sort;
  const sort = view.sort ?? (implicitSort ? DEFAULT_EVENT_SORT[0] : undefined);
  const input: QueryInput = {
    limit: PAGE_SIZE,
    cursor: search.cursor,
    include: ['relationReferences'],
    ...view.query,
    ...(querySort ? { sort: querySort } : {}),
  };
  const query = useQuery({
    queryKey: [workspace, 'records', name, input],
    queryFn: async ({ signal }) => {
      const page = await api.queryRecords(name, input, signal);
      return isEvent ? { ...page, records: page.records.map(withEventValues) } : page;
    },
    enabled: !view.error && !resolving && kind === 'table',
  });
  // Built once per copy of the view, so the grid's memos hold across renders.
  const viewPrefs = useMemo(() => saved && viewColumns(saved), [saved]);
  const prefs = saved ? (unsaved[saved.id] ?? viewPrefs) : localPrefs;

  // Cursors only go forward; remember each page's predecessor for "Previous".
  const viewKey = `${search.view ?? ''}|${effective.filter ?? ''}|${effective.sort ?? ''}`;
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
    enabled: !view.error && !resolving && kind === 'table',
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
        apiName: apiName(f.name),
        width: prefs?.widths[f.name] ?? defaultColumnWidth(f, i === 0),
        sortable: isSortable(f),
        pinned: i === 0,
      })),
    [columns, prefs, apiName],
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
            const shown =
              f.name === 'participants' && r.event ? (
                <ParticipantsCell key={f.name} record={r} field={f} references={references} />
              ) : (
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
                wide={!pickerFor(f)}
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

  const saveView = useSaveView(object);
  async function changeView(change: UpdateViewInput): Promise<boolean> {
    if (!saved) return false;
    try {
      await saveView(saved.id, change);
      return true;
    } catch (e) {
      setError(`The view could not be saved: ${(e as Error).message}`);
      return false;
    }
  }

  function savePrefs(next: ColumnPrefs) {
    if (saved) {
      // A view's columns are part of the view; a key that can't save keeps them for the visit.
      if (!writable) return setUnsaved((u) => ({ ...u, [saved.id]: next }));
      void changeView({ columns: next });
      return;
    }
    setLocalPrefs(next);
    if (!saveColumnPrefs(() => localStorage, workspace, name, next))
      setError('Column preferences could not be saved in this browser');
  }
  /** Changes some preferences and keeps the rest. */
  const patchPrefs = (patch: Partial<ColumnPrefs>) =>
    savePrefs({ order, widths: {}, ...prefs, ...patch });
  const saveOrder = (next: string[]) => patchPrefs({ order: next });
  const setFilter = (next: FilterParts | undefined) =>
    void setSearch({ filter: filterParam(next && encodeFilter(next), saved), cursor: undefined });
  const setSort = (next: string | undefined) =>
    void setSearch({ sort: sortParam(next, saved), cursor: undefined });
  const resetChanges = () =>
    void setSearch({ filter: undefined, sort: undefined, cursor: undefined });
  async function saveChanges() {
    // Unsaved changes stay in the address until the view has them.
    if (saved && (await changeView(changesToSave(saved, search)))) resetChanges();
  }
  const nextCursor = query.data?.nextCursor;
  const previous = search.cursor ? pages[search.cursor] : undefined;

  return (
    <Page
      layout="fill"
      eyebrow={isEvent ? 'Activity' : 'Records'}
      title={object.labelPlural}
      apiName={apiName(object.nameSingular)}
      actions={
        <>
          {kind !== 'calendar' ? (
            <ColumnsMenu
              title={kind === 'board' ? 'Card fields' : 'Columns'}
              object={object}
              columns={columns}
              order={order}
              onChange={saveOrder}
              onReset={() => savePrefs({ order: defaultColumnOrder(object), widths: {} })}
            />
          ) : null}
          {!isEvent ? (
            writable ? (
              <Button variant="primary" size="small" onClick={() => setCreating(true)}>
                <Plus size={14} />
                New {object.labelSingular.toLowerCase()}
              </Button>
            ) : null
          ) : (
            // Events have no New button; say why in its place (5.3).
            <LoggedByAgents />
          )}
        </>
      }
    >
      {selectedIds.length && kind === 'table' ? (
        <Toolbar
          end={
            <Button variant="ghost" size="small" onClick={() => selectRows([])}>
              Clear selection
            </Button>
          }
        >
          <Muted>{selectedIds.length} selected</Muted>
          {selectedIds.length === 2 && !isEvent ? (
            <Button size="small" onClick={() => setBulk('merge')}>
              <Combine size={14} />
              Merge…
            </Button>
          ) : selectedIds.length === 2 ? (
            <Muted small>Events can’t be merged</Muted>
          ) : null}
          <Button variant="destructive" size="small" onClick={() => setBulk('delete')}>
            <Trash2 size={14} />
            Delete…
          </Button>
        </Toolbar>
      ) : (
        <Toolbar
          end={
            <>
              {changed ? (
                <>
                  <Button variant="ghost" size="small" onClick={resetChanges}>
                    Reset
                  </Button>
                  {writable && !view.error ? (
                    <Button size="small" onClick={() => void saveChanges()}>
                      <Save size={14} />
                      Save view
                    </Button>
                  ) : null}
                </>
              ) : !saved && writable && (effective.filter || effective.sort) ? (
                <Button variant="ghost" size="small" onClick={() => setViewDialog('new')}>
                  <BookmarkPlus size={14} />
                  Save as view…
                </Button>
              ) : null}
              {saved && saved.kind !== 'table' && writable ? (
                <ViewOptions object={object} view={saved} onChange={(c) => void changeView(c)} />
              ) : null}
              {isEvent && !saved ? (
                <Segmented
                  label="Layout"
                  value={calendarLayout ? 'calendar' : 'table'}
                  options={[
                    { value: 'table', label: 'Table', icon: <Table2 size={12} /> },
                    { value: 'calendar', label: 'Calendar', icon: <CalendarDays size={12} /> },
                  ]}
                  onChange={(next) =>
                    void setSearch({
                      layout: next === 'calendar' ? 'calendar' : undefined,
                      cursor: undefined,
                      month: undefined,
                    })
                  }
                />
              ) : null}
              <SortMenu
                object={object}
                sort={sort}
                onChange={(next) => setSort(encodeSort(next))}
              />
            </>
          }
        >
          <ViewSwitcher
            object={object}
            views={views.data?.views ?? []}
            current={saved}
            writable={writable}
            onSelect={(id) => selectView(id)}
            onNew={() => setViewDialog('new')}
            onEdit={() => setViewDialog('edit')}
            onDelete={() => setViewDialog('delete')}
          />
          {clauses.map((c, i) => (
            <FilterChip
              key={`${c.field}:${c.operator}:${JSON.stringify(c.value)}`}
              {...describeClause(
                c,
                object.fields.find((f) => f.name === c.field),
                references,
                schema.objects,
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
      {error || view.error || query.error || missingView || saved?.issues.length ? (
        <Inset>
          {error || view.error ? (
            <Notice error onDismiss={error ? () => setError('') : undefined}>
              {error || view.error}
            </Notice>
          ) : null}
          {missingView ? (
            <Notice onDismiss={() => selectView(undefined, { replace: true })}>
              This view was deleted, or only the person who made it can see it. Showing all{' '}
              {object.labelPlural.toLowerCase()}.
            </Notice>
          ) : null}
          {saved?.issues.length ? <Notice>{saved.issues.join('. ')}.</Notice> : null}
          {query.error ? (
            <QueryError error={query.error} retry={() => void query.refetch()} />
          ) : null}
        </Inset>
      ) : null}
      {resolving ? (
        <Inset>
          <Notice>Loading view…</Notice>
        </Inset>
      ) : saved?.kind === 'board' && !view.error ? (
        <BoardView
          object={object}
          view={saved}
          filter={view.query.filter}
          sort={view.query.sort}
          order={prefs?.order}
          writable={writable}
          selected={search.record}
          onOpen={openRow}
          onChangeView={(c) => void changeView(c)}
        />
      ) : (saved?.kind === 'calendar' || calendarLayout) && !view.error ? (
        <CalendarView
          object={object}
          view={saved ?? occurred}
          filter={view.query.filter}
          sort={view.query.sort}
          month={search.month}
          writable={writable}
          selected={search.record}
          onOpen={openRow}
          onMonth={(month) => void setSearch({ month })}
          onChangeView={(c) => void changeView(c)}
        />
      ) : kind !== 'table' ? null : query.isPending && !view.error ? (
        <Inset>
          <Notice>Loading records…</Notice>
        </Inset>
      ) : rows.length ? (
        <DataGrid
          label={object.labelPlural}
          columns={gridColumns}
          sort={sort ? { column: sort.field, direction: sort.direction } : undefined}
          onSort={(column) => setSort(nextSort(view.sort, column))}
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
              effective.filter
                ? 'No records match these filters.'
                : isEvent
                  ? `Ask your agent to log ${object.labelPlural.toLowerCase()}, and they will show up here.`
                  : `Ask your agent to add records${canMutate(session) ? ', or create one with the New button' : ', and they will show up here'}.`
            }
          />
        </Inset>
      ) : null}
      {query.data && kind === 'table' ? (
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
      {creating && !isEvent ? (
        <CreateRecordDialog
          object={object}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void setSearch({ record: id });
          }}
        />
      ) : null}
      {bulk === 'merge' && selectedIds.length === 2 && !isEvent ? (
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
      {viewDialog === 'new' || (viewDialog === 'edit' && saved) ? (
        <ViewDialog
          object={object}
          view={viewDialog === 'edit' ? saved : undefined}
          base={{
            filter: view.query.filter,
            sort: view.query.sort,
            // As the grid shows them: stored ones can name fields that are gone.
            columns: shownColumnPrefs(object, prefs),
          }}
          onClose={() => setViewDialog(null)}
          onSaved={(next) => {
            setViewDialog(null);
            if (next.id !== saved?.id) selectView(next.id);
          }}
        />
      ) : null}
      {viewDialog === 'delete' && saved ? (
        <DeleteViewDialog
          object={object}
          view={saved}
          onClose={() => setViewDialog(null)}
          onDeleted={() => {
            setViewDialog(null);
            selectView(undefined, { replace: true });
          }}
        />
      ) : null}
      {search.record ? (
        <RecordSheet id={search.record} onClose={() => void setSearch({ record: undefined })} />
      ) : null}
    </Page>
  );
}

/** Remembers the view last shown for an object; `''` for all records. */
const lastViewKey = (workspace: string, object: string) =>
  `retainer:view:v1:${workspace}:${object}`;
function rememberView(workspace: string, object: string, id: string | undefined) {
  try {
    localStorage.setItem(lastViewKey(workspace, object), id ?? '');
  } catch {
    /* Not remembering is fine. */
  }
}

/**
 * Opening an object without `?view=` (from the sidebar, say) shows the view
 * last shown here, if it still exists. Only once per visit, and never over
 * an address that has its own filter or sort.
 */
function useLastView(
  workspace: string,
  object: string,
  search: ViewSearch,
  views: SavedView[] | undefined,
  select: (id: string | undefined, options: { replace?: boolean }) => void,
): boolean {
  const [last] = useState(() => {
    if (search.view || search.filter || search.sort) return '';
    try {
      return localStorage.getItem(lastViewKey(workspace, object)) ?? '';
    } catch {
      return '';
    }
  });
  const [done, setDone] = useState(!last);
  useEffect(() => {
    if (done || !views) return;
    setDone(true);
    if (!search.view && views.some((v) => v.id === last)) select(last, { replace: true });
  }, [done, views, last, search.view, select]);
  // True until it knows whether to switch, so all records don't flash first.
  return !done;
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
  // Built-in event columns aren't fields the totals route can compute.
  const ops = isEventColumn(field.name) && field.readOnly ? [] : aggregateOps(field);
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

/** A field's name with its type's icon, and its API name in developer view. */
function FieldLabel({ field }: { field: FieldView }) {
  const apiName = useApiName()(field.name);
  return (
    <IconLabel icon={fields[field.type].icon}>
      {field.label}
      {apiName ? <ApiName>{apiName}</ApiName> : null}
    </IconLabel>
  );
}
const fieldOption = (f: FieldView, apiName?: string) => ({
  value: f.name,
  label: f.label,
  // Search finds a field by its API name too, where it is shown.
  ...(apiName ? { keywords: apiName } : {}),
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
    ...object.fields.filter(isSortable).map((f) => fieldOption(f)),
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

/** What a filter's value starts as when its operator is chosen. */
const initialFilterValue = (operator: string): unknown =>
  operator === 'isNull' || operator === 'isEmpty'
    ? true
    : operator === 'containsAny' || operator === 'containsAll'
      ? []
      : '';

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
  const apiName = useApiName();
  const [open, setOpen] = useState(false),
    [field, setField] = useState(''),
    [operator, setOperator] = useState('eq'),
    [value, setValue] = useState<unknown>('');
  const selected = object.fields.find((f) => f.name === field);
  function choose(name: string) {
    const f = object.fields.find((f) => f.name === name);
    setField(name);
    const first = f ? (listFilterOperators(f)[0] ?? 'isNull') : 'eq';
    setOperator(first);
    setValue(f?.type === 'boolean' ? true : f?.type === 'number' ? 0 : initialFilterValue(first));
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
                options={listFilterOperators(selected).map((o) => ({
                  value: o,
                  label: operatorLabel(o),
                }))}
                onChange={(next) => {
                  setOperator(next);
                  setValue(initialFilterValue(next));
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
          options={object.fields
            .filter((f) => f.isFilterable)
            .map((f) => fieldOption(f, apiName(f.name)))}
          empty="No fields match"
          onPick={choose}
        />
      )}
    </Popover>
  );
}

/** `columns` is what the grid shows, label first; `order` is the rest by name. */
function ColumnsMenu({
  title,
  object,
  columns,
  order,
  onChange,
  onReset,
}: {
  /** "Columns" for a table, "Card fields" for a board. */
  title: string;
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
      label={title === 'Columns' ? 'Visible columns' : title}
      align="end"
      trigger={
        <Button size="small">
          <Columns3 size={14} />
          {title}
        </Button>
      }
    >
      <PanelHeader
        title={title}
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
