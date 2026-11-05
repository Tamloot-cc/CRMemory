import type { Actor } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { tableStatements } from '../db/definitions.js';
import { fieldColumn, objectTable, publicId, relationTable } from '../db/names.js';
import { fromColumn, physicalChanges } from '../db/physical.js';
import type { Operation } from '../db/protocol.js';
import { applyIndexes } from '../db/provision.js';
import { ident } from '../db/surreal.js';
import { rebuildRollupsForField } from '../memory/attachments.js';
import { identifiersFor } from '../records/derive.js';
import { deleteEventsOfType } from '../records/lifecycle.js';
import { refreshObjectSearch } from '../records/search-docs.js';
import { repairViews } from '../views/service.js';
import { compileSchema } from './compiled.js';
import type { DiffOp, FieldState, SchemaIssue, SchemaState } from './types.js';

/** A change that validates but conflicts with existing records. */
export class SchemaCheckError extends Error {
  constructor(
    readonly issues: SchemaIssue[],
    readonly recordIds: string[],
  ) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'SchemaCheckError';
  }
}

const SAMPLE_LIMIT = 50;

const rowId = (row: { id: unknown }) => publicId(row.id);

/**
 * Checks existing records before a change makes a field unique or required
 * or removes an option (3). Runs in the plan; the commit's revision check
 * fails if any record changed before the change is published (section 6).
 */
export async function checkExistingRecords(
  db: Db,
  current: SchemaState,
  desired: SchemaState,
  ops: DiffOp[],
): Promise<void> {
  const issues: SchemaIssue[] = [];
  const recordIds = new Set<string>();
  const objectOf = (universalId: string) =>
    current.objects.find((o) => o.universalId === universalId);
  const desiredField = (objectId: string, fieldId: string) =>
    desired.objects
      .find((o) => o.universalId === objectId)
      ?.fields.find((f) => f.universalId === fieldId);

  for (const op of ops) {
    const object = 'objectId' in op ? objectOf(op.objectId) : undefined;
    if (!object?.id) continue; // a new object has no records
    const table = ident(objectTable(object.universalId));

    if (op.kind === 'create_field' && !op.field.isNullable) {
      const rows = await db.rows<{ id: unknown }>(
        `SELECT id FROM ${table} WHERE deleted_at = NONE LIMIT ${SAMPLE_LIMIT};`,
      );
      if (rows.length > 0) {
        issues.push({
          path: `${op.object}.${op.field.name}`,
          message: 'a required field cannot be added while records lack a value for it',
        });
        for (const row of rows) recordIds.add(rowId(row));
      }
    }

    if (op.kind === 'update_field' && op.to === true && op.property === 'isUnique') {
      const field = desiredField(op.objectId, op.fieldId);
      if (!field) continue;
      const duplicates = await findDuplicateValues(db, table, field);
      if (duplicates.length > 0) {
        issues.push({
          path: `${op.object}.${op.field}`,
          message: 'records share values, so the field cannot be unique',
        });
        for (const id of duplicates) recordIds.add(id);
      }
    }

    if (op.kind === 'update_field' && op.to === false && op.property === 'isNullable') {
      const field = desiredField(op.objectId, op.fieldId);
      if (!field) continue;
      const rows =
        field.type === 'relation'
          ? await db.rows<{ id: unknown }>(
              `SELECT id FROM ${table} WHERE deleted_at = NONE
                 AND count(->${ident(relationTable(field.universalId))}) = 0
               LIMIT ${SAMPLE_LIMIT};`,
            )
          : await db.rows<{ id: unknown }>(
              `SELECT id FROM ${table} WHERE deleted_at = NONE
                 AND (${ident(fieldColumn(field.key))} = NONE OR ${ident(fieldColumn(field.key))} = NULL)
               LIMIT ${SAMPLE_LIMIT};`,
            );
      if (rows.length > 0) {
        issues.push({
          path: `${op.object}.${op.field}`,
          message: 'records have no value, so the field cannot be required',
        });
        for (const row of rows) recordIds.add(rowId(row));
      }
    }

    if (op.kind === 'remove_option') {
      const field = desiredField(op.objectId, op.fieldId);
      if (!field) continue;
      const column = ident(fieldColumn(field.key));
      const condition =
        field.type === 'multi_select' ? `${column} CONTAINS $value` : `${column} = $value`;
      const rows = await db.rows<{ id: unknown }>(
        `SELECT id FROM ${table} WHERE deleted_at = NONE AND ${condition} LIMIT ${SAMPLE_LIMIT};`,
        { value: op.value },
      );
      if (rows.length > 0) {
        issues.push({
          path: `${op.object}.${op.field}`,
          message: `records use option "${op.value}"; change their values before removing it`,
        });
        for (const row of rows) recordIds.add(rowId(row));
      }
    }
  }

  if (issues.length > 0) throw new SchemaCheckError(issues, [...recordIds]);
}

