import type {
  FieldView,
  ObjectView,
  PresentedRecord,
  RecordHit,
  SchemaDescription,
} from '@retainer/shared';
import { FieldValueError, MULTI_VALUE_TYPES, validateFieldValue } from '@retainer/shared';
import { isEmptyFor } from '../fields/common.js';
import { findObject, isInverseRelation, relationEnds } from './schema-model.js';

/** A field a person can set: not an inverse relation, not read-only, not `json` (read-only in the app). */
export const isWritable = (f: FieldView) =>
  !isInverseRelation(f) && !f.readOnly && f.type !== 'json';

/**
 * The fields a person can fill in when creating a record: the label field
 * first, then required fields, then the rest in schema order. Inverse
 * relations, read-only fields and `json` (read-only in the app) are left out.
 */
export function creatableFields(object: ObjectView): FieldView[] {
  const writable = object.fields.filter(isWritable);
  const rank = (f: FieldView) => (f.name === object.labelField ? 0 : f.isNullable ? 2 : 1);
  return writable
    .map((f, i) => ({ f, i }))
    .sort((x, y) => rank(x.f) - rank(y.f) || x.i - y.i)
    .map(({ f }) => f);
}

/** A starting draft: a required switch starts off, since "off" is a value. */
export function initialDraft(fields: FieldView[]): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const f of fields) if (f.type === 'boolean' && !f.isNullable) draft[f.name] = false;
  return draft;
}

/**
 * Turns a creation form into request values. Empty optional fields are left
 * out; empty required ones and invalid values become per-field errors. The
 * server stays authoritative (uniqueness, relation targets, suppression).
 */
export function prepareCreateValues(
  fields: FieldView[],
  draft: Record<string, unknown>,
): { values: Record<string, unknown>; errors: Record<string, string> } {
  const values: Record<string, unknown> = {},
    errors: Record<string, string> = {};
  for (const f of fields) {
    const value = draft[f.name];
    if (isEmptyFor(f.type, value)) {
      if (!f.isNullable) errors[f.name] = 'is required';
      continue;
    }
    try {
      values[f.name] = validateFieldValue(f, value);
    } catch (e) {
      if (!(e instanceof FieldValueError)) throw e;
      errors[f.name] = e.message;
    }
  }
  return { values, errors };
}

/**
 * Per-field errors from a failed write, keyed by field name. The server lists
 * them in `details.errors` for `invalid_values`, `unique_conflict` and
 * `suppressed` alike.
 */
export function serverFieldErrors(details: unknown): Record<string, string> {
  const list = (details as { errors?: unknown } | undefined)?.errors;
  const errors: Record<string, string> = {};
  if (Array.isArray(list))
    for (const e of list as { field?: unknown; message?: unknown }[])
      if (typeof e.field === 'string' && typeof e.message === 'string') errors[e.field] = e.message;
  return errors;
}

export type CascadeImpact = { object: string; label: string; count: number };
/**
 * Linked records that deleting `record` deletes too: records on the other
 * side of an inverse relation whose many-to-one field cascades.
 */
export function cascadeImpact(schema: SchemaDescription, record: PresentedRecord): CascadeImpact[] {
  const object = findObject(schema.objects, record.object);
  const impact: CascadeImpact[] = [];
  for (const f of object?.fields.filter(isInverseRelation) ?? []) {
    const { target, inverse } = relationEnds(f, schema.objects);
    const ids = record.fields[f.name];
    if (!target || inverse?.settings.onDelete !== 'cascade' || !Array.isArray(ids) || !ids.length)
      continue;
    impact.push({
      object: target.nameSingular,
      label: ids.length === 1 ? target.labelSingular : target.labelPlural,
      count: ids.length,
    });
  }
  return impact;
}

/** What the person types to confirm erasing a record: its label, or a fixed word. */
export function forgetConfirmation(record: Pick<PresentedRecord, 'label'>): string {
  return record.label?.trim() || 'erase';
}

export type MergeRow = {
  field: FieldView;
  /** The survivor's value. */
  keep: unknown;
  /** The merged-away record's value. */
  merge: unknown;
  /** Both have a value and they differ, so the person may pick one. */
  conflict: boolean;
  /** Left to the server, the two lists are combined rather than one winning. */
  combined: boolean;
};
/**
 * The fields where the two records differ, survivor first. Fields that only
 * one record has are listed without a choice: the merge keeps that value.
 */
export function mergeRows(
  object: ObjectView,
  keep: PresentedRecord,
  merge: PresentedRecord,
): MergeRow[] {
  return object.fields.filter(isWritable).flatMap((field) => {
    const a = keep.fields[field.name],
      b = merge.fields[field.name];
    const emptyA = isEmptyFor(field.type, a),
      emptyB = isEmptyFor(field.type, b);
    if ((emptyA && emptyB) || JSON.stringify(a) === JSON.stringify(b)) return [];
    return [
      {
        field,
        keep: a,
        merge: b,
        conflict: !emptyA && !emptyB,
        combined: MULTI_VALUE_TYPES.has(field.type),
      },
    ];
  });
}

export type MergeChoice = 'auto' | 'keep' | 'merge';
/** `values` for the merge request: only the fields the person decided explicitly. */
export function mergeValues(
  rows: MergeRow[],
  choices: Record<string, MergeChoice>,
): Record<string, unknown> | undefined {
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const choice = choices[row.field.name];
    if (!row.conflict || !choice || choice === 'auto') continue;
    values[row.field.name] = choice === 'keep' ? row.keep : row.merge;
  }
  return Object.keys(values).length ? values : undefined;
}

/** The record that survives by default: the older one, so existing links keep their target. */
export function defaultSurvivor(a: PresentedRecord, b: PresentedRecord): PresentedRecord {
  return Date.parse(b.createdAt) < Date.parse(a.createdAt) ? b : a;
}

/** Record hits grouped by object, in the order each object first appears. */
export function groupRecordHits(
  hits: RecordHit[],
  objects: ObjectView[],
): { object: string; label: string; hits: RecordHit[] }[] {
  const groups = new Map<string, RecordHit[]>();
  for (const hit of hits) groups.set(hit.object, [...(groups.get(hit.object) ?? []), hit]);
  return [...groups].map(([object, list]) => ({
    object,
    label: findObject(objects, object)?.labelPlural ?? object,
    hits: list,
  }));
}
