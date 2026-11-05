import type { Actor } from '@retainer/shared';
import { publicId } from '../db/names.js';
import type { Operation } from '../db/protocol.js';
import { ident } from '../db/surreal.js';
import { retractEventClaims } from '../memory/events.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';
import { markDeleted } from './write.js';

/**
 * Deleting an event type (6.4): every live record of it is deleted through
 * the same lifecycle as deleting one event, in the schema change's own
 * transaction, so no claim keeps citing an event of a deleted type.
 */
export async function deleteEventsOfType(
  op: Operation,
  schema: CompiledSchema,
  objectTypeId: string,
  actor: Actor,
): Promise<void> {
  const object = schema.objectsById.get(objectTypeId);
  if (!object) return;
  const rows = await op.rows<unknown>(
    `SELECT VALUE id FROM ${ident(object.table)} WHERE deleted_at = NONE;`,
  );
  const context = { op, workspaceId: op.workspaceId, actor, schema, confidenceThreshold: 1 };
  const deleted = await markDeleted(context, rows.map(publicId).sort());
  await retractEventClaims(context, deleted);
}