/** Records (soft-deleted included, since they keep their claims) sharing a value. */
async function findDuplicateValues(db: Db, table: string, field: FieldState): Promise<string[]> {
  const column = ident(fieldColumn(field.key));
  const rows = await db.rows<{ id: unknown; value: unknown }>(
    `SELECT id, ${column} AS value FROM ${table} WHERE merged_into = NONE AND ${column} != NONE;`,
  );
  const holders = new Map<string, string[]>();
  for (const row of rows) {
    const id = rowId(row);
    for (const identifier of identifiersFor(
      { ...field, isUnique: true },
      fromColumn(field, row.value),
    )) {
      const list = holders.get(identifier.value) ?? [];
      if (!list.includes(id)) list.push(id);
      holders.set(identifier.value, list);
    }
  }
  return [...holders.values()].filter((ids) => ids.length > 1).flat();
}

const objectRow = (object: SchemaState['objects'][number]) => ({
  universal_id: object.universalId,
  owner: object.owner,
  status: object.status,
  name_singular: object.nameSingular,
  name_plural: object.namePlural,
  label_singular: object.labelSingular,
  label_plural: object.labelPlural,
  description: object.description,
  is_protected: object.isProtected,
  class: object.class,
});

const fieldRow = (field: FieldState) => ({
  universal_id: field.universalId,
  key: field.key,
  name: field.name,
  label: field.label,
  description: field.description,
  type: field.type,
  settings: field.settings,
  is_nullable: field.isNullable,
  is_unique: field.isUnique,
  is_filterable: field.isFilterable,
  is_searchable: field.isSearchable,
  is_protected: field.isProtected,
  core_role: field.coreRole,
  owner: field.owner,
  status: field.status,
});

/**
 * Defines what the change adds physically before it is published: new
 * tables and their indexes, each index alone and verified (section 7). They
 * are not in published metadata yet, so nothing writes to them; a plan that
 * is retried or abandoned leaves only unused, empty definitions.
 */
export async function prepareDefinitions(
  adminDb: Db,
  current: SchemaState,
  desired: SchemaState,
): Promise<string[]> {
  const { statements, indexes, model } = physicalChanges(current, desired);
  if (statements.length === 0 && indexes.length === 0) return [];
  const newTables = model.tables.filter((t) =>
    indexes.some((index) => index.table === t.name),
  );
  if (newTables.length > 0) {
    await adminDb.query(
      ['BEGIN;', ...newTables.flatMap(tableStatements), 'COMMIT;'].join('\n'),
    );
  }
  await applyIndexes(
    adminDb,
    indexes,
    new Map(model.tables.map((t) => [t.name, t])),
    model.relations,
  );
  return statements;
}

/**
 * Step 6 (apply): adds the desired schema to the operation's batch. New
 * objects and fields are created, changed ones updated, definitions applied
 * in the same transaction, then uniqueness claims, search documents and
 * views follow the change. Returns the new schema version.
 */
