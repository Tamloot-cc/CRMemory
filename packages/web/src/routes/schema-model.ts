import {
  type FieldView,
  type ObjectView,
  SCHEMA_CHANGE_STATUSES,
  type SchemaChangeStatus,
  type SchemaOperation,
} from '@retainer/shared';
import { fields } from '../fields/index.js';
import type { DiagramEdge } from '../ui/index.js';

export function findObject(objects: ObjectView[], name: string | undefined) {
  return objects.find((o) => o.nameSingular === name) ?? null;
}

/** A second line under the type: what the settings add to it. */
export function typeDetail(field: FieldView, objects: ObjectView[]) {
  const s = field.settings;
  if (field.type === 'select' || field.type === 'multi_select') {
    const n = s.options?.length ?? 0;
    return `${n} ${n === 1 ? 'option' : 'options'}`;
  }
  if (field.type === 'relation') {
    const target = findObject(objects, s.targetObject);
    const name = target
      ? s.relationCardinality === 'one_to_many'
        ? target.labelPlural
        : target.labelSingular
      : (s.targetObject ?? 'unknown object');
    return `${s.relationCardinality === 'one_to_many' ? 'Many' : 'One'} ${name}`;
  }
  if (s.maxValues) return `Up to ${s.maxValues}`;
  return null;
}

/** Whether a field matches the field filter: label, API name or type. */
export function matchesField(field: FieldView, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [field.label, field.name, fields[field.type].label, field.type].some((v) =>
    v.toLowerCase().includes(q),
  );
}

/** A relation field's target object and, when it exists, the field on the other side. */
export function relationEnds(field: FieldView, objects: ObjectView[]) {
  const target = findObject(objects, field.settings.targetObject);
  const inverse = target?.fields.find((f) => f.name === field.settings.inverseField);
  return { target, inverse };
}

/** "Each person has one company", or "… has many people" for the many side. */
export function cardinality(object: ObjectView, target: ObjectView | null, many: boolean) {
  const what = many
    ? `many ${target?.labelPlural.toLowerCase() ?? 'records'}`
    : `one ${target?.labelSingular.toLowerCase() ?? 'record'}`;
  return `Each ${object.labelSingular.toLowerCase()} has ${what}`;
}

const isManyToOne = (f: FieldView) => f.settings.relationCardinality !== 'one_to_many';

/**
 * Every relation once, as a line from the many side's field to the one
 * side's. A relation has a field on each side (Person → Company and Company
 * → People): it is drawn from the many-to-one field, and a one-to-many field
 * only when that other side is missing. Relations to objects that no longer
 * exist are left out.
 */
export function relationEdges(objects: ObjectView[]): DiagramEdge[] {
  return objects.flatMap((object) =>
    object.fields.flatMap((field): DiagramEdge[] => {
      if (field.type !== 'relation') return [];
      const { target, inverse } = relationEnds(field, objects);
      if (!target || (!isManyToOne(field) && inverse && isManyToOne(inverse))) return [];
      const own = { node: object.nameSingular, row: field.name },
        other = { node: target.nameSingular, row: inverse?.name };
      const [many, one] = isManyToOne(field) ? [object, target] : [target, object];
      return [
        {
          id: `${object.nameSingular}.${field.name}`,
          ...(isManyToOne(field) ? { from: own, to: other } : { from: other, to: own }),
          description: `${field.label}: ${cardinality(many, one, false)}. ${cardinality(one, many, true)}.`,
        },
      ];
    }),
  );
}

export function parseStatus(value: string | undefined): SchemaChangeStatus | undefined {
  return SCHEMA_CHANGE_STATUSES.find((s) => s === value);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "3 minutes ago", "yesterday", "last month". */
export function relativeTime(iso: string, now = Date.now()) {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS)
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return 'just now';
}

const FLAG_WORDS: Record<string, [string, string]> = {
  isNullable: ['can be empty', 'required'],
  isUnique: ['unique', 'not unique'],
  isFilterable: ['filterable', 'not filterable'],
  isSearchable: ['searchable', 'not searchable'],
};
/**
 * One schema operation in words, with labels from the current schema where
 * the object or field still exists ("Add option “Collaborator” to Person →
 * Relationship"). Unknown shapes fall back to the operation name.
 */
export function describeOperation(op: SchemaOperation, objects: ObjectView[]) {
  const obj = (name: string) => findObject(objects, name)?.labelSingular ?? name;
  const fld = (object: string, field: string) =>
    `${obj(object)} → ${findObject(objects, object)?.fields.find((f) => f.name === field)?.label ?? field}`;
  const quote = (v: unknown) => `“${String(v)}”`;
  switch (op.op) {
    case 'create_object': {
      const n = op.object.fields?.length ?? 0;
      return `Add object ${op.object.labelSingular || op.object.nameSingular}${n ? ` with ${n} ${n === 1 ? 'field' : 'fields'}` : ''}`;
    }
    case 'update_object': {
      const parts = [
        op.labelSingular !== undefined && `singular label ${quote(op.labelSingular)}`,
        op.labelPlural !== undefined && `plural label ${quote(op.labelPlural)}`,
        op.labelField !== undefined && `label field ${op.labelField}`,
        op.description !== undefined &&
          (op.description ? `description ${quote(op.description)}` : 'clear description'),
      ].filter(Boolean);
      return `Change ${obj(op.object)}: ${parts.join(', ') || 'no changes'}`;
    }
    case 'rename_object':
      return `Rename object ${obj(op.object)} to ${op.nameSingular} / ${op.namePlural}`;
    case 'delete_object':
      return `Delete object ${obj(op.object)}`;
    case 'create_field': {
      const type = fields[op.field.type]?.label ?? op.field.type;
      return `Add field ${op.field.label || op.field.name} (${type}) to ${obj(op.object)}`;
    }
    case 'update_field': {
      const parts = [
        op.label !== undefined && `label ${quote(op.label)}`,
        op.type !== undefined && `type ${fields[op.type]?.label ?? op.type}`,
        op.description !== undefined &&
          (op.description ? `description ${quote(op.description)}` : 'clear description'),
        ...Object.entries(FLAG_WORDS)
          .filter(([k]) => typeof (op as Record<string, unknown>)[k] === 'boolean')
          .map(([k, [yes, no]]) => ((op as Record<string, unknown>)[k] ? yes : no)),
      ].filter(Boolean);
      return `Change ${fld(op.object, op.field)}: ${parts.join(', ') || 'no changes'}`;
    }
    case 'rename_field':
      return `Rename ${fld(op.object, op.field)} to ${op.name}`;
    case 'delete_field':
      return `Delete field ${fld(op.object, op.field)}`;
    case 'add_option':
      return `Add option ${quote(op.option.label || op.option.value)} to ${fld(op.object, op.field)}`;
    case 'update_option':
      return `Rename option ${op.value} of ${fld(op.object, op.field)} to ${quote(op.label)}`;
    case 'remove_option':
      return `Remove option ${op.value} from ${fld(op.object, op.field)}`;
    default:
      return String((op as { op?: unknown }).op ?? 'Unknown change').replaceAll('_', ' ');
  }
}
