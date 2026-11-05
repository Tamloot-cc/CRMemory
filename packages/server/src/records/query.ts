import {
  EVENT_ATTACHMENTS,
  type FieldType,
  type FilterOperator,
  filterOperatorsFor,
  isCollectionRelation,
  type RecordPage,
  SORTABLE_TYPES,
} from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { fieldColumn, relationTable } from '../db/names.js';
import { ident } from '../db/surreal.js';
import { AppError } from '../errors.js';
import { directEventIds } from '../retrieval/history.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { relationReferences } from '../web/reads.js';
import { normalizeDomain, normalizeEmail, normalizePhone } from './derive.js';
import { owningFieldOf, presentRecords } from './read.js';
import { plainSearch, searchCondition } from './search-sql.js';
import { directoryEntry, rowFromNative } from './store.js';
import { normalizeFieldValue } from './values.js';
import { resolveRecordIdIn } from './write.js';

/**
 * Structured filters over one object (5): `{ field: condition }` pairs are
 * ANDed, with `and`, `or` and `not` for nesting. A bare value means `eq`.
 * Only `is_filterable` fields can be filtered or sorted. Filters compile to
 * a SurrealQL condition over the object's table; every value is a parameter
 * and every identifier comes from validated metadata.
 */
export type Filter = { and?: Filter[]; or?: Filter[]; not?: Filter } & Record<string, unknown>;

type Operator = FilterOperator;
const SORTABLE: ReadonlySet<FieldType> = new Set(SORTABLE_TYPES);

export const queryInputSchema = z.strictObject({
  search: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Keywords within this object only, matched by full-text search over its label and ' +
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
  linked: z
    .strictObject({
      record: z.uuid(),
      link: z.enum(EVENT_ATTACHMENTS).optional(),
    })
    .optional()
    .describe(
      'Event types only: events directly attached to this record, as a participant, about it, ' +
        "or through one of the event's own relation fields (link: field).",
    ),
});
export type QueryInput = z.infer<typeof queryInputSchema>;

/** Parameters of one statement: values never reach the text. */
export class Params {
  readonly vars: Record<string, unknown> = {};
  /** `LET` statements the condition reads, run once before it. */
  readonly lets: string[] = [];
  private n = 0;
  constructor(private readonly prefix = 'q') {}
  v(value: unknown): string {
    const name = `${this.prefix}${this.n++}`;
    this.vars[name] = value;
    return `$${name}`;
  }
  /** A value computed once by a statement before the query. */
  let(statement: string): string {
    const name = `${this.prefix}${this.n++}`;
    this.lets.push(`LET $${name} = (${statement});`);
    return `$${name}`;
  }
}

