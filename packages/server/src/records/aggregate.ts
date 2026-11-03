import {
  AGGREGATE_OPS,
  type AggregateOp,
  type AggregateResult,
  type AggregateValue,
  aggregateOps,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { CompiledObject } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { emptyValue, liveLinks, matchingRecords, queryInputSchema, typed } from './query.js';

export const aggregateInputSchema = queryInputSchema.pick({ search: true, filter: true }).extend({
  aggregates: z
    .array(z.strictObject({ field: z.string(), op: z.enum(AGGREGATE_OPS) }))
    .max(50)
    .default([]),
});
export type AggregateInput = z.infer<typeof aggregateInputSchema>;

const invalidAggregate = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_aggregate', message, details);

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
    const allowed = aggregateOps(field);
    if (!allowed.includes(op)) {
      throw invalidAggregate(`${name} (${field.type}) does not support "${op}"`, {
        field: name,
        allowed,
      });
    }
    return { field, op };
  });
  const selected = [
    tx`count(*)::int as total`,
    ...requests.map((r, n) => columns(tx, r.field, r.op, n)),
  ].reduce((a, b) => tx`${a}, ${b}`);
  const [row] = await tx<Record<string, number | string | null>[]>`
    select ${selected} from records r
    where ${matchingRecords(tx, workspaceId, object, input)}`;
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
