import {
  FILTER_OPERATORS,
  type FieldType,
  type FilterOperator,
  type RecordPage,
  SORTABLE_TYPES,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import { jsonValue, type Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { relationReferences } from '../web/reads.js';
import { normalizeDomain, normalizeEmail, normalizePhone } from './derive.js';
import { presentRecords, RECORD_COLUMNS, type RecordRow } from './read.js';
import { plainPrefixQuery } from './search-sql.js';
import { normalizeFieldValue } from './values.js';

/**
 * Structured filters over one object (5): `{ field: condition }` pairs are
 * ANDed, with `and`, `or` and `not` for nesting. A bare value means `eq`.
 * Only `is_filterable` fields can be filtered or sorted.
 */
export type Filter = { and?: Filter[]; or?: Filter[]; not?: Filter } & Record<string, unknown>;

type Operator = FilterOperator;
const OPERATORS_BY_TYPE = FILTER_OPERATORS;
const SORTABLE: ReadonlySet<FieldType> = new Set(SORTABLE_TYPES);

export const queryInputSchema = z.strictObject({
  search: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Keywords within this object only, matched by Postgres full-text search over its label and ' +
        'searchable fields. Every word must match, as a whole word or the start of one ("Dan" ' +
        'finds "Dana"); accents are ignored.',
    ),
  filter: z.record(z.string(), z.unknown()).optional(),
  sort: z
    .array(z.strictObject({ field: z.string(), direction: z.enum(['asc', 'desc']).default('asc') }))
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  include: z.array(z.enum(['relationReferences'])).optional(),
});
export type QueryInput = z.infer<typeof queryInputSchema>;

/** Record columns that filters and sorts take by name, beside the fields. */
export const BUILT_IN_COLUMNS: Record<string, 'created_at' | 'updated_at' | 'id'> = {
  id: 'id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const invalidFilter = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_filter', message, details);

/** Escapes LIKE wildcards in user text. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The SQL type a field's value is compared as. */
export function typed(tx: Tx, field: FieldState): Fragment {
  const text = tx`(r.data ->> ${field.key})`;
  switch (field.type) {
    case 'number':
      return tx`${text}::numeric`;
    case 'boolean':
      return tx`${text}::boolean`;
    case 'date':
      return tx`${text}::date`;
    case 'date_time':
      return tx`${text}::timestamptz`;
    case 'money':
      return tx`((r.data -> ${field.key}) ->> 'amountMicros')::numeric`;
    default:
      return text;
  }
}

function castParam(tx: Tx, field: FieldState, value: unknown): Fragment {
  switch (field.type) {
    case 'number':
    case 'money':
      return tx`${value as number}::numeric`;
    case 'date':
      return tx`${value as string}::date`;
    case 'date_time':
      return tx`${value as string}::timestamptz`;
    case 'boolean':
      return tx`${value as boolean}::boolean`;
    default:
      return tx`${value as string}`;
  }
}

function compileCondition(
  tx: Tx,
  object: CompiledObject,
  name: string,
  condition: unknown,
): Fragment {
  const builtIn = BUILT_IN_COLUMNS[name];
  const conditions =
    condition !== null && typeof condition === 'object' && !Array.isArray(condition)
      ? (condition as Record<string, unknown>)
      : { eq: condition };
  const parts: Fragment[] = [];

  if (builtIn) {
    for (const [op, value] of Object.entries(conditions)) {
      const column = tx(`r.${builtIn}`);
      const cast =
        builtIn === 'id' ? tx`${value as string}::uuid` : tx`${value as string}::timestamptz`;
      const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      if (op === 'in' && Array.isArray(value)) {
        parts.push(
          builtIn === 'id'
            ? tx`${column} = any(${value as string[]}::uuid[])`
            : tx`${column} = any(${value as string[]}::timestamptz[])`,
        );
      } else if (sqlOp) {
        parts.push(tx`${column} ${tx.unsafe(sqlOp)} ${cast}`);
      } else {
        throw invalidFilter(`${name} does not support "${op}"`, {
          field: name,
          allowed: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
        });
      }
    }
    return and(tx, parts);
  }

  const field = object.fieldsByName.get(name);
  if (!field) {
    throw invalidFilter(`unknown field "${name}" on ${object.name}`, {
      field: name,
      allowed: filterableNames(object),
    });
  }
  if (!field.isFilterable) {
    throw invalidFilter(`${name} is not filterable`, {
      field: name,
      allowed: filterableNames(object),
    });
  }
  const allowed = [...OPERATORS_BY_TYPE[field.type], 'isNull'];

  for (const [op, raw] of Object.entries(conditions)) {
    if (!(allowed as string[]).includes(op)) {
      throw invalidFilter(`${name} (${field.type}) does not support "${op}"`, {
        field: name,
        allowed,
      });
    }
    parts.push(compileOperator(tx, field, op as Operator, raw));
  }
  return and(tx, parts);
}

function filterableNames(object: CompiledObject): string[] {
  return [
    ...Object.keys(BUILT_IN_COLUMNS),
    ...object.activeFields.filter((f) => f.isFilterable).map((f) => f.name),
  ];
}

/** Validates a filter value with the field's own rules, naming the field on error. */
function valueFor(field: FieldState, value: unknown): unknown {
  try {
    if (field.type === 'money') {
      if (typeof value !== 'number') throw new Error('expected amountMicros as a number');
      return value;
    }
    return normalizeFieldValue(field, value);
  } catch (error) {
    throw invalidFilter(`invalid value for ${field.name}: ${(error as Error).message}`, {
      field: field.name,
      ...((error as { allowed?: unknown[] }).allowed
        ? { allowed: (error as { allowed?: unknown[] }).allowed }
        : {}),
    });
  }
}

function compileOperator(tx: Tx, field: FieldState, op: Operator, raw: unknown): Fragment {
  const key = field.key;

  if (op === 'isNull') {
    if (typeof raw !== 'boolean') throw invalidFilter(`${field.name}.isNull takes true or false`);
    const empty = emptyValue(tx, field);
    return raw ? empty : tx`not ${empty}`;
  }

  if (field.type === 'relation') {
    const ids = op === 'in' ? raw : [raw];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw invalidFilter(`${field.name}.${op} takes record IDs`);
    }
    return tx`exists (select 1 from record_links l
      where l.source_record_id = r.id and l.field_id = ${field.id as string}
        and l.target_record_id = any(${ids as string[]}::uuid[]))`;
  }

  if (field.type === 'emails' || field.type === 'phones' || field.type === 'links') {
    if (typeof raw !== 'string') throw invalidFilter(`${field.name}.eq takes a single value`);
    const value =
      field.type === 'emails'
        ? normalizeEmail(raw)
        : field.type === 'phones'
          ? normalizePhone(raw)
          : normalizeDomain(raw);
    return tx`exists (select 1 from record_identifiers i
      where i.record_id = r.id and i.field_id = ${field.id as string} and i.value = ${value ?? ''})`;
  }

  if (op === 'contains') {
    if (typeof raw !== 'string' || raw === '')
      throw invalidFilter(`${field.name}.contains takes text`);
    if (field.type === 'multi_select') {
      valueFor(field, [raw]);
      return tx`(r.data -> ${key}) ? ${raw}`;
    }
    if (field.type === 'full_name') {
      return tx`concat_ws(' ', r.data -> ${key} ->> 'first', r.data -> ${key} ->> 'last')
        ilike ${likePattern(raw)}`;
    }
    // text and address: match anywhere in the value's text.
    return tx`(r.data ->> ${key}) ilike ${likePattern(raw)}`;
  }

  if (op === 'in') {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalidFilter(`${field.name}.in takes a non-empty array`);
    }
    // Containment per value uses the GIN index on data.
    const alternatives = raw.map(
      (v) => tx`r.data @> ${tx.json(jsonValue({ [key]: valueFor(field, v) }))}`,
    );
    return tx`(${alternatives.reduce((a, b) => tx`${a} or ${b}`)})`;
  }

  const value = valueFor(field, raw);
  if (op === 'eq' && field.type !== 'date_time') {
    return tx`r.data @> ${tx.json(jsonValue({ [key]: value }))}`;
  }
  if (op === 'neq' && field.type !== 'date_time') {
    return tx`not (r.data @> ${tx.json(jsonValue({ [key]: value }))})`;
  }
  const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
  if (!sqlOp) throw invalidFilter(`unsupported operator ${op}`);
  return tx`${typed(tx, field)} ${tx.unsafe(sqlOp)} ${castParam(tx, field, value)}`;
}

