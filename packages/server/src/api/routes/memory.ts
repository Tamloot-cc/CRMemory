import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { addLinksInputSchema, logEventInputSchema } from '../../memory/events.js';
import { rememberInputSchema } from '../../memory/facts.js';
import {
  addEventLinksFor,
  logEventFor,
  readEvent,
  remember,
  removeEventLinkFor,
  retractEventFor,
  retractFactFor,
} from '../../memory/service.js';
import type { AppEnv } from '../http.js';
import { idParam, readBody } from '../request.js';

/** Events and facts (6.2, 6.4), on the same services as the MCP tools. */
export function memoryRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/events', requireScope('write'), async (c) => {
    const input = await readBody(c, logEventInputSchema);
    const result = await logEventFor(sql, c.get('caller'), input);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get('/events/:id', requireScope('read'), async (c) =>
    c.json(await readEvent(sql, c.get('caller'), idParam(c))),
  );

  app.post('/events/:id/links', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, addLinksInputSchema);
    return c.json(await addEventLinksFor(sql, c.get('caller'), id, input));
  });

  app.delete('/events/:id/participants/:participantId', requireScope('write'), async (c) =>
    c.json(
      await removeEventLinkFor(sql, c.get('caller'), idParam(c), {
        participant: idParam(c, 'participantId'),
      }),
    ),
  );

  app.delete('/events/:id/about/:recordId', requireScope('write'), async (c) =>
    c.json(
      await removeEventLinkFor(sql, c.get('caller'), idParam(c), {
        about: idParam(c, 'recordId'),
      }),
    ),
  );

  app.delete('/events/:id', requireScope('write'), async (c) =>
    c.json(await retractEventFor(sql, c.get('caller'), idParam(c))),
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
