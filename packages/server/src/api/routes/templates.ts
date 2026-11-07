import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import type { AppEnv } from '../../http/response.js';
import { applyTemplateFor, templatesFor } from '../../templates/service.js';

export function templateRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.get('/templates', requireScope('read'), async (c) =>
    c.json(await templatesFor(sql, c.get('caller'))),
  );

  app.post('/templates/:name/apply', requireScope('schema:write'), async (c) =>
    c.json(await applyTemplateFor(sql, c.get('caller'), c.req.param('name'))),
  );
}
