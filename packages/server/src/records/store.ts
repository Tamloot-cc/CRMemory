import type { Actor } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { fieldColumn, publicId, relationTable } from '../db/names.js';
import { fromColumn } from '../db/physical.js';
import { ident } from '../db/surreal.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';

/**
 * Reading the physical model (spec section 5): `record_directory` resolves a
 * public ID to its object table, liveness and merge survivor; object tables
 * hold typed columns that are mapped back to `data` keyed by field key, the
 * shape the rest of the server works with; relation tables hold native edges.
 * Every read is a point lookup or a top-level indexed statement.
 */

export type DirEntry = {
  id: string;
  object_type_id: string;
  tb: string;
  is_event: boolean;
  created_at: Date;
  deleted_at: Date | null;
  merged_into: string | null;
};

/** A record as the server presents and writes it. */
export type RecordRow = {
  id: string;
  workspace_id: string;
  object_type_id: string;
  /** Field values keyed by `fields.key`; relations are edges, not here. */
  data: Record<string, unknown>;
  label: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: Actor;
  updated_by: Actor;
  deleted_at: Date | null;
  merged_into_id: string | null;
  /** Event records: when it happened. */
  occurred_at: Date | null;
};

type DirRow = Omit<DirEntry, 'id' | 'deleted_at' | 'merged_into'> & {
  id: RecordId;
  deleted_at?: Date | null;
  merged_into?: string | null;
};

const dirEntry = (row: DirRow): DirEntry => ({
  id: String(row.id.id),
  object_type_id: row.object_type_id,
  tb: row.tb,
  is_event: row.is_event,
  created_at: row.created_at,
  deleted_at: row.deleted_at ?? null,
  merged_into: row.merged_into ?? null,
});

export const directoryRef = (id: string) => new RecordId('record_directory', id);

