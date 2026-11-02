import { ArrowDown, ArrowUp, X } from 'lucide-react';
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';
import { cn, isPlainClick } from './core.js';

export type GridColumn = {
  id: string;
  label: string;
  width: number;
  sortable?: boolean;
  /** Pinned to the left edge; can't be dragged or dropped on. */
  pinned?: boolean;
};
export type GridRow = { id: string; cells: ReactNode[] };

export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 640;
const STEP = 16;
export const clampWidth = (w: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));

/**
 * A spreadsheet-style record grid: sticky header and first column, click a
 * header to sort, drag a header edge to resize, drag a header to reorder.
 * The grid owns no data; changes come back through the callbacks.
 */
export function DataGrid({
  label,
  columns,
  rows,
  sort,
  onSort,
  onResize,
  onReorder,
  onOpenRow,
  selectedRow,
}: {
  label: string;
  columns: GridColumn[];
  rows: GridRow[];
  /** The row whose record is open beside the grid; it stays highlighted. */
  selectedRow?: string;
  sort?: { column: string; direction: 'asc' | 'desc' };
  onSort?: (column: string) => void;
  onResize?: (column: string, width: number) => void;
  onReorder?: (column: string, target: string) => void;
  onOpenRow?: (row: string) => void;
}) {
  const [draft, setDraft] = useState<{ id: string; width: number } | null>(null),
    [dragging, setDragging] = useState<string | null>(null),
    [over, setOver] = useState<string | null>(null);
  const resizing = useRef(false);
  const widthOf = (c: GridColumn) => (draft?.id === c.id ? draft.width : c.width);
  const total = columns.reduce((sum, c) => sum + widthOf(c), 0);

  function startResize(e: ReactPointerEvent<HTMLDivElement>, column: GridColumn) {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    const startX = e.clientX,
      startWidth = column.width;
    let latest = startWidth;
    const move = (ev: PointerEvent) => {
      latest = clampWidth(startWidth + ev.clientX - startX);
      setDraft({ id: column.id, width: latest });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.removeProperty('cursor');
      resizing.current = false;
      setDraft(null);
      if (latest !== startWidth) onResize?.(column.id, latest);
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function keyResize(e: ReactKeyboardEvent, column: GridColumn) {
    const by = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    if (!by) return;
    e.preventDefault();
    onResize?.(column.id, clampWidth(column.width + by));
  }
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: lets keyboard users scroll a wide grid.
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto focus-visible:outline-none"
    >
      <table
        className="border-separate border-spacing-0 text-sm"
        style={{ tableLayout: 'fixed', width: `max(100%, ${total}px)` }}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={{ width: widthOf(c) }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => {
              const sorted = sort?.column === c.id ? sort.direction : undefined;
              const canDrag = !!onReorder && !c.pinned;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={
                    sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                  }
                  draggable={canDrag}
                  onDragStart={(e) => {
                    if (resizing.current) return e.preventDefault();
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', c.id);
                    setDragging(c.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragging || c.pinned || dragging === c.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setOver(c.id);
                  }}
                  onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging && dragging !== c.id) onReorder?.(dragging, c.id);
                    setDragging(null);
                    setOver(null);
                  }}
                  className={cn(
                    'group/th sticky top-0 z-10 h-9 border-b border-r border-border bg-sidebar p-0 text-left text-xs font-medium text-muted-foreground',
                    c.pinned && 'left-0 z-20',
                    canDrag && 'cursor-grab active:cursor-grabbing',
                    dragging === c.id && 'opacity-50',
                    over === c.id && 'shadow-[inset_2px_0_0_var(--color-primary)]',
                  )}
                >
                  <div className="relative flex h-9 items-center">
                    {c.sortable && onSort ? (
                      <button
                        type="button"
                        onClick={() => onSort(c.id)}
                        title={`Sort by ${c.label}`}
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="truncate">{c.label}</span>
                        {sorted === 'asc' ? (
                          <ArrowUp size={12} className="shrink-0 text-foreground" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown size={12} className="shrink-0 text-foreground" />
                        ) : (
                          <ArrowUp
                            size={12}
                            aria-hidden
                            className="shrink-0 opacity-0 transition-opacity group-hover/th:opacity-40"
                          />
                        )}
                      </button>
                    ) : (
                      <span className="truncate px-3">{c.label}</span>
                    )}
                    {onResize ? (
                      // biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element.
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${c.label}`}
                        aria-valuenow={widthOf(c)}
                        aria-valuemin={MIN_COLUMN_WIDTH}
                        aria-valuemax={MAX_COLUMN_WIDTH}
                        tabIndex={0}
                        draggable={false}
                        onPointerDown={(e) => startResize(e, c)}
                        onKeyDown={(e) => keyResize(e, c)}
                        onDragStart={(e) => e.preventDefault()}
                        className={cn(
                          'absolute -right-px top-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-primary/50 focus-visible:bg-primary focus-visible:outline-none',
                          draft?.id === c.id && 'bg-primary',
                        )}
                      />
                    ) : null}
                  </div>
                </th>
              );
            })}
            <th aria-hidden className="sticky top-0 z-10 border-b border-border bg-sidebar" />
          </tr>
        </thead>
        <GridBody rows={rows} columns={columns} onOpenRow={onOpenRow} selectedRow={selectedRow} />
      </table>
    </section>
  );
}

const ROW_BG = 'bg-background group-hover:bg-hover group-data-selected:bg-muted';
const CELL = `border-b border-r border-border p-0 ${ROW_BG}`;
const PINNED_CELL = `${CELL} sticky left-0 z-[5]`;

/** Rows re-render only when their data changes, not while a column is resized or dragged. */
const GridBody = memo(function GridBody({
  rows,
  columns,
  onOpenRow,
  selectedRow,
}: {
  rows: GridRow[];
  columns: GridColumn[];
  onOpenRow?: (row: string) => void;
  selectedRow?: string;
}) {
  function openRow(e: ReactMouseEvent, id: string) {
    if (onOpenRow && isPlainClick(e)) onOpenRow(id);
  }
  return (
    <tbody>
      {rows.map((r) => (
        <tr
          key={r.id}
          onClick={(e) => openRow(e, r.id)}
          data-selected={r.id === selectedRow || undefined}
          className={onOpenRow ? 'group cursor-pointer' : 'group'}
        >
          {r.cells.map((cell, i) => (
            <td key={columns[i]?.id ?? i} className={columns[i]?.pinned ? PINNED_CELL : CELL}>
              <div className="flex h-9 items-center gap-1 overflow-hidden whitespace-nowrap px-3 [&>*]:min-w-0">
                {cell}
              </div>
            </td>
          ))}
          <td aria-hidden className={`border-b border-border ${ROW_BG}`} />
        </tr>
      ))}
    </tbody>
  );
});

/** The bar above a grid: filters on the left, view controls on the right. */
export function Toolbar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 md:px-5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
      {end ? <div className="flex shrink-0 items-center gap-1.5">{end}</div> : null}
    </div>
  );
}

export function FilterChip({
  field,
  operator,
  value,
  removeLabel = `Remove filter ${field}`,
  onRemove,
}: {
  field: string;
  operator?: string;
  value?: string;
  removeLabel?: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 pl-2 text-xs">
      <span className="shrink-0 font-medium">{field}</span>
      {operator ? <span className="shrink-0 text-muted-foreground">{operator}</span> : null}
      {value ? (
        <span className="truncate font-medium" title={value}>
          {value}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="flex h-full shrink-0 items-center rounded-r-md px-1.5 text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** The bar under a grid: what's shown on the left, paging on the right. */
export function GridFooter({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-t border-border bg-sidebar px-3 text-xs text-muted-foreground md:px-5">
      <div className="min-w-0 flex-1 truncate tabular-nums">{children}</div>
      {end ? <div className="flex shrink-0 items-center gap-1">{end}</div> : null}
    </div>
  );
}
