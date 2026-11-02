import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { inWorkspace } from '../db/tx.js';
import type { Caller } from '../records/service.js';
import { readWorkspace, type Workspace } from '../workspaces/workspaces.js';
import { getSchema } from './compiled.js';
import { runSchemaChange, type SchemaChangeResult } from './engine.js';
import { schemaOperationSchema, stripUniversalIds } from './operations.js';
import { type ObjectView, presentSchema } from './present.js';

export type SchemaDescription = {
  workspace: Pick<Workspace, 'id' | 'name' | 'slug' | 'templates' | 'schemaVersion'> & {
    initialized: boolean;
  };
  objects: ObjectView[];
};

/** describe_schema and GET /v1/schema: the workspace and its objects and fields (5). */
export async function describeSchema(sql: Sql, caller: Caller): Promise<SchemaDescription> {
  const { workspaceId } = caller;
  return inWorkspace(sql, workspaceId, async (tx) => {
    const [workspace, schema] = await Promise.all([
      readWorkspace(tx, workspaceId),
      getSchema(tx, workspaceId),
    ]);
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        templates: workspace.templates,
        initialized: workspace.initializedAt !== null,
        schemaVersion: schema.version,
      },
      objects: presentSchema(schema),
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
  sql: Sql,
  caller: Caller,
  body: SchemaChangeRequestBody,
): Promise<SchemaChangeResult> {
  return inWorkspace(sql, caller.workspaceId, (tx) =>
    runSchemaChange(tx, {
      workspaceId: caller.workspaceId,
      actor: caller.actor,
      scopes: caller.scopes,
      // Universal IDs belong to code-defined schema, never to callers.
      operations: stripUniversalIds(body.operations),
      ...(body.reason ? { reason: body.reason } : {}),
    }),
  );
}