export async function persistSchema(
  op: Operation,
  current: SchemaState,
  desired: SchemaState,
  ops: DiffOp[],
  actor: Actor,
  definitions: string[],
  version: number,
): Promise<number> {
  const batch = op.batch;
  for (const statement of definitions) batch.plain(statement);

  const currentObjects = new Map(current.objects.map((o) => [o.universalId, o]));
  const objectIds = new Map<string, string>();
  const fieldIds = new Map<string, string>();
  for (const object of current.objects) {
    objectIds.set(object.universalId, object.id as string);
    for (const field of object.fields) fieldIds.set(field.universalId, field.id as string);
  }
  // Definition order: `seq` keeps it, as `created_at` did.
  let seq = op.now.getTime() * 1000;

  for (const object of desired.objects) {
    if (currentObjects.has(object.universalId)) continue;
    objectIds.set(object.universalId, op.newId());
  }
  for (const object of desired.objects) {
    const existing = new Set(currentObjects.get(object.universalId)?.fields.map((f) => f.universalId));
    for (const field of object.fields) {
      if (!existing.has(field.universalId)) fieldIds.set(field.universalId, op.newId());
    }
  }

  for (const object of desired.objects) {
    const before = currentObjects.get(object.universalId);
    const objectId = objectIds.get(object.universalId) as string;
    const labelFieldId = object.labelFieldId ? (fieldIds.get(object.labelFieldId) ?? null) : null;
    if (!before) {
      batch.create('object_types', objectId, {
        ...objectRow(object),
        label_field_id: labelFieldId,
        table: objectTable(object.universalId),
        seq: seq++,
        created_by: actor,
        created_at: op.now,
        updated_at: op.now,
      });
    } else if (
      before.nameSingular !== object.nameSingular ||
      before.namePlural !== object.namePlural ||
      before.labelSingular !== object.labelSingular ||
      before.labelPlural !== object.labelPlural ||
      before.description !== object.description ||
      before.labelFieldId !== object.labelFieldId ||
      before.isProtected !== object.isProtected ||
      before.status !== object.status
    ) {
      batch.update('object_types', objectId, {
        ...objectRow(object),
        label_field_id: labelFieldId,
        updated_at: op.now,
      });
    }
    const beforeFields = new Map(before?.fields.map((f) => [f.universalId, f]));
    for (const field of object.fields) {
      const previous = beforeFields.get(field.universalId);
      const fieldId = fieldIds.get(field.universalId) as string;
      if (!previous) {
        batch.create('fields', fieldId, {
          ...fieldRow(field),
          object_type_id: objectId,
          seq: seq++,
          created_by: actor,
          created_at: op.now,
          updated_at: op.now,
        });
      } else if (fieldChanged(previous, field)) {
        batch.update('fields', fieldId, { ...fieldRow(field), updated_at: op.now });
      }
    }
  }

  // The new version's compiled schema, with database IDs for new elements.
  const withIds: SchemaState = {
    objects: desired.objects.map((object) => ({
      ...object,
      id: objectIds.get(object.universalId) as string,
      fields: object.fields.map((f) => ({ ...f, id: fieldIds.get(f.universalId) as string })),
    })),
  };
  const next = compileSchema(withIds, version);
  const previous = compileSchema(current, version - 1);

  // Follow-up work on existing records.
  const refreshObjects = new Set<string>();
  const viewObjects = new Set<string>();
  for (const change of ops) {
    if (change.kind === 'deprecate_object') {
      const objectId = objectIds.get(change.objectId) as string;
      batch.write(
        `DELETE views WHERE object_type_id = ${batch.v(objectId)} RETURN BEFORE`,
        { min: 0 },
        'views',
      );
      // Deleting an event type deletes its events through the same
      // lifecycle as deleting one event (6.4): what cites them is retracted.
      if (currentObjects.get(change.objectId)?.class === 'event') {
        await deleteEventsOfType(op, previous, objectId, actor);
      }
    }
    if (
      change.kind === 'deprecate_field' ||
      change.kind === 'remove_option' ||
      (change.kind === 'update_field' && change.property === 'isFilterable' && change.to === false)
    ) {
      viewObjects.add(change.objectId);
    }
    if (change.kind === 'update_field' && change.property === 'isUnique') {
      const fieldId = fieldIds.get(change.fieldId) as string;
      const object = withIds.objects.find((o) => o.universalId === change.objectId);
      const field = object?.fields.find((f) => f.universalId === change.fieldId);
      if (change.to === true && object && field) {
        await claimExistingValues(op, objectTable(object.universalId), fieldId, field);
      } else {
        releaseClaims(op, fieldId);
      }
    }
    if (change.kind === 'update_field' && change.property === 'rollUpEvents') {
      const field = next.fieldOwners.get(fieldIds.get(change.fieldId) as string)?.fieldsById.get(
        fieldIds.get(change.fieldId) as string,
      );
      if (field) await rebuildRollupsForField(op, next, field);
    }
    if (
      (change.kind === 'update_object' && change.property === 'labelFieldId') ||
      (change.kind === 'update_field' && change.property === 'isSearchable') ||
      change.kind === 'deprecate_field' ||
      change.kind === 'update_option'
    ) {
      refreshObjects.add(change.objectId);
    }
  }
  for (const universalId of refreshObjects) {
    const object = next.objectsByUniversalId.get(universalId);
    if (object && object.state.status === 'active') await refreshObjectSearch(op, object);
  }

  batch.update('workspace_state', 'current', { schema_version: version, updated_at: op.now });
  if (viewObjects.size > 0) {
    await repairViews(
      op,
      next,
      [...viewObjects].map((id) => objectIds.get(id) as string),
      actor,
    );
  }
  return version;
}