/** Directory entries by public ID; unknown IDs are absent. */
export async function directoryEntries(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, DirEntry>> {
  const unique = [...new Set(ids)].filter(isUuidLike);
  if (unique.length === 0) return new Map();
  const rows = await db.rows<DirRow>('SELECT * FROM $ids;', { ids: unique.map(directoryRef) });
  return new Map(rows.map((row) => [String(row.id.id), dirEntry(row)]));
}

export async function directoryEntry(db: Db, id: string): Promise<DirEntry | undefined> {
  return (await directoryEntries(db, [id])).get(id);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuidLike = (id: string) => UUID.test(id);

type NativeRow = Record<string, unknown> & {
  id: RecordId;
  created_at: Date;
  updated_at: Date;
  created_by: Actor;
  updated_by: Actor;
  deleted_at?: Date;
  merged_into?: string;
  label?: string | null;
  occurred_at?: Date;
};

/** A native object-table row as a `RecordRow`. */
export function rowFromNative(
  workspaceId: string,
  object: CompiledObject,
  native: NativeRow,
): RecordRow {
  const data: Record<string, unknown> = {};
  for (const field of object.state.fields) {
    if (field.type === 'relation') continue;
    const value = native[fieldColumn(field.key)];
    if (value !== undefined) data[field.key] = fromColumn(field, value);
  }
  return {
    id: String(native.id.id),
    workspace_id: workspaceId,
    object_type_id: object.id,
    data,
    label: native.label ?? null,
    created_at: native.created_at,
    updated_at: native.updated_at,
    created_by: native.created_by,
    updated_by: native.updated_by,
    deleted_at: native.deleted_at ?? null,
    merged_into_id: native.merged_into ?? null,
    occurred_at: native.occurred_at ?? null,
  };
}

/** Object-table rows for directory entries, by public ID (point lookups). */
export async function fetchRows(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  entries: Iterable<DirEntry>,
): Promise<Map<string, RecordRow>> {
  const byObject = new Map<string, DirEntry[]>();
  for (const entry of entries) {
    const list = byObject.get(entry.object_type_id) ?? [];
    list.push(entry);
    byObject.set(entry.object_type_id, list);
  }
  const groups = [...byObject.entries()].flatMap(([objectId, list]) => {
    const object = schema.objectsById.get(objectId);
    return object ? [{ object, list }] : [];
  });
  if (groups.length === 0) return new Map();
  const vars: Record<string, unknown> = {};
  const statements = groups.map((group, i) => {
    vars[`r${i}`] = group.list.map((e) => new RecordId(group.object.table, e.id));
    return `SELECT * FROM $r${i};`;
  });
  const results = (await db.query(statements.join('\n'), vars)) as NativeRow[][];
  const rows = new Map<string, RecordRow>();
  groups.forEach((group, i) => {
    for (const native of results[i] ?? []) {
      const row = rowFromNative(workspaceId, group.object, native);
      rows.set(row.id, row);
    }
  });
  return rows;
}

/** Rows by public ID, through the directory. */
export async function rowsByIds(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  ids: readonly string[],
): Promise<Map<string, RecordRow>> {
  const entries = await directoryEntries(db, ids);
  return fetchRows(db, workspaceId, schema, entries.values());
}

export type Edge = { record_id: string; field_id: string; other_id: string };

/** The owning relation fields of an object, deprecated included. */
const owningRelations = (object: CompiledObject) =>
  object.state.fields.filter((f) => f.type === 'relation' && !f.settings.isInverse);

/**
 * Outgoing edges of records, by owning field: each record's own edge
 * pointers, one top-level statement per field.
 */
export async function outgoingEdges(
  db: Db,
  records: ReadonlyArray<{ id: string; object: CompiledObject }>,
  only?: (field: FieldState) => boolean,
): Promise<Edge[]> {
  const vars: Record<string, unknown> = {};
  const statements: string[] = [];
  const fields: FieldState[] = [];
  const byObject = new Map<CompiledObject, string[]>();
  for (const r of records) byObject.set(r.object, [...(byObject.get(r.object) ?? []), r.id]);
  for (const [object, ids] of byObject) {
    for (const field of owningRelations(object)) {
      if (only && !only(field)) continue;
      const i = statements.length;
      vars[`r${i}`] = ids.map((id) => new RecordId(object.table, id));
      // The records' own graph pointers: no scan of the edge table.
      statements.push(
        `SELECT VALUE [id, ->${ident(relationTable(field.universalId))}->?] FROM $r${i};`,
      );
      fields.push(field);
    }
  }
  if (statements.length === 0) return [];
  const results = (await db.query(statements.join('\n'), vars)) as [RecordId, RecordId[]][][];
  const edges: Edge[] = [];
  results.forEach((rows, i) => {
    const field = fields[i] as FieldState;
    for (const [source, targets] of rows ?? []) {
      for (const target of targets ?? []) {
        edges.push({
          record_id: publicId(source),
          field_id: field.id as string,
          other_id: publicId(target),
        });
      }
    }
  });
  return edges;
}

/** Incoming edges of records through one owning field (an inverse's reads). */
export async function incomingEdges(
  db: Db,
  field: FieldState,
  targets: ReadonlyArray<{ id: string; object: CompiledObject }>,
): Promise<Edge[]> {
  if (targets.length === 0) return [];
  const rows = await db.rows<[RecordId, RecordId[]]>(
    `SELECT VALUE [id, <-${ident(relationTable(field.universalId))}<-?] FROM $targets;`,
    { targets: targets.map((t) => new RecordId(t.object.table, t.id)) },
  );
  return rows.flatMap(([target, sources]) =>
    (sources ?? []).map((source) => ({
      record_id: publicId(target),
      field_id: field.id as string,
      other_id: publicId(source),
    })),
  );
}

/** One record's current targets through one owning field. */
export async function edgeTargets(
  db: Db,
  field: FieldState,
  source: { id: string; object: CompiledObject },
): Promise<string[]> {
  const [targets] = await db.rows<RecordId[]>(
    `SELECT VALUE ->${ident(relationTable(field.universalId))}->? FROM $source;`,
    { source: new RecordId(source.object.table, source.id) },
  );
  return (targets ?? []).map(publicId);
}
