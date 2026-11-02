import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { queryInputSchema } from '../../records/query.js';
import {
  createRecord,
  decideAssertion,
  deleteRecord,
  findRecords,
  patchInputSchema,
  patchRecord,
  readRecord,
  sourceSchema,
  upsertInputSchema,
  upsertRecord,
  valuesSchema,
} from '../../records/service.js';
import type { AppEnv } from '../http.js';
import { idParam, readBody } from '../request.js';

const createSchema = z.strictObject({ values: valuesSchema, source: sourceSchema.optional() });

export function recordRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/objects/:object/records', requireScope('write'), async (c) => {
    const { values, source } = await readBody(c, createSchema);
    const idempotencyKey = c.req.header('idempotency-key');
    const result = await createRecord(sql, c.get('caller'), c.req.param('object'), values, {
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(source !== undefined ? { source } : {}),
    });
    return c.json(result, 201);
  });

  app.post('/objects/:object/query', requireScope('read'), async (c) => {
    const input = await readBody(c, queryInputSchema);
    return c.json(await findRecords(sql, c.get('caller'), c.req.param('object'), input));
  });

  app.post('/objects/:object/upsert', requireScope('write'), async (c) => {
    const input = await readBody(c, upsertInputSchema);
    const result = await upsertRecord(sql, c.get('caller'), c.req.param('object'), input);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get('/records/:id', requireScope('read'), async (c) =>
    c.json(await readRecord(sql, c.get('caller'), idParam(c))),
  );

  app.patch('/records/:id', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, patchInputSchema);
    return c.json(await patchRecord(sql, c.get('caller'), id, input));
  });

  app.delete('/records/:id', requireScope('write'), async (c) =>
    c.json(await deleteRecord(sql, c.get('caller'), idParam(c))),
  );

  for (const decision of ['accept', 'reject'] as const) {
    app.post(`/assertions/:id/${decision}`, requireScope('write'), async (c) =>
      c.json(await decideAssertion(sql, c.get('caller'), idParam(c), decision)),
    );
  }
}
