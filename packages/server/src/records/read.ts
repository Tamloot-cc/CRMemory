import { type Actor, isCollectionRelation, type PresentedRecord } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { AppError, notFound } from '../errors.js';
import { eventDetails } from '../memory/event-links.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import {
  directoryEntries,
  directoryEntry,
  type Edge,
  fetchRows,
  incomingEdges,
  outgoingEdges,
  type RecordRow,
} from './store.js';
import { resolveRecordIdIn } from './write.js';

export type { PresentedRecord } from '@retainer/shared';
export type { RecordRow } from './store.js';

const INVERSE_LIMIT = 100;

/** The owning field an inverse field reads its edges from. */
export function owningFieldOf(schema: CompiledSchema, inverse: FieldState): FieldState | undefined {
  const target = schema.objectsByUniversalId.get(inverse.settings.targetObjectId ?? '');
  return target?.state.fields.find((f) => f.universalId === inverse.settings.inverseFieldId);
}

/**
 * Presents rows of any objects: their relations from native edges (both
 * directions), and for event records their built-in columns and links.
 * Links whose other end is deleted no longer resolve (set_null on delete).
 */
export async function presentRecords(
  db: Db,
  schema: CompiledSchema,
  rows: RecordRow[],
): Promise<PresentedRecord[]> {
  if (rows.length === 0) return [];
  const records = rows.flatMap((row) => {
    const object = schema.objectsById.get(row.object_type_id);
    return object ? [{ id: row.id, object }] : [];
  });
  const workspaceId = rows[0]?.workspace_id as string;
  const events = await eventDetails(
    db,
    workspaceId,
    schema,
    rows.filter((r) => schema.objectsById.get(r.object_type_id)?.isEvent),
  );

  const outgoing = await outgoingEdges(db, records);
  const incoming: Edge[] = [];
  const inverseOf = new Map<string, FieldState>();
  const byObject = new Map<CompiledObject, { id: string; object: CompiledObject }[]>();
  for (const r of records) byObject.set(r.object, [...(byObject.get(r.object) ?? []), r]);
  for (const [object, list] of byObject) {
    for (const inverse of object.activeFields) {
      if (inverse.type !== 'relation' || !inverse.settings.isInverse) continue;
      const owning = owningFieldOf(schema, inverse);
      if (!owning) continue;
      inverseOf.set(owning.id as string, inverse);
      incoming.push(...(await incomingEdges(db, owning, list)));
    }
  }
  const others = await directoryEntries(db, [
    ...outgoing.map((e) => e.other_id),
    ...incoming.map((e) => e.other_id),
  ]);
  const live = (id: string) => {
    const entry = others.get(id);
    return entry !== undefined && !entry.deleted_at;
  };

  const values = new Map<string, Record<string, unknown>>(rows.map((r) => [r.id, {}]));
  for (const link of [...outgoing].sort((a, b) => a.other_id.localeCompare(b.other_id))) {
    if (!live(link.other_id)) continue;
    const field = schema.fieldOwners.get(link.field_id)?.fieldsById.get(link.field_id);
    if (field?.status !== 'active') continue;
    const record = values.get(link.record_id) as Record<string, unknown>;
    if (isCollectionRelation(field)) {
      // A set, in ID order; members that were deleted no longer resolve.
      record[field.name] = [...((record[field.name] as string[] | undefined) ?? []), link.other_id];
    } else record[field.name] = link.other_id;
  }
  // An inverse lists its sources oldest first, as on `main`.
  const sorted = incoming
    .filter((e) => live(e.other_id))
    .sort((a, b) => {
      const x = others.get(a.other_id) as { created_at: Date };
      const y = others.get(b.other_id) as { created_at: Date };
      return x.created_at.getTime() - y.created_at.getTime() || a.other_id.localeCompare(b.other_id);
    });
  for (const link of sorted) {
    const inverse = inverseOf.get(link.field_id);
    if (inverse?.status !== 'active') continue;
    const record = values.get(link.record_id) as Record<string, unknown>;
    const list = (record[inverse.name] as string[] | undefined) ?? [];
    if (list.length < INVERSE_LIMIT) list.push(link.other_id);
    record[inverse.name] = list;
  }

  return rows.map((row) => {
    const object = schema.objectsById.get(row.object_type_id);
    const fields: Record<string, unknown> = {};
    for (const field of object?.activeFields ?? []) {
      if (field.type !== 'relation' && Object.hasOwn(row.data, field.key)) {
        fields[field.name] = row.data[field.key];
      }
      // An empty set reads as [], not as a missing value.
      if (isCollectionRelation(field) && !field.settings.isInverse) fields[field.name] = [];
    }
    Object.assign(fields, values.get(row.id));
    const event = events.get(row.id);
    return {
      id: row.id,
      object: object?.name ?? 'unknown',
      label: row.label,
      fields,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      ...(event ? { event } : {}),
    };
  });
}

/**
 * One live record. A merged ID resolves to the surviving record (4.2); a
 * deleted record, and a record of the hidden internal-note type (6.4), are
 * not found.
 */
export async function getRecord(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  id: string,
): Promise<PresentedRecord> {
  const row = await findLiveRecord(db, workspaceId, schema, id);
  const [presented] = await presentRecords(db, schema, [row]);
  return presented as PresentedRecord;
}

/**
 * The live, visible record an ID names, after merges, unpresented: for
 * routes that need only its ID and object. Refuses what `getRecord` refuses.
 */
export async function findLiveRecord(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  id: string,
): Promise<RecordRow> {
  const canonical = await resolveRecordIdIn(db, id);
  const entry = await directoryEntry(db, canonical);
  if (!entry || schema.objectsById.get(entry.object_type_id)?.hidden) {
    throw notFound('record', { id });
  }
  const row = (await fetchRows(db, workspaceId, schema, [entry])).get(canonical);
  if (!row) throw notFound('record', { id });
  if (entry.deleted_at) {
    throw new AppError(404, 'record_deleted', `record ${canonical} was deleted`, {
      recordId: canonical,
    });
  }
  return row;
}

export type { Actor };
