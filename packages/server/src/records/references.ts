import type { RecordReference } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';
import { directoryEntries, fetchRows } from './store.js';

/**
 * Labels of records a response mentions: relation targets, conflict holders,
 * a context pack's open tasks (ARCHITECTURE.md 7.2, rule 3). Every such
 * label goes through here, so a per-record visibility check has one place to
 * go. A missing or deleted record, and one of a deleted or hidden object
 * (6.4), is absent from the result.
 */
export async function references(
  db: Db,
  schema: CompiledSchema,
  ids: string[],
): Promise<Record<string, RecordReference>> {
  if (!ids.length) return {};
  const visible = new Set(schema.visibleObjectIds);
  const entries = [...(await directoryEntries(db, ids)).values()].filter(
    (e) => !e.deleted_at && visible.has(e.object_type_id),
  );
  const rows = await fetchRows(db, '', schema, entries);
  return Object.fromEntries(
    [...rows.values()].map((r) => [
      r.id,
      {
        id: r.id,
        label: r.label,
        object: schema.objectsById.get(r.object_type_id)?.name ?? 'unknown',
      },
    ]),
  );
}
