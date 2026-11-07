import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { authenticate } from '../auth/middleware.js';
import { meRoute, sessionRoutes } from '../auth/session.js';
import { publicOriginSchema } from '../config.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { type RateLimit, rateLimit } from '../http/rate-limit.js';
import { type AppEnv, errorResponse, toAppError } from '../http/response.js';
import { mcpRoute } from '../mcp/route.js';
import { VERSION } from '../version.js';
import { commentRoutes } from './routes/comments.js';
import { memoryRoutes } from './routes/memory.js';
import { recordRoutes } from './routes/records.js';
import { retrievalRoutes } from './routes/retrieval.js';
import { schemaRoutes } from './routes/schema.js';
import { templateRoutes } from './routes/templates.js';
import { viewRoutes } from './routes/views.js';
import { webReadRoutes } from './routes/web-read.js';

export type AppDeps = {
  /** A pool connected as the runtime role, so RLS applies to every query. */
  sql: Sql;
  webDir?: string;
  publicOrigin?: string;
  /**
   * RETAINER_AUTH_SECRET, in accounts mode: people's signed session cookies
   * reach /v1, and the key-mode sign-in at /auth/session is gone (4.1).
   */
  accountsSecret?: string;
  /** The per-workspace rate limit on /v1 and /mcp (accounts spec 4.8); none if unset. */
  rateLimit?: RateLimit;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const publicOrigin = deps.publicOrigin ? publicOriginSchema.parse(deps.publicOrigin) : undefined;

  app.onError((error, c) => errorResponse(c, toAppError(error)));

  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)),
  );

  app.get('/health', async (c) => {
    try {
      await deps.sql`select 1`;
      return c.json({ status: 'ok', version: VERSION, database: 'ok' });
    } catch {
      return c.json({ status: 'error', version: VERSION, database: 'unreachable' }, 503);
    }
  });

  if (!deps.accountsSecret) sessionRoutes(app, deps.sql, publicOrigin);
  const v1 = new Hono<AppEnv>();
  const limit = rateLimit(deps.sql, deps.rateLimit ?? { limit: 0 });
  v1.use('*', authenticate(deps.sql, { publicOrigin, accountsSecret: deps.accountsSecret }));
  v1.use('*', limit);
  meRoute(v1, deps.sql);
  webReadRoutes(v1, deps.sql);
  schemaRoutes(v1, deps.sql);
  templateRoutes(v1, deps.sql);
  recordRoutes(v1, deps.sql);
  memoryRoutes(v1, deps.sql);
  commentRoutes(v1, deps.sql);
  retrievalRoutes(v1, deps.sql);
  viewRoutes(v1, deps.sql);
  app.route('/v1', v1);

  mcpRoute(app, deps.sql, { publicOrigin, rateLimit: limit });

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
