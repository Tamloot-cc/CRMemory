import type { Actor } from '@retainer/shared';
import type { Operation } from '../db/protocol.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';

/** Deletes every event of a deprecated event type (6.4). Ported in Phase 3. */
export async function deleteEventsOfType(
  _op: Operation,
  _schema: CompiledSchema,
  _objectTypeId: string,
  _actor: Actor,
): Promise<void> {
  throw new Error('deleting an event type is not available on this branch yet');
}
