import type { FieldType } from '@retainer/shared';
import type { FieldState, ObjectState, SchemaState } from '../schema-engine/types.js';
import { relationTargetIds } from '../schema-engine/types.js';
import {
  ACTOR_TYPE,
  type IndexDefinition,
  type TableDefinition,
  tableStatements,
} from './definitions.js';
import { fieldColumn, objectTable, relationTable } from './names.js';

/**
 * The metadata compiler (spec sections 5 and 7): published objects and
 * fields become schemafull object tables, typed columns and native relation
 * tables. Physical names come from universal IDs and field keys, so renames
 * never touch them; deprecation keeps them.
 */

const PHONE = '{ number: string, countryCode: option<string> }';
const LINK = '{ url: string, label: option<string> }';

const COLUMN_TYPES: Record<Exclude<FieldType, 'relation'>, string> = {
  text: 'string',
  number: 'number',
  boolean: 'bool',
  date: 'string',
  date_time: 'datetime',
  select: 'string',
  multi_select: 'array<string>',
  money: '{ amountMicros: int, currency: string }',
  emails: '{ primary: string | null, additional: array<string> }',
  phones: `{ primary: ${PHONE} | null, additional: array<${PHONE}> }`,
  links: `{ primary: ${LINK} | null, additional: array<${LINK}> }`,
  full_name: '{ first: string, last: string }',
  address:
    '{ street1: option<string>, street2: option<string>, city: option<string>, state: option<string>, postcode: option<string>, country: option<string>, lat: option<number>, lng: option<number> }',
  json: 'any',
};

/**
 * A field's column type. Absent (NONE) means no eligible assertion; null is
 * a winning explicit clear (section 5), so the two stay apart.
 */
export function columnType(field: Pick<FieldState, 'type'>): string | null {
  if (field.type === 'relation') return null;
  const base = COLUMN_TYPES[field.type];
  return base === 'any' ? 'any' : `option<${base} | null>`;
}

/** A validated JSON value as its native column value. */
export function toColumn(field: Pick<FieldState, 'type'>, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (field.type === 'date_time' && typeof value === 'string') return new Date(value);
  return value;
}

/** A native column value as the JSON value the API has always returned. */
export function fromColumn(field: Pick<FieldState, 'type'>, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Built-in columns on every object table (ARCHITECTURE.md 1.1). */
export const RECORD_COLUMNS: [string, string][] = [
  ['created_at', 'datetime'],
  ['updated_at', 'datetime'],
  ['deleted_at', 'option<datetime>'],
  ['created_by', ACTOR_TYPE],
  ['updated_by', ACTOR_TYPE],
  ['merged_into', 'option<string>'],
  ['label', 'option<string | null>'],
  // Event types: when it happened (the identity itself lives in event_identity).
  ['occurred_at', 'option<datetime>'],
];

export function objectTableDefinition(object: ObjectState): TableDefinition {
  const fields: [string, string][] = [...RECORD_COLUMNS];
  for (const field of object.fields) {
    const type = columnType(field);
    if (type) fields.push([fieldColumn(field.key), type]);
  }
  return { name: objectTable(object.universalId), fields };
}

export function objectIndexes(object: ObjectState): IndexDefinition[] {
  const table = objectTable(object.universalId);
  return [
    { name: `${table}_created_idx`, table, fields: ['created_at'] },
    { name: `${table}_merged_idx`, table, fields: ['merged_into'] },
    ...(object.class === 'event'
      ? [{ name: `${table}_occurred_idx`, table, fields: ['occurred_at'] }]
      : []),
  ];
}

/** Owning relation fields, which each get a native edge table. */
export const isOwningRelation = (field: FieldState) =>
  field.type === 'relation' && !field.settings.isInverse;

export function relationTableDefinition(
  state: SchemaState,
  owner: ObjectState,
  field: FieldState,
): TableDefinition {
  const targets = relationTargetIds(field.settings).map((id) => {
    const target = state.objects.find((o) => o.universalId === id);
    if (!target) throw new Error(`relation ${field.name} targets an unknown object ${id}`);
    return objectTable(target.universalId);
  });
  return {
    name: relationTable(field.universalId),
    relation: { in: [objectTable(owner.universalId)], out: targets, enforced: true },
    fields: [
      // The winning assertion this edge derives from (provenance).
      ['assertion', 'option<string>'],
      ['created_by', ACTOR_TYPE],
      ['created_at', 'datetime'],
    ],
  };
}

export function relationIndexes(field: FieldState): IndexDefinition[] {
  const table = relationTable(field.universalId);
  const single = field.settings.relationCardinality !== 'many_to_many';
  return [
    { name: `${table}_pair_uq`, table, fields: ['in', 'out'], unique: true },
    ...(single ? [{ name: `${table}_source_uq`, table, fields: ['in'], unique: true }] : []),
    { name: `${table}_target_idx`, table, fields: ['out'] },
  ];
}

export type PhysicalModel = {
  tables: TableDefinition[];
  indexes: IndexDefinition[];
  /** Relation tables' endpoints, for duplicate probes. */
  relations: Map<string, { from: string; to: string }>;
};

/** Everything a schema state needs physically, deprecated elements included. */
export function physicalModel(state: SchemaState): PhysicalModel {
  const tables: TableDefinition[] = [];
  const indexes: IndexDefinition[] = [];
  const relations = new Map<string, { from: string; to: string }>();
  for (const object of state.objects) {
    tables.push(objectTableDefinition(object));
    indexes.push(...objectIndexes(object));
  }
  for (const object of state.objects) {
    for (const field of object.fields) {
      if (!isOwningRelation(field)) continue;
      const table = relationTableDefinition(state, object, field);
      tables.push(table);
      indexes.push(...relationIndexes(field));
      relations.set(table.name, {
        from: table.relation?.in?.[0] as string,
        to: table.relation?.out?.[0] as string,
      });
    }
  }
  return { tables, indexes, relations };
}

/**
 * The tables, fields and indexes `desired` has that `current` lacks: what
 * a schema change must define. Definitions are additive only: deprecation
 * keeps fields and tables (section 7).
 */
export function physicalChanges(
  current: SchemaState,
  desired: SchemaState,
): { statements: string[]; indexes: IndexDefinition[]; model: PhysicalModel } {
  const before = physicalModel(current);
  const after = physicalModel(desired);
  const beforeTables = new Map(before.tables.map((t) => [t.name, t]));
  const beforeIndexes = new Set(before.indexes.map((i) => i.name));
  const statements: string[] = [];
  for (const table of after.tables) {
    const existing = beforeTables.get(table.name);
    if (!existing) {
      statements.push(...tableStatements(table));
      continue;
    }
    const known = new Map(existing.fields);
    const added = table.fields.filter(([name, type]) => known.get(name) !== type);
    if (added.length > 0) {
      statements.push(...tableStatements({ ...table, fields: added }).slice(1));
    }
  }
  return {
    statements,
    indexes: after.indexes.filter((i) => !beforeIndexes.has(i.name)),
    model: after,
  };
}
