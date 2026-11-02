import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Link } from '@tanstack/react-router';
import {
  Box,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CircleCheck,
  Eye,
  FileSignature,
  FileText,
  FolderKanban,
  Handshake,
  House,
  Inbox,
  LogOut,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Shapes,
  UserRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn, Kbd, NavigationContext } from './core.js';

const COLLAPSED_KEY = 'retainer:sidebar:collapsed';

/** Icons for the objects the built-in templates define; anything else gets a box. */
const OBJECT_ICONS: Record<string, LucideIcon> = {
  person: UserRound,
  company: Building2,
  deal: Handshake,
  task: CircleCheck,
  project: FolderKanban,
  property: House,
  viewing: Eye,
  job: BriefcaseBusiness,
  application: FileText,
  proposal: FileSignature,
  appointment: CalendarDays,
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

type ShellProps = {
  workspace: string;
  user: { name: string; type: string };
  objects: { name: string; label: string }[];
  inboxCount?: number;
  onSignOut: () => void;
  onSearch: () => void;
  children: ReactNode;
};

export function Shell({ children, ...props }: ShellProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed),
    [drawer, setDrawer] = useState(false);
  const toggle = () => setCollapsed((c) => !c);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* Collapse still works for this visit. */
    }
  }, [collapsed]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <NavigationContext.Provider value={() => setDrawer(true)}>
      <div className="flex min-h-dvh bg-background text-foreground">
        <aside
          className={cn(
            'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-150 md:flex',
            collapsed ? 'w-[52px]' : 'w-60',
          )}
        >
          <Sidebar {...props} collapsed={collapsed} onToggle={toggle} />
        </aside>
        <DialogPrimitive.Root open={drawer} onOpenChange={setDrawer}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35 md:hidden" />
            <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-border bg-sidebar shadow-xl md:hidden">
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Objects, review inbox and schema
              </DialogPrimitive.Description>
              <Sidebar
                {...props}
                collapsed={false}
                onNavigate={() => setDrawer(false)}
                onSearch={() => {
                  setDrawer(false);
                  props.onSearch();
                }}
              />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </NavigationContext.Provider>
  );
}

function Sidebar({
  workspace,
  user,
  objects,
  inboxCount,
  onSignOut,
  onSearch,
  collapsed,
  onToggle,
  onNavigate,
}: Omit<ShellProps, 'children'> & {
  collapsed: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <>
      <div
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b border-border',
          collapsed ? 'justify-center' : 'px-3',
        )}
      >
        {collapsed ? null : (
          <>
            <span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
            >
              {workspace.trim()[0]?.toUpperCase() ?? 'R'}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{workspace}</span>
          </>
        )}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={toggleLabel}
            title={`${toggleLabel} (⌘\\)`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : null}
      </div>
      <nav
        aria-label="Main navigation"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden p-2"
      >
        <button
          type="button"
          onClick={onSearch}
          title={collapsed ? 'Find anything (⌘K)' : undefined}
          className={navItem(collapsed)}
        >
          <Search size={16} />
          <span className={collapsed ? 'sr-only' : 'flex-1 text-left'}>Find anything</span>
          {collapsed ? null : <Kbd>⌘K</Kbd>}
        </button>
        <NavLink
          to="/"
          icon={Inbox}
          label="Review inbox"
          collapsed={collapsed}
          exact
          onNavigate={onNavigate}
        >
          {inboxCount ? (
            <span
              className={cn(
                'rounded-full bg-primary font-medium tabular-nums text-primary-foreground',
                collapsed
                  ? 'absolute right-1 top-1 h-2 w-2 overflow-hidden text-[0px]'
                  : 'ml-auto px-1.5 text-[11px] leading-4',
              )}
            >
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          ) : null}
        </NavLink>
        {collapsed ? (
          <div className="mx-2 my-2 border-t border-border" />
        ) : (
          <p className="px-2 pb-1 pt-4 text-[11px] font-medium text-muted-foreground">Objects</p>
        )}
        {objects.map((o) => (
          <NavLink
            key={o.name}
            to="/o/$object"
            params={{ object: o.name }}
            icon={OBJECT_ICONS[o.name] ?? Box}
            label={o.label}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
        <div className="flex-1" />
        <NavLink
          to="/schema"
          icon={Shapes}
          label="Schema"
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </nav>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-t border-border p-2',
          collapsed ? 'flex-col' : '',
        )}
      >
        <span
          aria-hidden
          title={collapsed ? user.name : undefined}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold"
        >
          {initials(user.name)}
        </span>
        {collapsed ? null : (
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted-foreground capitalize">{user.type}</div>
          </div>
        )}
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <LogOut size={15} />
        </button>
      </div>
    </>
  );
}

const navItem = (collapsed: boolean) =>
  cn(
    'relative flex h-8 shrink-0 items-center gap-2.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'data-[status=active]:bg-hover data-[status=active]:font-medium data-[status=active]:text-foreground',
    collapsed ? 'mx-auto w-8 justify-center' : 'px-2',
  );

function NavLink({
  to,
  params,
  icon: Icon,
  label,
  collapsed,
  exact = false,
  onNavigate,
  children,
}: {
  to: '/' | '/o/$object' | '/schema';
  params?: { object: string };
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  exact?: boolean;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  return (
    <Link
      to={to}
      params={params as never}
      activeOptions={{ exact, includeSearch: false }}
      onClick={onNavigate}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={navItem(collapsed)}
    >
      <Icon size={16} className="shrink-0" />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {children}
    </Link>
  );
}
