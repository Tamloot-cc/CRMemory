import { EVENT_ATTACHMENTS } from '@retainer/shared';
import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Backend } from '../../db/backend.js';
import { AppError, notFound } from '../../errors.js';
import { findLiveRecord, getRecord } from '../../records/read.js';
import { withRead } from '../../records/service.js';
import { attachedEventPage } from '../../retrieval/history.js';
import type { CompiledSchema } from '../../schema-engine/compiled.js';
import {
  assertionById,
  assertions,
  enrichedRecord,
  type StoredAssertion,
} from '../../web/reads.js';
import { factsCiting, factsPage, reviewPage } from '../../web/review.js';
import type { AppEnv } from '../http.js';
import { idParam, limitParam } from '../request.js';

export function webReadRoutes(app: Hono<AppEnv>, backend: Backend) {
  app.get('/review', requireScope('read'), (c) =>
    withRead(backend, c.get('caller'), async (db, schema) =>
      c.json(
        await reviewPage(
          db,
          c.get('caller').workspaceId,
          schema,
          limitParam(c, 100, 500),
          c.req.query(),
        ),
      ),
    ),
  );
  app.get('/assertions/:id', requireScope('read'), (c) =>
    withRead(backend, c.get('caller'), async (db, schema) =>
      c.json(await assertionById(db, schema, idParam(c))),
    ),
  );
  app.get('/records/:id', requireScope('read'), async (c, next) => {
    if (!c.req.query('include')) return next();
    return withRead(backend, c.get('caller'), async (db, schema) =>
      c.json(
        await enrichedRecord(
          db,
          c.get('caller').workspaceId,
          schema,
          idParam(c),
          (c.req.query('include') ?? '').split(','),
        ),
      ),
    );
  });
  app.get('/records/:id/assertions', requireScope('read'), (c) =>
    withRead(backend, c.get('caller'), async (db, schema) => {
      const record = await findLiveRecord(db, c.get('caller').workspaceId, schema, idParam(c));
      const field = c.req.query('field');
      return c.json(
        await assertions(
          db,
          schema,
          assertionsOfRecord(schema, record.id, field),
          limitParam(c, 50, 200),
          c.req.query('cursor'),
          true,
        ),
      );
    }),
  );
  app.get('/records/:id/events', requireScope('read'), (c) =>
    withRead(backend, c.get('caller'), async (db, schema) => {
      const record = await findLiveRecord(db, c.get('caller').workspaceId, schema, idParam(c));
      const link = c.req.query('link');
      if (link !== undefined && !(EVENT_ATTACHMENTS as readonly string[]).includes(link)) {
        throw new AppError(
          400,
          'invalid_query',
          `link must be one of ${EVENT_ATTACHMENTS.join(', ')}`,
        );
      }
      return c.json(
        await attachedEventPage(
          db,
          schema,
          c.get('caller').workspaceId,
          record.id,
          limitParam(c, 50, 200),
          c.req.query('cursor'),
          link as (typeof EVENT_ATTACHMENTS)[number] | undefined,
        ),
      );
    }),
  );
  app.get('/records/:id/facts', requireScope('read'), (c) =>
    withRead(backend, c.get('caller'), async (db, schema) => {
      const record = await findLiveRecord(db, c.get('caller').workspaceId, schema, idParam(c));
      return c.json({
        record: record.id,
        ...(await factsPage(
          db,
          schema,
          { record: record.id },
          limitParam(c, 100, 500),
          c.req.query('cursor'),
        )),
      });
    }),
  );
  app.get('/events/:id/claims', requireScope('read'), (c) =>
    withRead(backend, c.get('caller'), async (db, schema) => {
      const event = await getRecord(db, c.get('caller').workspaceId, schema, idParam(c));
      if (!event.event) throw notFound('event', { id: event.id });
      const id = event.id;
      const limit = limitParam(c, 50, 200);
      const [a, f] = await Promise.all([
        assertions(
          db,
          schema,
          { where: 'source = $source', vars: { source: id } },
          limit,
          c.req.query('assertionsCursor'),
          true,
        ),
        factsPage(
          db,
          schema,
          { factIds: await factsCiting(db, id) },
          limit,
          c.req.query('factsCursor'),
          true,
        ),
      ]);
      return c.json({
        assertions: a.items,
        facts: f.facts,
        nextCursors: { assertions: a.nextCursor, facts: f.nextCursor },
      });
    }),
  );
}

/**
 * A record's assertions, optionally of the fields with one name (a field
 * name may have been reused after a deletion, so every field ever named so).
 */
function assertionsOfRecord(schema: CompiledSchema, recordId: string, field?: string) {
  const ids = field
    ? [...schema.objectsById.values()].flatMap((object) =>
        object.state.fields.filter((f) => f.name === field).map((f) => f.id as string),
      )
    : undefined;
  return {
    where: 'record = $record',
    vars: { record: recordId },
    ...(ids
      ? { keep: (rows: StoredAssertion[]) => rows.filter((r) => ids.includes(r.field_id)) }
      : {}),
  };
}