/** Record columns that filters and sorts take by name, beside the fields. */
export const BUILT_IN_COLUMNS: Record<string, 'created_at' | 'updated_at' | 'id'> = {
  id: 'id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

/** An event record's built-in columns (6.1), filterable and sortable like fields. */
const EVENT_COLUMN_NAMES: Record<string, 'occurred_at' | 'channel' | 'external_id'> = {
  occurredAt: 'occurred_at',
  channel: 'channel',
  externalId: 'external_id',
};

type BuiltIn = { expr: string; type: 'uuid' | 'datetime' | 'text' };

/** A built-in column of `object` by API name, as an expression over its table. */
function builtInColumn(object: CompiledObject, name: string): BuiltIn | undefined {
  const record = BUILT_IN_COLUMNS[name];
  if (record === 'id') return { expr: 'record::id(id)', type: 'uuid' };
  if (record) return { expr: ident(record), type: 'datetime' };
  const event = object.isEvent ? EVENT_COLUMN_NAMES[name] : undefined;
  if (event === 'occurred_at') return { expr: ident('occurred_at'), type: 'datetime' };
  if (event) {
    return {
      expr: `type::record('event_identity', record::id(id)).${ident(event)}`,
      type: 'text',
    };
  }
  return undefined;
}

/** Built-in column names an object's filters and sorts take. */
export function builtInNames(object: CompiledObject): string[] {
  return [
    ...Object.keys(BUILT_IN_COLUMNS),
    ...(object.isEvent ? Object.keys(EVENT_COLUMN_NAMES) : []),
  ];
}

const invalidFilter = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_filter', message, details);

/** A field's column. */
export const column = (field: FieldState) => ident(fieldColumn(field.key));

/** Whether an expression holds a value (neither NONE nor null). */
const present = (expr: string) => `(${expr} != NONE AND ${expr} != NULL)`;

/** The comparable value of a field: money compares by amount. */
export function typed(field: FieldState): string {
  return field.type === 'money' ? `${column(field)}.amountMicros` : column(field);
}

/** A filter value as the column stores it. */
function stored(field: FieldState, value: unknown): unknown {
  return field.type === 'date_time' && typeof value === 'string' ? new Date(value) : value;
}

/**
 * The public IDs of a record's targets through a relation field, owning or
 * inverse, as an expression over the record (its own graph pointers).
 * `live` leaves out deleted targets.
 */
export function linksExpr(schema: CompiledSchema, field: FieldState, live = true): string {
  const where = live ? '? WHERE deleted_at = NONE' : '?';
  if (!field.settings.isInverse) {
    return `(->${ident(relationTable(field.universalId))}->(${where})).map(|$x| record::id($x))`;
  }
  const owning = owningFieldOf(schema, field);
  if (!owning) return '[]';
  return `(<-${ident(relationTable(owning.universalId))}<-(${where})).map(|$x| record::id($x))`;
}

function compileCondition(
  schema: CompiledSchema,
  object: CompiledObject,
  name: string,
  condition: unknown,
  p: Params,
): string {
  const builtIn = builtInColumn(object, name);
  const conditions =
    condition !== null && typeof condition === 'object' && !Array.isArray(condition)
      ? (condition as Record<string, unknown>)
      : { eq: condition };
  const parts: string[] = [];

  if (builtIn) {
    const ordered = builtIn.type !== 'text';
    const allowed = ordered ? ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'neq', 'in'];
    const fail = (op: string) =>
      invalidFilter(`${name} does not support "${op}" with that value`, { field: name, allowed });
    const cast = (op: string, value: unknown) => {
      if (typeof value !== 'string') throw fail(op);
      if (builtIn.type === 'datetime') {
        if (!Number.isFinite(Date.parse(value))) throw fail(op);
        return new Date(value);
      }
      if (builtIn.type === 'uuid' && !z.uuid().safeParse(value).success) throw fail(op);
      return value;
    };
    for (const [op, value] of Object.entries(conditions)) {
      const sqlOp = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      if (op === 'in' && Array.isArray(value)) {
        parts.push(`${builtIn.expr} IN ${p.v(value.map((v) => cast(op, v)))}`);
      } else if (sqlOp && allowed.includes(op)) {
        const v = p.v(cast(op, value));
        parts.push(
          op === 'eq' || op === 'neq'
            ? `${builtIn.expr} ${sqlOp} ${v}`
            : `(${present(builtIn.expr)} AND ${builtIn.expr} ${sqlOp} ${v})`,
        );
      } else {
        throw fail(op);
      }
    }
    return and(parts);
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
  const allowed = filterOperatorsFor(field);

  for (const [op, raw] of Object.entries(conditions)) {
    if (!(allowed as string[]).includes(op)) {
      throw invalidFilter(`${name} (${field.type}) does not support "${op}"`, {
        field: name,
        allowed,
      });
    }
    parts.push(compileOperator(schema, field, op as Operator, raw, p));
  }
  return and(parts);
}

function filterableNames(object: CompiledObject): string[] {
  return [
    ...builtInNames(object),
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

function compileOperator(
  schema: CompiledSchema,
  field: FieldState,
  op: Operator,
  raw: unknown,
  p: Params,
): string {
  const col = column(field);

  if (op === 'isNull') {
    if (typeof raw !== 'boolean') throw invalidFilter(`${field.name}.isNull takes true or false`);
    const empty = emptyValue(schema, field);
    return raw ? empty : `!(${empty})`;
  }

  if (isCollectionRelation(field)) {
    if (op === 'isEmpty') {
      if (typeof raw !== 'boolean')
        throw invalidFilter(`${field.name}.isEmpty takes true or false`);
      const empty = emptyValue(schema, field);
      return raw ? empty : `!(${empty})`;
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== 'string')) {
      throw invalidFilter(`${field.name}.${op} takes a non-empty array of record IDs`);
    }
    const ids = [...new Set(raw as string[])];
    return `${linksExpr(schema, field)} ${op === 'containsAny' ? 'CONTAINSANY' : 'CONTAINSALL'} ${p.v(ids)}`;
  }

  if (field.type === 'relation') {
    const ids = op === 'in' ? raw : [raw];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw invalidFilter(`${field.name}.${op} takes record IDs`);
    }
    return `${linksExpr(schema, field, false)} CONTAINSANY ${p.v(ids)}`;
  }

  if (field.type === 'emails' || field.type === 'phones' || field.type === 'links') {
    if (typeof raw !== 'string') throw invalidFilter(`${field.name}.eq takes a single value`);
    const value =
      field.type === 'emails'
        ? normalizeEmail(raw)
        : field.type === 'phones'
          ? normalizePhone(raw)
          : normalizeDomain(raw);
    // The records holding the identifier, found once through (field_id, value).
    const holders = p.let(
      `SELECT VALUE record FROM record_identifiers WHERE field_id = ${p.v(field.id)} AND value = ${p.v(value ?? '')}`,
    );
    return `record::id(id) IN ${holders}`;
  }

  if (op === 'contains') {
    if (typeof raw !== 'string' || raw === '')
      throw invalidFilter(`${field.name}.contains takes text`);
    if (field.type === 'multi_select') {
      valueFor(field, [raw]);
      return `(${present(col)} AND ${col} CONTAINS ${p.v(raw)})`;
    }
    const needle = p.v(raw.toLowerCase());
    if (field.type === 'full_name') {
      return `(${present(col)} AND string::contains(string::lowercase(string::concat(${col}.first ?? '', ' ', ${col}.last ?? '')), ${needle}))`;
    }
    // text and address: match anywhere in the value's text.
    return `(${present(col)} AND string::contains(string::lowercase(<string>${col}), ${needle}))`;
  }

  if (op === 'in') {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalidFilter(`${field.name}.in takes a non-empty array`);
    }
    return `${col} IN ${p.v(raw.map((v) => stored(field, valueFor(field, v))))}`;
  }

  const value = stored(field, valueFor(field, raw));
  if (op === 'eq') return `${col} = ${p.v(value)}`;
  if (op === 'neq') return `${col} != ${p.v(value)}`;
  const sqlOp = ({ gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[op];
  if (!sqlOp) throw invalidFilter(`unsupported operator ${op}`);
  return `(${present(typed(field))} AND ${typed(field)} ${sqlOp} ${p.v(value)})`;
}

function and(parts: string[]): string {
  if (parts.length === 0) return 'true';
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' AND ')})`;
}

function or(parts: string[]): string {
  if (parts.length === 0) return 'false';
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' OR ')})`;
}

