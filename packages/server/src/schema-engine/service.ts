import type { SchemaDescription } from '@retainer/shared';
import { z } from 'zod';
import type { Backend } from '../db/backend.js';
import { readWorkspace } from '../db/protocol.js';
import type { Caller } from '../records/service.js';
import { readWorkspaceInfo } from '../workspaces/workspaces.js';
import { BUILT_INS } from './built-ins.js';
import { runSchemaChange, type SchemaChangeResult } from './engine.js';
import { schemaOperationSchema, stripUniversalIds } from './operations.js';
import { presentSchema } from './present.js';

export type { SchemaDescription } from '@retainer/shared';

/**
 * describe_schema and GET /v1/schema: the workspace, its objects and fields,
 * and the built-in facts (5).
 */
export async function describeSchema(backend: Backend, caller: Caller): Promise<SchemaDescription> {
  const { workspaceId } = caller;
  const info = await readWorkspaceInfo(backend, workspaceId);
  return readWorkspace(backend, workspaceId, async ({ state, schema }) => {
    const compiled = await schema();
    return {
      workspace: {
        id: info.id,
        name: info.name,
        slug: info.slug,
        templates: state.templates,
        initialized: Boolean(state.initialized_at),
        schemaVersion: compiled.version,
      },
      objects: presentSchema(compiled),
      builtIns: BUILT_INS,
    };
  });
}

export const schemaChangeRequestSchema = z.strictObject({
  operations: z.array(schemaOperationSchema).min(1).max(100),
  reason: z.string().max(2000).optional(),
});
export type SchemaChangeRequestBody = z.infer<typeof schemaChangeRequestSchema>;

/** propose_schema_change and POST /v1/schema/changes: applied or proposed (3). */
export async function requestSchemaChange(
  backend: Backend,
  caller: Caller,
  body: SchemaChangeRequestBody,
): Promise<SchemaChangeResult> {
  return runSchemaChange(backend, {
    workspaceId: caller.workspaceId,
    actor: caller.actor,
    scopes: caller.scopes,
    // Universal IDs belong to code-defined schema, never to callers.
    operations: stripUniversalIds(body.operations),
    ...(body.reason ? { reason: body.reason } : {}),
  });
}
