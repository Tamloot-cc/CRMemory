import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { rememberInputSchema } from '../../memory/facts.js';
import { addLinksInputSchema, logInteractionInputSchema } from '../../memory/interactions.js';
import { interactionQuerySchema } from '../../memory/query-interactions.js';
import {
  addInteractionLinksFor,
  logInteractionFor,
  queryInteractionsFor,
  readInteraction,
  remember,
  removeLinkFor,
  retractFactFor,
  retractInteractionFor,
} from '../../memory/service.js';
import type { AppEnv } from '../http.js';
import { idParam, readBody } from '../request.js';

/** The interaction log and facts (6.1), on the same services as the MCP tools. */
export function memoryRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/interactions', requireScope('write'), async (c) => {
    const input = await readBody(c, logInteractionInputSchema);
    const result = await logInteractionFor(sql, c.get('caller'), input);
    return c.json(result, result.created ? 201 : 200);
  });

  app.post('/interactions/query', requireScope('read'), async (c) => {
    const input = await readBody(c, interactionQuerySchema);
    return c.json(await queryInteractionsFor(sql, c.get('caller'), input));
  });

  app.get('/interactions/:id', requireScope('read'), async (c) =>
    c.json(await readInteraction(sql, c.get('caller'), idParam(c))),
  );

  app.post('/interactions/:id/participants', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, addLinksInputSchema);
    return c.json(await addInteractionLinksFor(sql, c.get('caller'), id, input));
  });

  app.delete('/interactions/:id/participants/:participantId', requireScope('write'), async (c) =>
    c.json(
      await removeLinkFor(sql, c.get('caller'), idParam(c), {
        participant: idParam(c, 'participantId'),
      }),
    ),
  );

  app.delete('/interactions/:id/about/:recordId', requireScope('write'), async (c) =>
    c.json(
      await removeLinkFor(sql, c.get('caller'), idParam(c), { about: idParam(c, 'recordId') }),
    ),
  );

  app.delete('/interactions/:id', requireScope('write'), async (c) =>
    c.json(await retractInteractionFor(sql, c.get('caller'), idParam(c))),
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