function and(tx: Tx, parts: Fragment[]): Fragment {
  if (parts.length === 0) return tx`true`;
  return tx`(${parts.reduce((a, b) => tx`${a} and ${b}`)})`;
}

function or(tx: Tx, parts: Fragment[]): Fragment {
  if (parts.length === 0) return tx`false`;
  return tx`(${parts.reduce((a, b) => tx`${a} or ${b}`)})`;
}

export function compileFilter(
  tx: Tx,
  object: CompiledObject,
  filter: unknown,
  depth = 0,
): Fragment {
  if (depth > 8) throw invalidFilter('filters nest at most 8 levels deep');
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw invalidFilter('a filter is an object of field conditions');
  }
  const parts: Fragment[] = [];
  for (const [name, condition] of Object.entries(filter)) {
    if (name === 'and' || name === 'or') {
      if (!Array.isArray(condition)) throw invalidFilter(`${name} takes an array of filters`);
      const nested = condition.map((f) => compileFilter(tx, object, f, depth + 1));
      parts.push(name === 'and' ? and(tx, nested) : or(tx, nested));
    } else if (name === 'not') {
      parts.push(tx`not ${compileFilter(tx, object, condition, depth + 1)}`);
    } else {
      parts.push(compileCondition(tx, object, name, condition));
    }
  }
  return and(tx, parts);
}

