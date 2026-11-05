import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Backend } from '../../db/backend.js';
import { applyTemplateFor, templatesFor } from '../../templates/service.js';
import type { AppEnv } from '../http.js';

export function templateRoutes(app: Hono<AppEnv>, backend: Backend) {
  app.get('/templates', requireScope('read'), async (c) =>
    c.json(await templatesFor(backend, c.get('caller'))),
  );

  app.post('/templates/:name/apply', requireScope('schema:write'), async (c) =>
    c.json(await applyTemplateFor(backend, c.get('caller'), c.req.param('name'))),
  );
}
