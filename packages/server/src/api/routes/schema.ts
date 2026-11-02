import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { SCHEMA_CHANGE_STATUSES, type SchemaChangeStatus } from '../../db/schema.js';
import { inWorkspace } from '../../db/tx.js';
import { AppError } from '../../errors.js';
import {
  decideSchemaChange,
  getSchemaChange,
  listSchemaChanges,
  type SchemaChangeResult,
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

export function schemaRoutes(app: Hono<AppEnv>, sql: Sql) {
  /** describe_schema: the workspace and its objects and fields (5). */
  app.get('/schema', requireScope('read'), async (c) =>
    c.json(await describeSchema(sql, c.get('caller'))),
  );

  app.post('/schema/changes', requireScope('schema:write'), async (c) => {
    const body = await readBody(c, schemaChangeRequestSchema);
    const result = await requestSchemaChange(sql, c.get('caller'), body);
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
    const changes = await inWorkspace(sql, workspaceId, (tx) =>
      listSchemaChanges(
        tx,
        workspaceId,
        status as SchemaChangeStatus | undefined,
        limitParam(c, 50, 200),
      ),
    );
    return c.json({ changes });
  });

  app.get('/schema/changes/:id', requireScope('read'), async (c) => {
    const { workspaceId } = c.get('caller');
    const id = idParam(c);
    return c.json(
      await inWorkspace(sql, workspaceId, (tx) => getSchemaChange(tx, workspaceId, id)),
    );
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/schema/changes/:id/${decision}`, requireScope('admin'), async (c) => {
      const caller = c.get('caller');
      const changeId = idParam(c);
      const result = await inWorkspace(sql, caller.workspaceId, (tx) =>
        decideSchemaChange(tx, {
          workspaceId: caller.workspaceId,
          changeId,
          actor: caller.actor,
          scopes: caller.scopes,
          decision,
        }),
      );
      return c.json(result, result.status === 'failed' ? 409 : 200);
    });
  }
}
