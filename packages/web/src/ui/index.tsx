import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { Link } from '@tanstack/react-router';
import { cva } from 'class-variance-authority';
import { type ClassValue, clsx } from 'clsx';
import { ArrowUpRight, Database, Inbox, LogOut, Search, Shapes, X } from 'lucide-react';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { twMerge } from 'tailwind-merge';
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
// Adapted from shadcn/ui Button (MIT); see THIRD_PARTY.md.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 h-9 px-3',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90',
        destructive: 'bg-destructive text-white hover:opacity-90',
        outline: 'border border-input bg-background hover:bg-muted',
        ghost: 'hover:bg-muted text-muted-foreground',
      },
      size: { default: '', small: 'h-7 px-2 text-xs' },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
);
export function Button({
  variant = 'outline',
  size = 'default',
  asChild,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'destructive' | 'outline' | 'ghost';
  size?: 'default' | 'small';
  asChild?: boolean;
}) {
  const C = asChild ? Slot : 'button';
  return <C className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        props.type === 'checkbox'
          ? 'h-4 w-4 shrink-0 accent-primary'
          : 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-50'
      }
    />
  );
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
    />
  );
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className="min-h-28 w-full rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
    />
  );
}
export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}
export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}
export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-2 text-sm font-medium">
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
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium',
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
        'rounded-lg border p-4 text-sm',
        error
          ? 'border-destructive/30 text-destructive'
          : 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}
export function Page({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-5 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {eyebrow ? (
            <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      {title ? <h2 className="mb-4 text-sm font-semibold">{title}</h2> : null}
      {children}
    </section>
  );
}
export function Empty({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center">
      <Inbox size={28} strokeWidth={1.4} className="mb-4 text-muted-foreground" />
      <h2 className="font-medium">{title}</h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
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
    <nav aria-label="Sections" className="flex flex-wrap gap-1 border-b border-border">
      {items.map((i) => (
        <button
          type="button"
          key={i.value}
          aria-current={value === i.value ? 'page' : undefined}
          onClick={() => onChange(i.value)}
          className={cn(
            'flex items-center gap-2 border-b-2 px-3 py-3 text-sm',
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
export function RecordLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link to="/r/$id" params={{ id }} className="font-medium hover:underline">
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
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(94vw,42rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-lg border border-border bg-background p-6 shadow-xl">
          <DialogPrimitive.Title className="pr-6 text-lg font-semibold">
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
              className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-muted"
            >
              <X size={18} />
            </button>
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export function Table({ headers, children }: { headers: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            {headers.map((h, i) => (
              <th
                key={String(h)}
                className={cn(
                  'whitespace-nowrap border-b border-border px-4 py-3 font-medium',
                  i === 0 ? 'sticky left-0 bg-muted' : '',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}
export function Tr({ children, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr {...props} className="hover:bg-muted/30">
      {children}
    </tr>
  );
}
export function Td({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <td
      className={cn(
        'max-w-72 px-4 py-3 align-top',
        first ? 'sticky left-0 bg-card font-medium' : '',
      )}
    >
      {children}
    </td>
  );
}
export function FieldRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2 border-b border-border py-3 last:border-0 sm:grid-cols-[180px_1fr]">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}
export function Shell({
  workspace,
  objects,
  onSignOut,
  onSearch,
  children,
}: {
  workspace: string;
  objects: { name: string; label: string }[];
  onSignOut: () => void;
  onSearch: () => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground md:grid md:grid-cols-[220px_1fr]">
      <aside className="border-b border-border bg-sidebar md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-5 py-6 font-semibold tracking-tight">
          <Database size={20} className="text-primary" />
          Retainer<Badge>v1</Badge>
        </div>
        <div className="px-5 pb-4 text-xs text-muted-foreground">{workspace}</div>
        <nav aria-label="Main navigation" className="flex flex-col gap-1 px-3">
          <Button asChild variant="ghost">
            <Link to="/">
              <Inbox size={16} />
              Review inbox
            </Link>
          </Button>
          <Button variant="ghost" onClick={onSearch}>
            <Search size={16} />
            Find anything <kbd className="ml-auto text-xs">⌘K</kbd>
          </Button>
          <p className="px-3 pb-1 pt-5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Objects
          </p>
          {objects.map((o) => (
            <Button key={o.name} asChild variant="ghost">
              <Link to="/o/$object" params={{ object: o.name }}>
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                {o.label}
              </Link>
            </Button>
          ))}
          <div className="my-3 border-t border-border" />
          <Button asChild variant="ghost">
            <Link to="/schema">
              <Shapes size={16} />
              Schema
            </Link>
          </Button>
          <Button onClick={onSignOut} variant="ghost">
            <LogOut size={16} />
            Sign out
          </Button>
        </nav>
        <p className="hidden px-6 pt-10 text-xs leading-relaxed text-muted-foreground md:block">
          Memory you can trace.
          <br />
          Decisions you control.
        </p>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
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
