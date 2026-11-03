import type { Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AuthContext,
  api,
  resetSessionTransport,
  useAuth,
  WorkspaceContext,
} from './api/client.js';
import { SignIn } from './auth/sign-in.js';
import type { ViewSearch } from './routes/state.js';
import { QueryError, sortObjects } from './routes/state.js';
import { Button, Dialog, Input, Notice, ObjectLink, Page, Shell, Stack } from './ui/index.js';
import './style.css';

function Layout() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const [command, setCommand] = useState(false),
    [search, setSearch] = useState('');
  const client = useQueryClient();
  const schema = useQuery({
    queryKey: [session.workspace.id, 'schema'],
    queryFn: async ({ signal }) => {
      const result = await api.schema(signal);
      client.setQueryData([session.workspace.id, 'schema', result.workspace.schemaVersion], result);
      return result;
    },
  });
  const inbox = useQuery({
    queryKey: [session.workspace.id, 'review', 'sidebar-count'],
    queryFn: ({ signal }) => api.review({ limit: 1, signal }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const params = useParams({ strict: false }) as { object?: string };
  const currentObject = schema.data?.objects.find(
    (o) => o.nameSingular === params.object || o.namePlural === params.object,
  );
  const currentRecords = useQuery({
    queryKey: [session.workspace.id, 'commandRecords', currentObject?.nameSingular, search],
    enabled: command && !!search.trim() && !!currentObject,
    queryFn: ({ signal }) =>
      api.queryRecords(
        currentObject?.nameSingular ?? '',
        { search: search.trim(), limit: 20 },
        signal,
      ),
  });
  useEffect(() => {
    const refreshed = (event: Event) => {
      const schema = (event as CustomEvent<import('@retainer/shared').SchemaDescription>).detail;
      if (schema.workspace.id === session.workspace.id) {
        client.setQueryData([session.workspace.id, 'schema'], schema);
        client.setQueryData(
          [session.workspace.id, 'schema', schema.workspace.schemaVersion],
          schema,
        );
      }
    };
    window.addEventListener('retainer:schema-refreshed', refreshed);
    return () => window.removeEventListener('retainer:schema-refreshed', refreshed);
  }, [client, session.workspace.id]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommand((v) => !v);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  if (!schema.data)
    return (
      <Page title="Retainer">
        {schema.error ? (
          <QueryError error={schema.error} retry={() => void schema.refetch()} />
        ) : (
          <Notice>Loading workspace…</Notice>
        )}
        <Button onClick={signOut}>Sign out</Button>
      </Page>
    );
  const objects = sortObjects(schema.data.objects);
  return (
    <WorkspaceContext.Provider value={{ session, schema: schema.data }}>
      <Shell
        workspace={session.workspace.name}
        user={{
          name: session.actor.name || session.actor.id,
          type: session.actor.type,
        }}
        inboxCount={inbox.data?.totals.pendingAssertions}
        objects={objects.map((o) => ({ name: o.nameSingular, label: o.labelPlural }))}
        onSignOut={signOut}
        onSearch={() => setCommand(true)}
      >
        {session.actor.type !== 'user' ? (
          <Notice>
            This key represents a {session.actor.type}. Sign in with a personal user key to make
            changes.
          </Notice>
        ) : null}
        <Outlet />
      </Shell>
      <Dialog
        open={command}
        onOpenChange={setCommand}
        title={currentObject ? `Find in ${currentObject.labelPlural}` : 'Jump to an object'}
        description="Search the current object or jump to another. Global search comes in a later milestone."
      >
        <Input
          aria-label="Find objects or records"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find an object or record…"
        />
        {currentRecords.error ? <QueryError error={currentRecords.error} /> : null}
        {currentObject && search ? (
          <Stack>
            {currentRecords.isFetching ? (
              <Notice>Searching {currentObject.labelPlural}…</Notice>
            ) : null}
            {currentRecords.data?.records.map((r) => (
              <Button
                key={r.id}
                onClick={() => {
                  setCommand(false);
                  void navigate({ to: '/r/$id', params: { id: r.id } });
                }}
              >
                {r.label || 'Untitled record'}
              </Button>
            ))}
          </Stack>
        ) : null}
        <Stack>
          {objects
            .filter((o) => o.labelPlural.toLowerCase().includes(search.toLowerCase()))
            .map((o) => (
              <Button
                key={o.nameSingular}
                onClick={() => {
                  setCommand(false);
                  void navigate({ to: '/o/$object', params: { object: o.nameSingular } });
                }}
              >
                {o.labelPlural}
              </Button>
            ))}
        </Stack>
      </Dialog>
    </WorkspaceContext.Provider>
  );
}
function validateSearch(raw: Record<string, unknown>): ViewSearch {
  const result: ViewSearch = {};
  for (const key of [
    'tab',
    'cursor',
    'filter',
    'sort',
    'assertion',
    'record',
    'object',
    'field',
    'status',
  ] as const)
    if (typeof raw[key] === 'string') result[key] = raw[key];
  return result;
}
const rootRoute = createRootRoute({
  component: Layout,
  validateSearch,
  notFoundComponent: () => (
    <Page title="Page not found">
      <ObjectLink object="person">Browse people</ObjectLink>
    </Page>
  ),
  errorComponent: ({ error, reset }) => (
    <Page title="Something went wrong">
      <QueryError error={error instanceof Error ? error : new Error(String(error))} retry={reset} />
    </Page>
  ),
});
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: lazyRouteComponent(() => import('./routes/review.js'), 'ReviewPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/sign-in',
    component: lazyRouteComponent(() => import('./routes/review.js'), 'ReviewPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/o/$object',
    component: lazyRouteComponent(() => import('./routes/objects.js'), 'ObjectPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/r/$id',
    component: lazyRouteComponent(() => import('./routes/record.js'), 'RecordPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/i/$id',
    component: lazyRouteComponent(() => import('./routes/interaction.js'), 'InteractionPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/schema',
    component: lazyRouteComponent(() => import('./routes/schema.js'), 'SchemaPage'),
  }),
]);
const router = createRouter({ routeTree, basepath: '/app' });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [client, setClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: 'always' },
        },
      }),
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => document.documentElement.classList.toggle('dark', media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .me(controller.signal)
      .then((s) => {
        if (!controller.signal.aborted) setSession(s);
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.status !== 401) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    function expired() {
      void client.cancelQueries();
      client.clear();
      resetSessionTransport();
      setSession(null);
      setLoading(false);
    }
    window.addEventListener('retainer:unauthorized', expired);
    return () => window.removeEventListener('retainer:unauthorized', expired);
  }, [client]);
  function activate(next: Session) {
    setError('');
    void client.cancelQueries();
    client.clear();
    setClient(
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: 'always' },
        },
      }),
    );
    setSession(next);
    resetSessionTransport();
    if (window.location.pathname === '/app/sign-in') window.history.replaceState(null, '', '/app/');
  }
  const signOut = () => {
    void api
      .signOut()
      .then(async () => {
        await client.cancelQueries();
        client.clear();
        resetSessionTransport();
        setSession(null);
        window.history.replaceState(null, '', '/app/sign-in');
      })
      .catch((e) => setError(e.message));
  };
  if (loading)
    return (
      <Page title="Retainer">
        <Notice>Checking session…</Notice>
      </Page>
    );
  return (
    <>
      {error ? <Notice error>{error}</Notice> : null}
      {session ? (
        <QueryClientProvider client={client}>
          <AuthContext.Provider value={{ session, signOut }}>
            <RouterProvider router={router} />
          </AuthContext.Provider>
        </QueryClientProvider>
      ) : (
        <SignIn onSession={activate} />
      )}
    </>
  );
}
const container = document.getElementById('root');
if (container)
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