export function compileSort(tx: Tx, object: CompiledObject, sort: QueryInput['sort']): Fragment {
  const parts: Fragment[] = [];
  for (const { field: name, direction } of sort ?? []) {
    const dir = tx.unsafe(direction === 'desc' ? 'desc' : 'asc');
    const builtIn = BUILT_IN_COLUMNS[name];
    if (builtIn) {
      parts.push(tx`${tx(`r.${builtIn}`)} ${dir}`);
      continue;
    }
    const field = object.fieldsByName.get(name);
    if (!field?.isFilterable || !SORTABLE.has(field.type)) {
      throw invalidFilter(`cannot sort by "${name}"`, {
        field: name,
        allowed: [
          ...Object.keys(BUILT_IN_COLUMNS),
          ...object.activeFields
            .filter((f) => f.isFilterable && SORTABLE.has(f.type))
            .map((f) => f.name),
        ],
      });
    }
    parts.push(tx`${typed(tx, field)} ${dir} nulls last`);
  }
  // A stable order makes cursors deterministic.
  parts.push(tx`r.created_at asc`, tx`r.id asc`);
  return parts.reduce((a, b) => tx`${a}, ${b}`);
}

const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ offset })).toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {}
  throw invalidFilter('invalid cursor; pass nextCursor from the previous page');
}

/**
 * The live records of one object that a filter and keyword search match, as
 * a `where` clause over `records r`. The list and its totals share it, so
 * they always count the same records.
 */
export function matchingRecords(
  tx: Tx,
  workspaceId: string,
  object: CompiledObject,
  input: Pick<QueryInput, 'filter' | 'search'>,
): Fragment {
  const where = input.filter ? compileFilter(tx, object, input.filter) : tx`true`;
  return tx`r.workspace_id = ${workspaceId} and r.object_type_id = ${object.id}
    and r.deleted_at is null and ${where}
    ${input.search ? tx`and r.search @@ ${plainPrefixQuery(tx, input.search)}` : tx``}`;
}

/** `from … where …` over the live targets record `r` links to through `field`. */
export function liveLinks(tx: Tx, field: FieldState): Fragment {
  return tx`from record_links l join records t
    on t.id = l.target_record_id and t.deleted_at is null
    where l.source_record_id = r.id and l.field_id = ${field.id as string}`;
}

/** Whether a field has no value, as the `isNull` filter decides it. */
export function emptyValue(tx: Tx, field: FieldState): Fragment {
  if (field.type === 'relation') return tx`not exists (select 1 ${liveLinks(tx, field)})`;
  return tx`coalesce(r.data -> ${field.key}, 'null'::jsonb) = 'null'::jsonb`;
}

/** Filters, sorts and pages live records of one object. */
export async function queryRecords(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  object: CompiledObject,
  input: QueryInput,
): Promise<RecordPage> {
  const offset = decodeCursor(input.cursor);
  const columns = RECORD_COLUMNS.map((c) => `r.${c}`);
  const rows = await tx<RecordRow[]>`
    select ${tx.unsafe(columns.join(', '))} from records r
    where ${matchingRecords(tx, workspaceId, object, input)}
    order by ${compileSort(tx, object, input.sort)}
    limit ${input.limit + 1} offset ${offset}`;
  const page = rows.slice(0, input.limit);
  const records = await presentRecords(tx, schema, page);
  const refs = input.include?.includes('relationReferences')
    ? await relationReferences(tx, schema, records)
    : undefined;
  return {
    records,
    ...(refs ? { relationReferences: refs } : {}),
    nextCursor: rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
  };
}