/** A filter as a SurrealQL condition over the object's table; throws `invalid_filter`. */
export function compileFilter(
  schema: CompiledSchema,
  object: CompiledObject,
  filter: unknown,
  p: Params = new Params(),
  depth = 0,
): string {
  if (depth > 8) throw invalidFilter('filters nest at most 8 levels deep');
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw invalidFilter('a filter is an object of field conditions');
  }
  const parts: string[] = [];
  for (const [name, condition] of Object.entries(filter)) {
    if (name === 'and' || name === 'or') {
      if (!Array.isArray(condition)) throw invalidFilter(`${name} takes an array of filters`);
      const nested = condition.map((f) => compileFilter(schema, object, f, p, depth + 1));
      parts.push(name === 'and' ? and(nested) : or(nested));
    } else if (name === 'not') {
      parts.push(`!(${compileFilter(schema, object, condition, p, depth + 1)})`);
    } else {
      parts.push(compileCondition(schema, object, name, condition, p));
    }
  }
  return and(parts);
}

/**
 * A sort as computed sort keys and an order: each key sorts values first
 * and empty values last, in either direction. Ends with creation time and
 * ID, so pages are stable.
 */
export function compileSort(
  object: CompiledObject,
  sort: QueryInput['sort'],
): { select: string[]; order: string[] } {
  const select: string[] = [];
  const order: string[] = [];
  (sort ?? []).forEach(({ field: name, direction }, i) => {
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const builtIn = builtInColumn(object, name);
    let expr: string;
    if (builtIn) expr = builtIn.expr;
    else {
      const field = object.fieldsByName.get(name);
      if (!field?.isFilterable || !SORTABLE.has(field.type)) {
        throw invalidFilter(`cannot sort by "${name}"`, {
          field: name,
          allowed: [
            ...builtInNames(object),
            ...object.activeFields
              .filter((f) => f.isFilterable && SORTABLE.has(f.type))
              .map((f) => f.name),
          ],
        });
      }
      expr = typed(field);
    }
    select.push(`!${present(expr)} AS _e${i}`, `${expr} AS _s${i}`);
    order.push(`_e${i} ASC`, `_s${i} ${dir}`);
  });
  return { select, order: [...order, 'created_at ASC', 'id ASC'] };
}

const encodeOffset = (offset: number) =>
  Buffer.from(JSON.stringify({ offset })).toString('base64url');

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {}
  throw invalidFilter('invalid cursor; pass nextCursor from the previous page');
}

