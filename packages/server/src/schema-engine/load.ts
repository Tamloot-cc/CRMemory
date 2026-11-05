import type { CoreRole, FieldType, ObjectClass, SchemaOwner, SchemaStatus } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { publicId } from '../db/names.js';
import type { FieldState, ObjectState, SchemaState, StoredFieldSettings } from './types.js';

type ObjectRow = {
  id: unknown;
  universal_id: string;
  name_singular: string;
  name_plural: string;
  label_singular: string;
  label_plural: string;
  description: string | null;
  label_field_id: string | null;
  is_protected: boolean;
  class: ObjectClass;
  owner: SchemaOwner;
  status: SchemaStatus;
};

type FieldRow = {
  id: unknown;
  object_type_id: string;
  universal_id: string;
  key: string;
  name: string;
  label: string;
  description: string | null;
  type: FieldType;
  settings: StoredFieldSettings;
  is_nullable: boolean;
  is_unique: boolean;
  is_filterable: boolean;
  is_searchable: boolean;
  is_protected: boolean;
  core_role: CoreRole | null;
  owner: SchemaOwner;
  status: SchemaStatus;
};

/** Step 1 of the engine: a workspace's schema as it is now, deprecated rows included. */
export async function loadSchemaState(db: Db): Promise<SchemaState> {
  const [objectRows, fieldRows] = (await db.query(
    `SELECT * FROM object_types ORDER BY seq, id;
     SELECT * FROM fields ORDER BY seq, id;`,
  )) as [ObjectRow[], FieldRow[]];

  const fieldsByObject = new Map<string, FieldState[]>();
  const universalIdByFieldId = new Map<string, string>();
  for (const row of fieldRows) {
    const id = publicId(row.id);
    universalIdByFieldId.set(id, row.universal_id);
    const list = fieldsByObject.get(row.object_type_id) ?? [];
    list.push({
      id,
      universalId: row.universal_id,
      key: row.key,
      name: row.name,
      label: row.label,
      description: row.description ?? null,
      type: row.type,
      settings: row.settings ?? {},
      isNullable: row.is_nullable,
      isUnique: row.is_unique,
      isFilterable: row.is_filterable,
      isSearchable: row.is_searchable,
      isProtected: row.is_protected,
      coreRole: row.core_role ?? null,
      owner: row.owner,
      status: row.status,
    });
    fieldsByObject.set(row.object_type_id, list);
  }

  const objects: ObjectState[] = objectRows.map((row) => ({
    id: publicId(row.id),
    universalId: row.universal_id,
    nameSingular: row.name_singular,
    namePlural: row.name_plural,
    labelSingular: row.label_singular,
    labelPlural: row.label_plural,
    description: row.description ?? null,
    labelFieldId: row.label_field_id
      ? (universalIdByFieldId.get(row.label_field_id) ?? null)
      : null,
    isProtected: row.is_protected,
    class: row.class,
    owner: row.owner,
    status: row.status,
    fields: fieldsByObject.get(publicId(row.id)) ?? [],
  }));

  return { objects };
}
