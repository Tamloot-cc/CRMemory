import { Hono } from 'hono';
import type { Sql } from '../db/client.js';
import { VERSION } from '../version.js';

export type AppDeps = {
  sql: Sql;
};

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', async (c) => {
    try {
      await deps.sql`select 1`;
      return c.json({ status: 'ok', version: VERSION, database: 'ok' });
    } catch {
      return c.json({ status: 'error', version: VERSION, database: 'unreachable' }, 503);
    }
  });

  return app;
}
