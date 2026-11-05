import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { authenticate } from '../auth/middleware.js';
import { meRoute, sessionRoutes } from '../auth/session.js';
import { publicOriginSchema } from '../config.js';
import type { Backend } from '../db/backend.js';
import { operationScope } from '../db/protocol.js';
import { serverHealthy } from '../db/surreal.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { mcpRoute } from '../mcp/route.js';
import { VERSION } from '../version.js';
import { type AppEnv, errorResponse, toAppError } from './http.js';
import { memoryRoutes } from './routes/memory.js';
import { operationRoutes } from './routes/operations.js';
import { recordRoutes } from './routes/records.js';
import { retrievalRoutes } from './routes/retrieval.js';
import { schemaRoutes } from './routes/schema.js';
import { templateRoutes } from './routes/templates.js';
import { viewRoutes } from './routes/views.js';
import { webReadRoutes } from './routes/web-read.js';

export type AppDeps = {
  /** The SurrealDB backend: runtime sessions per workspace (section 4). */
  backend: Backend;
  webDir?: string;
  publicOrigin?: string;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const publicOrigin = deps.publicOrigin ? publicOriginSchema.parse(deps.publicOrigin) : undefined;

  app.onError((error, c) => {
    const known = toAppError(error);
    if (known) return errorResponse(c, known);
    log.error(error);
    return errorResponse(c, new AppError(500, 'internal', 'internal server error'));
  });

  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)),
  );

  app.get('/health', async (c) => {
    if (!deps.backend.writable) {
      return c.json({ status: 'error', version: VERSION, database: 'lease_lost' }, 503);
    }
    if (await serverHealthy(deps.backend.config.url).catch(() => false)) {
      return c.json({ status: 'ok', version: VERSION, database: 'ok' });
    }
    return c.json({ status: 'error', version: VERSION, database: 'unreachable' }, 503);
  });

  sessionRoutes(app, deps.backend, publicOrigin);
  const v1 = new Hono<AppEnv>();
  // A write's operation ID, so a caller can check an unknown outcome later.
  v1.use('*', (c, next) =>
    operationScope.run({}, async () => {
      await next();
      const id = operationScope.getStore()?.id;
      if (id) c.header('Retainer-Operation-Id', id);
    }),
  );
  v1.use('*', authenticate(deps.backend, publicOrigin));
  meRoute(v1, deps.backend);
  webReadRoutes(v1, deps.backend);
  schemaRoutes(v1, deps.backend);
  templateRoutes(v1, deps.backend);
  recordRoutes(v1, deps.backend);
  operationRoutes(v1, deps.backend);
  memoryRoutes(v1, deps.backend);
  retrievalRoutes(v1, deps.backend);
  viewRoutes(v1, deps.backend);
  app.route('/v1', v1);

  mcpRoute(app, deps.backend, publicOrigin);

  if (deps.webDir) {
    const root = resolve(deps.webDir);
    app.get('/app', (c) => c.redirect('/app/'));
    app.use(
      '/app/*',
      serveStatic({ root, rewriteRequestPath: (path) => path.replace(/^\/app/, '') }),
    );
    app.get('/app/*', async (c, next) => {
      if (c.req.path.startsWith('/app/assets/')) return next();
      c.header('Cache-Control', 'no-cache');
      return serveStatic({ path: resolve(root, 'index.html') })(c, next);
    });
  }
  return app;
}
