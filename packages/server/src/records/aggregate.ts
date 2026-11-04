import {
  AGGREGATE_OPS,
  type AggregateOp,
  type AggregateResult,
  type AggregateValue,
  aggregateOps,
  canGroupBy,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { emptyValue, liveLinks, matchingRecords, queryInputSchema, typed } from './query.js';

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

/** One aggregate as named SQL columns; money also reports its currencies. */
function columns(tx: Tx, field: FieldState, op: AggregateOp, n: number): Fragment {
  const value = tx(`a${n}`),
    currencies = tx(`c${n}`),
    currency = tx(`u${n}`);
  const empty = emptyValue(tx, field);
  switch (op) {
    case 'countEmpty':
    case 'percentEmpty':
      return tx`count(*) filter (where ${empty})::int as ${value}`;
    case 'countNotEmpty':
    case 'percentNotEmpty':
      return tx`count(*) filter (where not ${empty})::int as ${value}`;
    case 'countUnique':
      return field.type === 'relation'
        ? // A many-to-one field links each record to at most one live target.
          tx`count(distinct (select l.target_record_id ${liveLinks(tx, field)}))::int as ${value}`
        : tx`count(distinct r.data -> ${field.key}) filter (where not ${empty})::int as ${value}`;
    default: {
      const fn = tx.unsafe(op);
      const result =
        field.type === 'date' || field.type === 'date_time'
          ? tx`to_json(${fn}(${typed(tx, field)})) #>> '{}' as ${value}`
          : tx`${fn}(${typed(tx, field)})::float8 as ${value}`;
      if (field.type !== 'money') return result;
      const code = tx`(r.data -> ${field.key} ->> 'currency')`;
      return tx`${result}, count(distinct ${code})::int as ${currencies}, min(${code}) as ${currency}`;
    }
  }
}

/**
 * The total of the records a filter and search match, and each requested
 * aggregate over them, in one query.
 */
export async function aggregateRecords(
  tx: Tx,
  workspaceId: string,
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
  const selected = [
    tx`count(*)::int as total`,
    ...requests.map((r, n) => columns(tx, r.field, r.op, n)),
  ].reduce((a, b) => tx`${a}, ${b}`);
  if (!group) {
    const [row] = await tx<Record<string, number | string | null>[]>`
      select ${selected} from records r
      where ${matchingRecords(tx, workspaceId, schema, object, input)}`;
    return valuesOf(requests, row);
  }
  // One pass: a row per value of the group field, and the overall row
  // (`grouping(…) = 1`), which the empty grouping set returns even when no
  // record matches.
  // The group value is a column of the subquery, so the select list and the
  // grouping sets name the same expression.
  const rows = await tx<Record<string, number | string | null>[]>`
    select r.g, grouping(r.g) as overall, ${selected}
    from (select r.*, r.data ->> ${group.key} as g from records r
      where ${matchingRecords(tx, workspaceId, schema, object, input)}) r
    group by grouping sets ((r.g), ())`;
  const overall = rows.find((r) => Number(r.overall) === 1);
  return {
    ...valuesOf(requests, overall),
    groups: rows
      .filter((r) => Number(r.overall) === 0)
      .map((r) => ({ value: r.g === null ? null : String(r.g), ...valuesOf(requests, r) })),
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

/** One result row as the API's total and values. */
function valuesOf(
  requests: { field: FieldState; op: AggregateOp }[],
  row: Record<string, number | string | null> | undefined,
): AggregateResult {
  const total = Number(row?.total ?? 0);
  return {
    total,
    values: requests.map(({ field, op }, n): AggregateValue => {
      const raw = row?.[`a${n}`] ?? null;
      if (op === 'percentEmpty' || op === 'percentNotEmpty')
        return { field: field.name, op, value: total ? (Number(raw) / total) * 100 : null };
      if (field.type !== 'money' || raw === null || op.startsWith('count'))
        return { field: field.name, op, value: raw };
      if (Number(row?.[`c${n}`]) > 1)
        return { field: field.name, op, value: null, mixedCurrencies: true };
      return {
        field: field.name,
        op,
        value: { amountMicros: Math.round(Number(raw)), currency: String(row?.[`u${n}`]) },
      };
    }),
  };
}
