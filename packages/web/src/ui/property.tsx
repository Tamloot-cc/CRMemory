import { DismissableLayer } from '@radix-ui/react-dismissable-layer';
import { type MouseEvent as ReactMouseEvent, type ReactNode, useLayoutEffect, useRef } from 'react';
import { cn, isPlainClick } from './core.js';

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

/**
 * One field of a record: label, then value (`children`). With `onEdit`,
 * clicking the value starts editing; `actions` (edit, history) appear on
 * hover or focus. When `editor` is given it replaces the value and takes the
 * row's full width.
 */
export function Property({
  label,
  actions,
  onEdit,
  editor,
  children,
}: {
  label: string;
  actions?: ReactNode;
  onEdit?: () => void;
  editor?: ReactNode;
  children?: ReactNode;
}) {
  function click(e: ReactMouseEvent) {
    if (onEdit && isPlainClick(e)) onEdit();
  }
  return (
    <div
      className={cn(
        'group/property grid items-start gap-x-3 rounded-md px-2 py-1',
        editor ? 'grid-cols-1 gap-y-1.5 py-2' : 'grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)]',
      )}
    >
      <dt className={cn('truncate text-sm text-muted-foreground', !editor && 'py-1.5')}>{label}</dt>
      <dd className="m-0 min-w-0">
        {editor ?? (
          <div className="flex min-h-8 items-start gap-1">
            {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer shortcut; the Edit button is the keyboard path. */}
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
 * control, saves on Enter or submit, and cancels on Escape. It is its own
 * dismissable layer, so Escape reaches it before an enclosing sheet or
 * dialog, wherever focus is inside it.
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
    <DismissableLayer asChild onEscapeKeyDown={onCancel}>
      <form
        ref={form}
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-sm ring-2 ring-ring/25"
      >
        {children}
      </form>
    </DismissableLayer>
  );
}
