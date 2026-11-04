import type { RecordReference } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';

/**
 * Labels of records a response mentions: relation targets, conflict holders,
 * a context pack's open tasks (ARCHITECTURE.md 7.2, rule 3). Every such
 * label goes through here, so a per-record visibility check has one place to
 * go. The records a response is about (search hits, the record under review)
 * come from their own RLS-bound queries. A missing or deleted record, and
 * one of a deleted or hidden object (6.4), is absent from the result.
 */
export async function references(
  tx: Tx,
  schema: CompiledSchema,
  ids: string[],
): Promise<Record<string, RecordReference>> {
  if (!ids.length) return {};
  const rows = await tx<
    { id: string; label: string | null; object_type_id: string }[]
  >`select id, label, object_type_id from records where id = any(${ids}::uuid[]) and deleted_at is null
    and object_type_id = any(${schema.visibleObjectIds}::uuid[])`;
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        label: r.label,
        object: schema.objectsById.get(r.object_type_id)?.name ?? 'unknown',
      },
    ]),
  );
}
