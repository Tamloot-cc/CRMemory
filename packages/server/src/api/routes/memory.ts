import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { rememberInputSchema } from '../../memory/facts.js';
import { logInteractionInputSchema } from '../../memory/interactions.js';
import {
  factsOf,
  logInteractionFor,
  readInteraction,
  remember,
  retractFactFor,
  retractInteractionFor,
} from '../../memory/service.js';
import type { AppEnv } from '../http.js';
import { idParam, limitParam, readBody } from '../request.js';

/** The interaction log and facts (6.1), on the same services as the MCP tools. */
export function memoryRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/interactions', requireScope('write'), async (c) => {
    const input = await readBody(c, logInteractionInputSchema);
    const result = await logInteractionFor(sql, c.get('caller'), input);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get('/interactions/:id', requireScope('read'), async (c) =>
    c.json(await readInteraction(sql, c.get('caller'), idParam(c))),
  );

  app.delete('/interactions/:id', requireScope('write'), async (c) =>
    c.json(await retractInteractionFor(sql, c.get('caller'), idParam(c))),
  );

  app.get('/records/:id/facts', requireScope('read'), async (c) =>
    c.json(await factsOf(sql, c.get('caller'), idParam(c), limitParam(c, 100, 500))),
  );

  app.post('/records/:id/facts', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, rememberInputSchema);
    const key = c.req.header('idempotency-key');
    return c.json(await remember(sql, c.get('caller'), id, input, key), 201);
  });

  app.delete('/facts/:id', requireScope('write'), async (c) =>
    c.json(await retractFactFor(sql, c.get('caller'), idParam(c))),
  );
}
