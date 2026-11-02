import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { cn } from './core.js';
import { OWNS_ESCAPE } from './sheet.js';

/** A titled group on a record: fields, relations. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function PropertyList({ children }: { children: ReactNode }) {
  return <dl className="-mx-2 flex flex-col">{children}</dl>;
}

const INTERACTIVE = 'a,button,input,select,textarea,label';

/**
 * One field of a record: label, then value. With `onEdit`, clicking the value
 * starts editing it in place; `actions` (edit, history) appear on hover or
 * focus. While `editing`, the editor takes the row's full width.
 */
export function Property({
  label,
  actions,
  onEdit,
  editing = false,
  children,
}: {
  label: string;
  actions?: ReactNode;
  onEdit?: () => void;
  editing?: boolean;
  children: ReactNode;
}) {
  function click(e: ReactMouseEvent) {
    if (!onEdit || (e.target as Element).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return;
    onEdit();
  }
  return (
    <div
      className={cn(
        'group/property grid items-start gap-x-3 rounded-md px-2 py-1',
        editing ? 'grid-cols-1 gap-y-1.5 py-2' : 'grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)]',
      )}
    >
      <dt className={cn('truncate text-sm text-muted-foreground', !editing && 'py-1.5')}>
        {label}
      </dt>
      <dd className="m-0 min-w-0">
        {editing ? (
          children
        ) : (
          <div className="flex min-h-8 items-start gap-1">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the Edit button is the keyboard path. */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
            <div
              onClick={click}
              className={cn(
                'min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm [overflow-wrap:anywhere]',
                onEdit && 'cursor-text hover:bg-hover',
              )}
            >
              {children}
            </div>
            {actions ? (
              <div className="flex shrink-0 items-center py-0.5 transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover/property:opacity-100">
                {actions}
              </div>
            ) : null}
          </div>
        )}
      </dd>
    </div>
  );
}

/**
 * The editing state of a `Property`: a small form that focuses its first
 * control, saves on Enter or submit, and cancels on Escape.
 */
export function PropertyEditor({
  onSave,
  onCancel,
  children,
}: {
  onSave: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const first = form.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]):not(:disabled),select,textarea,button',
    );
    first?.focus();
    if (first instanceof HTMLInputElement && first.type === 'text') first.select();
  }, []);
  return (
    <form
      ref={form}
      {...{ [OWNS_ESCAPE]: '' }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      onKeyDown={(e) => {
        // Not checking defaultPrevented: the sheet prevents Escape to stay open for us.
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onCancel();
      }}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-sm ring-2 ring-ring/25"
    >
      {children}
    </form>
  );
}

/** Puts focus back on `target` after `active` turns false (an editor closed). */
export function useReturnFocus(active: boolean) {
  const target = useRef<HTMLButtonElement>(null);
  const was = useRef(active);
  useEffect(() => {
    if (was.current && !active) target.current?.focus();
    was.current = active;
  }, [active]);
  return target;
}
