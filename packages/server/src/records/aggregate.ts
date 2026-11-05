import {
  AGGREGATE_OPS,
  type AggregateOp,
  type AggregateResult,
  type AggregateValue,
  aggregateOps,
  canGroupBy,
} from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import { AppError } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { column, linksExpr, matchingRecords, queryInputSchema } from './query.js';

export const aggregateInputSchema = queryInputSchema.pick({ search: true, filter: true }).extend({
  aggregates: z
    .array(z.strictObject({ field: z.string(), op: z.enum(AGGREGATE_OPS) }))
    .max(50)
    .default([]),
  groupBy: z
    .string()
    .optional()
    .describe('A filterable select field: also compute the total and aggregates per option.'),
});
export type AggregateInput = z.infer<typeof aggregateInputSchema>;

const invalidAggregate = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_aggregate', message, details);

/** Throws `fail(…)` unless the field supports the op, listing the ops it does. */
export function checkAggregateOp(
  field: FieldState,
  op: AggregateOp,
  fail: (message: string, details: Record<string, unknown>) => Error,
): void {
  const allowed = aggregateOps(field);
  if (!allowed.includes(op))
    throw fail(`${field.name} (${field.type}) does not support "${op}"`, {
      field: field.name,
      allowed,
    });
}

type Request = { field: FieldState; op: AggregateOp };
type Row = Record<string, unknown>;

const isEmpty = (field: FieldState, value: unknown) =>
  value === undefined ||
  value === null ||
  (field.type === 'relation' && Array.isArray(value) && value.length === 0);

/** A value as aggregates compare it: money by amount, dates as instants. */
function measure(field: FieldState, value: unknown): number | null {
  if (isEmpty(field, value)) return null;
  if (field.type === 'money') return Number((value as { amountMicros: number }).amountMicros);
  if (field.type === 'date_time')
    return (value instanceof Date ? value : new Date(String(value))).getTime();
  if (field.type === 'date') return Date.parse(`${String(value)}T00:00:00Z`);
  return Number(value);
}

/** One aggregate over some rows, as the raw result row kept: value, currencies, currency. */
function compute(request: Request, alias: string, rows: Row[]): AggregateValue['value'] | object {
  const { field, op } = request;
  const values = rows.map((r) => r[alias]);
  const filled = values.filter((v) => !isEmpty(field, v));
  switch (op) {
    case 'countEmpty':
    case 'percentEmpty':
      return values.length - filled.length;
    case 'countNotEmpty':
    case 'percentNotEmpty':
      return filled.length;
    case 'countUnique': {
      const keys = filled.flatMap((v) =>
        field.type === 'relation' ? (v as string[]) : [JSON.stringify(v)],
      );
      return new Set(keys).size;
    }
    default: {
      const numbers = filled.map((v) => measure(field, v) as number).filter(Number.isFinite);
      if (numbers.length === 0) return null;
      const result =
        op === 'sum'
          ? numbers.reduce((a, b) => a + b, 0)
          : op === 'avg'
            ? numbers.reduce((a, b) => a + b, 0) / numbers.length
            : op === 'min'
              ? Math.min(...numbers)
              : Math.max(...numbers);
      if (field.type === 'date') return new Date(result).toISOString().slice(0, 10);
      if (field.type === 'date_time') return new Date(result).toISOString();
      if (field.type !== 'money') return result;
      const currencies = [
        ...new Set(filled.map((v) => String((v as { currency: string }).currency))),
      ].sort();
      return { amount: result, currencies };
    }
  }
}

/**
 * The total of the records a filter and search match, and each requested
 * aggregate over them. One statement reads the matching records' values for
 * the requested fields; the aggregates are computed from them.
 */
export async function aggregateRecords(
  db: Db,
  _workspaceId: string,
  schema: CompiledSchema,
  object: CompiledObject,
  input: AggregateInput,
): Promise<AggregateResult> {
  const requests = input.aggregates.map(({ field: name, op }) => {
    const field = object.fieldsByName.get(name);
    if (!field) {
      throw invalidAggregate(`unknown field "${name}" on ${object.name}`, {
        field: name,
        allowed: object.activeFields.filter((f) => aggregateOps(f).length).map((f) => f.name),
      });
    }
    checkAggregateOp(field, op, invalidAggregate);
    return { field, op };
  });
  const group = input.groupBy === undefined ? undefined : groupField(object, input.groupBy);
  const aliases = new Map<string, string>();
  const projections: string[] = ['id'];
  for (const { field } of requests) {
    if (aliases.has(field.id as string)) continue;
    const alias = `a${aliases.size}`;
    aliases.set(field.id as string, alias);
    projections.push(
      `${field.type === 'relation' ? linksExpr(schema, field) : column(field)} AS ${alias}`,
    );
  }
  if (group) projections.push(`${column(group)} AS g`);
  const matching = await matchingRecords(db, schema, object, input);
  const rows = matching
    ? await db.rows<Row>(
        `${matching.prelude}
         SELECT ${projections.join(', ')} FROM ${matching.from} WHERE ${matching.where};`,
        matching.vars,
      )
    : [];
  const valuesOver = (subset: Row[]) =>
    valuesOf(
      requests,
      subset.length,
      requests.map((r) => compute(r, aliases.get(r.field.id as string) as string, subset)),
    );
  if (!group) return valuesOver(rows);
  const groups = new Map<string | null, Row[]>();
  for (const row of rows) {
    const value = row.g === undefined || row.g === null ? null : String(row.g);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return {
    ...valuesOver(rows),
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0))
      .map(([value, subset]) => ({ value, ...valuesOver(subset) })),
  };
}

/** The field a grouped aggregate splits by: a filterable select field of the object. */
function groupField(object: CompiledObject, name: string): FieldState {
  const field = object.fieldsByName.get(name);
  const allowed = object.activeFields.filter(canGroupBy).map((f) => f.name);
  if (!field)
    throw invalidAggregate(`unknown field "${name}" on ${object.name}`, { field: name, allowed });
  if (!canGroupBy(field))
    throw invalidAggregate(`groupBy takes a filterable select field; ${name} is not one`, {
      field: name,
      allowed,
    });
  return field;
}

/** Computed aggregates as the API's total and values. */
function valuesOf(requests: Request[], total: number, results: unknown[]): AggregateResult {
  return {
    total,
    values: requests.map(({ field, op }, n): AggregateValue => {
      const raw = results[n] ?? null;
      if (op === 'percentEmpty' || op === 'percentNotEmpty')
        return { field: field.name, op, value: total ? (Number(raw) / total) * 100 : null };
      if (field.type !== 'money' || raw === null || op.startsWith('count'))
        return { field: field.name, op, value: raw as AggregateValue['value'] };
      const money = raw as { amount: number; currencies: string[] };
      if (money.currencies.length > 1)
        return { field: field.name, op, value: null, mixedCurrencies: true };
      return {
        field: field.name,
        op,
        value: { amountMicros: Math.round(money.amount), currency: String(money.currencies[0]) },
      };
    }),
  };
}
