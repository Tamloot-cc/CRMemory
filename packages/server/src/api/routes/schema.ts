import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Backend } from '../../db/backend.js';
import { cursorValue } from '../../db/pagination.js';
import { readWorkspace } from '../../db/protocol.js';
import { SCHEMA_CHANGE_STATUSES, type SchemaChangeStatus } from '../../db/types.js';
import { AppError } from '../../errors.js';
import {
  decideSchemaChange,
  getSchemaChange,
  type SchemaChangeResult,
  schemaChangePage,
} from '../../schema-engine/engine.js';
import {
  describeSchema,
  requestSchemaChange,
  schemaChangeRequestSchema,
} from '../../schema-engine/service.js';
import type { AppEnv } from '../http.js';
import { idParam, limitParam, readBody } from '../request.js';

/** 200 applied or unchanged, 202 waiting for approval, 409 conflicting records. */
function statusFor(result: SchemaChangeResult): 200 | 202 | 409 {
  if (result.status === 'proposed') return 202;
  if (result.status === 'failed') return 409;
  return 200;
}

export function schemaRoutes(app: Hono<AppEnv>, backend: Backend) {
  /** describe_schema: the workspace and its objects and fields (5). */
  app.get('/schema', requireScope('read'), async (c) =>
    c.json(await describeSchema(backend, c.get('caller'))),
  );

  app.post('/schema/changes', requireScope('schema:write'), async (c) => {
    const body = await readBody(c, schemaChangeRequestSchema);
    const result = await requestSchemaChange(backend, c.get('caller'), body);
    return c.json(result, statusFor(result));
  });

  app.get('/schema/changes', requireScope('read'), async (c) => {
    const { workspaceId } = c.get('caller');
    const status = c.req.query('status');
    if (status && !(SCHEMA_CHANGE_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(
        400,
        'invalid_request',
        `status must be one of: ${SCHEMA_CHANGE_STATUSES.join(', ')}`,
      );
    }
    const limit = limitParam(c, 50, 200);
    const cursor = cursorValue(c.req.query('cursor'));
    return c.json(
      await readWorkspace(backend, workspaceId, ({ db }) =>
        schemaChangePage(db, status as SchemaChangeStatus | undefined, limit, cursor),
      ),
    );
  });

  app.get('/schema/changes/:id', requireScope('read'), async (c) => {
    const { workspaceId } = c.get('caller');
    const id = idParam(c);
    return c.json(await readWorkspace(backend, workspaceId, ({ db }) => getSchemaChange(db, id)));
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/schema/changes/:id/${decision}`, requireScope('admin'), async (c) => {
      const caller = c.get('caller');
      const result = await decideSchemaChange(backend, {
        workspaceId: caller.workspaceId,
        changeId: idParam(c),
        actor: caller.actor,
        scopes: caller.scopes,
        decision,
      });
      return c.json(result, result.status === 'failed' ? 409 : 200);
    });
  }
}
