import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { contextInputSchema } from '../../retrieval/context.js';
import { searchInputSchema } from '../../retrieval/search.js';
import { contextFor, searchFor } from '../../retrieval/service.js';
import type { AppEnv } from '../http.js';
import { idParam, readBody, zodError } from '../request.js';

/** Keyword search and context packs (6.1), on the same services as the MCP tools. */
export function retrievalRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/search', requireScope('read'), async (c) => {
    const input = await readBody(c, searchInputSchema);
    return c.json(await searchFor(sql, c.get('caller'), input));
  });

  app.get('/records/:id/context', requireScope('read'), async (c) => {
    const id = idParam(c);
    const raw = c.req.query('tokenBudget');
    const parsed = contextInputSchema.safeParse(
      raw === undefined ? {} : { tokenBudget: Number(raw) },
    );
    if (!parsed.success) throw zodError(parsed.error);
    return c.json(await contextFor(sql, c.get('caller'), id, parsed.data));
  });
}
