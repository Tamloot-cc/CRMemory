import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { Link } from '@tanstack/react-router';
import { cva } from 'class-variance-authority';
import { ArrowUpRight, ChevronRight, Database, Inbox, Menu, X } from 'lucide-react';
import {
  type ComponentProps,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useContext,
} from 'react';
import { cn, NavigationContext } from './core.js';

// Adapted from shadcn/ui Button (MIT); see THIRD_PARTY.md.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90',
        destructive: 'bg-destructive text-white hover:opacity-90',
        outline: 'border border-input bg-background hover:bg-hover',
        ghost: 'hover:bg-hover text-muted-foreground hover:text-foreground',
      },
      size: {
        default: 'h-8 px-3',
        small: 'h-7 px-2 text-xs',
        icon: 'h-8 w-8 px-0',
        iconSmall: 'h-7 w-7 px-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
);
/** Defaults to `type="button"`, so only an explicit submit button submits a form. */
export function Button({
  variant = 'outline',
  size = 'default',
  asChild,
  className,
  ...props
}: ComponentProps<'button'> & {
  variant?: 'primary' | 'destructive' | 'outline' | 'ghost';
  size?: 'default' | 'small' | 'icon' | 'iconSmall';
  asChild?: boolean;
}) {
  const C = asChild ? Slot : 'button';
  return (
    <C
      type={asChild ? undefined : 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        props.type === 'checkbox'
          ? 'h-4 w-4 shrink-0 accent-primary'
          : 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:opacity-50'
      }
    />
  );
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
    />
  );
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className="min-h-28 w-full rounded-md border border-input bg-background p-2.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
    />
  );
}
export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}
export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5 text-sm font-medium">
      {children}
    </label>
  );
}
/** A checkbox (or radio) beside its label, on one line. */
export function CheckLabel({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child.
    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm [&>span]:truncate">
      {children}
    </label>
  );
}
export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'pending' | 'success';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-xs font-medium',
        tone === 'pending'
          ? 'border-amber-300/40 text-amber-700 dark:text-amber-300'
          : tone === 'success'
            ? 'border-emerald-300/40 text-emerald-700 dark:text-emerald-300'
            : 'border-border text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={cn(
        'rounded-lg border px-3 py-2.5 text-sm',
        error
          ? 'border-destructive/30 text-destructive'
          : 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A screen: a slim top bar with breadcrumb and actions, then the content.
 * `layout="fill"` gives the content the rest of the viewport with no padding,
 * for grids that scroll on their own.
 */