function fieldChanged(a: FieldState, b: FieldState): boolean {
  return (
    a.name !== b.name ||
    a.label !== b.label ||
    a.description !== b.description ||
    a.isNullable !== b.isNullable ||
    a.isUnique !== b.isUnique ||
    a.isFilterable !== b.isFilterable ||
    a.isSearchable !== b.isSearchable ||
    a.isProtected !== b.isProtected ||
    a.status !== b.status ||
    JSON.stringify(a.settings) !== JSON.stringify(b.settings)
  );
}

/** Claims existing values when a field becomes unique (checked beforehand). */
async function claimExistingValues(
  op: Operation,
  table: string,
  fieldId: string,
  field: FieldState,
): Promise<void> {
  const column = ident(fieldColumn(field.key));
  const rows = await op.rows<{ id: unknown; value: unknown }>(
    `SELECT id, ${column} AS value FROM ${ident(table)} WHERE merged_into = NONE AND ${column} != NONE;`,
  );
  const batch = op.batch;
  batch.write(
    `DELETE unique_claims WHERE field_id = ${batch.v(fieldId)} RETURN BEFORE`,
    { min: 0 },
    'unique_claims',
  );
  const claims: Array<Record<string, unknown> & { id: string }> = [];
  const lookups: Array<Record<string, unknown> & { id: string }> = [];
  for (const row of rows) {
    const record = rowId(row);
    for (const identifier of identifiersFor(field, fromColumn(field, row.value))) {
      claims.push({
        id: op.newId(),
        record,
        field_id: fieldId,
        value: identifier.value,
        created_at: op.now,
      });
      if (identifier.kind === 'value') {
        lookups.push({
          id: op.newId(),
          record,
          field_id: fieldId,
          kind: identifier.kind,
          value: identifier.value,
          created_at: op.now,
        });
      }
    }
  }
  batch.insert('unique_claims', claims);
  batch.insert('record_identifiers', lookups);
}

/** A field that stops being unique keeps its email/phone/domain lookups, but no claims. */
function releaseClaims(op: Operation, fieldId: string): void {
  const batch = op.batch;
  const field = batch.v(fieldId);
  batch.write(`DELETE unique_claims WHERE field_id = ${field} RETURN BEFORE`, { min: 0 }, 'claims');
  batch.write(
    `DELETE record_identifiers WHERE field_id = ${field} AND kind = 'value' RETURN BEFORE`,
    { min: 0 },
    'identifiers',
  );
}

/** A record's native ID in its object table. */
export const recordIdOf = (universalId: string, id: string) =>
  new RecordId(objectTable(universalId), id);
