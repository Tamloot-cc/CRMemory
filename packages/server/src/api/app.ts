import { Hono } from 'hono';
import { authenticate } from '../auth/middleware.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { SchemaValidationError } from '../schema-engine/types.js';
import { VERSION } from '../version.js';
import { type AppEnv, errorResponse } from './http.js';
import { recordRoutes } from './routes/records.js';
import { schemaRoutes } from './routes/schema.js';
import { templateRoutes } from './routes/templates.js';

export type AppDeps = {
  /** A pool connected as the runtime role, so RLS applies to every query. */
  sql: Sql;
};

/** Maps errors to `{ error: { code, message, details } }` responses. */
function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  if (error instanceof SchemaValidationError) {
    return new AppError(422, 'schema_invalid', 'the schema change is invalid', {
      issues: error.issues,
    });
  }
  return undefined;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    const known = toAppError(error);
    if (known) return errorResponse(c, known);
    console.error(error);
    return errorResponse(c, new AppError(500, 'internal', 'internal server error'));
  });

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

  const v1 = new Hono<AppEnv>();
  v1.use('*', authenticate(deps.sql));
  schemaRoutes(v1, deps.sql);
  templateRoutes(v1, deps.sql);
  recordRoutes(v1, deps.sql);
  app.route('/v1', v1);

  return app;
}