export function Page({
  eyebrow,
  title,
  description,
  actions,
  layout = 'default',
  children,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
} & ({ layout?: 'default'; description?: string } | { layout: 'fill'; description?: never })) {
  const openNavigation = useContext(NavigationContext);
  const fill = layout === 'fill';
  return (
    <section className={cn('flex flex-col', fill ? 'h-dvh' : 'min-h-dvh')}>
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur md:px-5">
        {openNavigation ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="-ml-1 md:hidden"
            onClick={openNavigation}
          >
            <Menu size={16} />
          </Button>
        ) : null}
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {eyebrow ? (
            <>
              <span className="hidden max-w-48 truncate text-muted-foreground first-letter:uppercase sm:inline-block">
                {eyebrow}
              </span>
              <ChevronRight
                size={14}
                aria-hidden
                className="hidden shrink-0 text-muted-foreground/60 sm:inline"
              />
            </>
          ) : null}
          {fill ? (
            <h1 className="truncate font-medium">{title}</h1>
          ) : (
            <span className="truncate font-medium">{title}</span>
          )}
        </div>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {children}
        </div>
      )}
    </section>
  );
}
/** Padded area inside a `fill` page, for notices and empty states. */
export function Inset({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 p-3 md:px-5">{children}</div>;
}
export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      {title ? (
        <h2 className="border-b border-border px-4 py-2.5 text-sm font-medium">{title}</h2>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}
export function Empty({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center">
      <Inbox size={24} strokeWidth={1.4} className="mb-3 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <nav
      aria-label="Sections"
      className="flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {items.map((i) => (
        <button
          type="button"
          key={i.value}
          aria-current={value === i.value ? 'page' : undefined}
          onClick={() => onChange(i.value)}
          className={cn(
            '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-2.5 py-2 text-sm',
            value === i.value
              ? 'border-primary font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {i.label}
          {i.count !== undefined ? <Badge>{i.count}</Badge> : null}
        </button>
      ))}
    </nav>
  );
}
/** Links to the record page, or with `inSheet` opens it in the current list's sheet (`?record=`). */
export function RecordLink({
  id,
  inSheet = false,
  children,
}: {
  id: string;
  inSheet?: boolean;
  children: ReactNode;
}) {
  const className = 'truncate font-medium hover:underline';
  return inSheet ? (
    <Link
      to="."
      search={(prev: Record<string, unknown>) => ({ ...prev, record: id })}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link to="/r/$id" params={{ id }} className={className}>
      {children}
    </Link>
  );
}
export function InteractionLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link
      to="/i/$id"
      params={{ id }}
      className="text-sm text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
    >
      {children}
    </Link>
  );
}
export function ReviewLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link
      to="/"
      search={{ assertion: id }}
      className="text-xs text-amber-700 underline dark:text-amber-300"
    >
      {children}
    </Link>
  );
}
export function ObjectLink({
  object,
  filter,
  children,
}: {
  object: string;
  filter?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/o/$object"
      params={{ object }}
      search={{ filter }}
      className="text-sm text-muted-foreground hover:underline"
    >
      {children}
    </Link>
  );
}
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https?:\/\//i.test(href);
  return safe ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {children}
      <ArrowUpRight size={12} />
    </a>
  ) : (
    <span>{children}</span>
  );
}
export { Tooltip } from './tooltip.js';
export function Sourced({ children }: { children: ReactNode }) {
  return <span className="underline decoration-dotted underline-offset-4">{children}</span>;
}
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-xs" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(94vw,42rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-lg border border-border bg-background p-5 shadow-xl">
          <DialogPrimitive.Title className="pr-6 text-base font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description
            className={description ? 'text-sm text-muted-foreground' : 'sr-only'}
          >
            {description ?? title}
          </DialogPrimitive.Description>
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-hover"
            >
              <X size={16} />
            </button>
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
/** A small static table inside a page. Record lists use `DataGrid`. */
export function Table({ headers, children }: { headers: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-auto rounded-lg border border-border">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {headers.map((h, i) => (
              <th
                key={String(h)}
                className={cn(
                  'h-9 whitespace-nowrap border-b border-border bg-muted/50 px-3 font-medium',
                  i === 0 ? 'sticky left-0 bg-muted' : '',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">{children}</tbody>
      </table>
    </div>
  );
}
export function Tr({ children, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr {...props} className="group">
      {children}
    </tr>
  );
}
export function Td({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <td
      className={cn(
        'max-w-72 border-b border-border px-3 py-2 align-top group-hover:bg-hover',
        first ? 'sticky left-0 bg-card font-medium' : '',
      )}
    >
      {children}
    </td>
  );
}
export { DataGrid, FilterChip, GridFooter, Toolbar } from './data-grid.js';
export { MenuHeader, MenuItem, MenuList, Popover, PopoverForm } from './popover.js';
export { Property, PropertyEditor, PropertyList, Section } from './property.js';
export { Sheet } from './sheet.js';
export { Shell } from './shell.js';
export function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <section className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-xs">
        <div className="mb-8 flex items-center gap-2 text-lg font-semibold">
          <Database size={22} className="text-primary" />
          Retainer
        </div>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          Your agents remember.
          <br />
          You stay in control.
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">Sign in with your personal API key.</p>
        {children}
      </section>
    </main>
  );
}
