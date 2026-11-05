import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Backend } from '../../db/backend.js';
import {
  createView,
  createViewSchema,
  deleteView,
  listViews,
  readView,
  updateView,
  updateViewSchema,
} from '../../views/service.js';
import type { AppEnv } from '../http.js';
import { idParam, readBody } from '../request.js';

/** Saved views of an object's records (ARCHITECTURE.md 1.4). */
export function viewRoutes(app: Hono<AppEnv>, backend: Backend) {
  app.get('/objects/:object/views', requireScope('read'), async (c) =>
    c.json(await listViews(backend, c.get('caller'), c.req.param('object'))),
  );

  app.post('/objects/:object/views', requireScope('write'), async (c) => {
    const input = await readBody(c, createViewSchema);
    return c.json(await createView(backend, c.get('caller'), c.req.param('object'), input), 201);
  });

  app.get('/views/:id', requireScope('read'), async (c) =>
    c.json(await readView(backend, c.get('caller'), idParam(c))),
  );

  app.patch('/views/:id', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, updateViewSchema);
    return c.json(await updateView(backend, c.get('caller'), id, input));
  });

  app.delete('/views/:id', requireScope('write'), async (c) =>
    c.json(await deleteView(backend, c.get('caller'), idParam(c))),
  );
}