/**
 * The live records of one object that a filter, keyword search and
 * `linked` match: a source (the object's table, or the record IDs search or
 * `linked` narrowed it to) and a condition over it. The list and its totals
 * share it, so they always count the same records. `null` matches nothing.
 */
export type Matching = {
  from: string;
  where: string;
  vars: Record<string, unknown>;
  /** Statements to run before the query (`LET`s the condition reads). */
  prelude: string;
} | null;

export async function matchingRecords(
  db: Db,
  schema: CompiledSchema,
  object: CompiledObject,
  input: Pick<QueryInput, 'filter' | 'search' | 'linked'>,
): Promise<Matching> {
  const p = new Params();
  const conditions = ['deleted_at = NONE', 'merged_into = NONE'];
  if (input.filter) conditions.push(compileFilter(schema, object, input.filter, p));
  let ids: string[] | undefined;
  if (input.linked) ids = await linkedTo(db, schema, object, input.linked);
  if (input.search) {
    const found = await searchOwners(db, object, input.search);
    ids = ids ? ids.filter((id) => found.has(id)) : [...found];
  }
  if (ids !== undefined) {
    if (ids.length === 0) return null;
    return {
      from: p.v(ids.map((id) => new RecordId(object.table, id))),
      where: conditions.join(' AND '),
      vars: p.vars,
      prelude: p.lets.join('\n'),
    };
  }
  return {
    from: ident(object.table),
    where: conditions.join(' AND '),
    vars: p.vars,
    prelude: p.lets.join('\n'),
  };
}

/** Records of one object whose search document has every word (as prefixes). */
async function searchOwners(db: Db, object: CompiledObject, text: string): Promise<Set<string>> {
  const condition = searchCondition(plainSearch(text), 'all_text');
  if (!condition.where) return new Set();
  const owners = await db.rows<string>(
    `SELECT VALUE owner FROM search_documents WHERE ${condition.where} AND kind = 'record' AND object_type_id = $object;`,
    { ...condition.vars, object: object.id },
  );
  return new Set(owners);
}

/**
 * Events directly attached to a record (7.1): a merged record ID counts as
 * its survivor. A record that is deleted or of a hidden object links
 * nothing, as every read of it does. Only event types take `linked`.
 */
async function linkedTo(
  db: Db,
  schema: CompiledSchema,
  object: CompiledObject,
  linked: NonNullable<QueryInput['linked']>,
): Promise<string[]> {
  if (!object.isEvent) {
    throw invalidFilter(`linked applies to event types; ${object.name} is an entity`, {
      field: 'linked',
    });
  }
  // An unknown ID links nothing too.
  if (!(await directoryEntry(db, linked.record))) return [];
  const id = await resolveRecordIdIn(db, linked.record);
  const entry = await directoryEntry(db, id);
  if (!entry || entry.deleted_at || !schema.visibleObjectIds.includes(entry.object_type_id)) {
    return [];
  }
  return directEventIds(db, schema, id, linked.link);
}

/** Whether a field has no value, as the `isNull` filter decides it. */
export function emptyValue(schema: CompiledSchema, field: FieldState): string {
  if (field.type === 'relation') return `array::len(${linksExpr(schema, field)}) = 0`;
  return `!${present(column(field))}`;
}

/** Filters, sorts and pages live records of one object. */
export async function queryRecords(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  object: CompiledObject,
  input: QueryInput,
): Promise<RecordPage> {
  const offset = decodeOffset(input.cursor);
  const sort = compileSort(object, input.sort);
  const matching = await matchingRecords(db, schema, object, input);
  const natives = matching
    ? await db.rows<Parameters<typeof rowFromNative>[2]>(
        `${matching.prelude}
         SELECT *${sort.select.length ? `, ${sort.select.join(', ')}` : ''} FROM ${matching.from}
         WHERE ${matching.where} ORDER BY ${sort.order.join(', ')}
         LIMIT ${input.limit + 1} START ${offset};`,
        matching.vars,
      )
    : [];
  const rows = natives.map((n) => rowFromNative(workspaceId, object, n));
  const page = rows.slice(0, input.limit);
  const records = await presentRecords(db, schema, page);
  const refs = input.include?.includes('relationReferences')
    ? await relationReferences(db, schema, records)
    : undefined;
  return {
    records,
    ...(refs ? { relationReferences: refs } : {}),
    nextCursor: rows.length > input.limit ? encodeOffset(offset + input.limit) : null,
  };
}
