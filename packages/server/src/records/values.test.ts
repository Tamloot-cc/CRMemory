import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { CompiledObject } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';
import { normalizeFieldValue, prepareValues } from './values.js';

const field = (overrides: Partial<FieldState>): FieldState => ({
  universalId: 'u',
  key: overrides.name ?? 'k',
  name: 'k',
  label: 'K',
  description: null,
  type: 'text',
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  isProtected: false,
  coreRole: null,
  owner: 'system',
  status: 'active',
  ...overrides,
});

const ok = (f: Partial<FieldState>, value: unknown) => normalizeFieldValue(field(f), value);
const bad = (f: Partial<FieldState>, value: unknown) => () => normalizeFieldValue(field(f), value);

describe('normalizeFieldValue', () => {
  it('checks scalar types', () => {
    expect(ok({ type: 'number' }, 3.5)).toBe(3.5);
    expect(bad({ type: 'number' }, '3')).toThrow('finite number');
    expect(bad({ type: 'number' }, Number.NaN)).toThrow('finite number');
    expect(ok({ type: 'boolean' }, false)).toBe(false);
    expect(bad({ type: 'text' }, 5)).toThrow('string');
  });

  it('accepts real calendar dates and zoned date-times', () => {
    expect(ok({ type: 'date' }, '2024-02-29')).toBe('2024-02-29');
    expect(bad({ type: 'date' }, '2023-02-29')).toThrow('real calendar date');
    expect(ok({ type: 'date_time' }, '2026-11-02T11:30:00+02:00')).toBe('2026-11-02T09:30:00.000Z');
    expect(bad({ type: 'date_time' }, '2026-11-02T11:30:00')).toThrow('time zone');
  });

  it('checks options and lists the allowed values', () => {
    const settings = {
      options: [
        { value: 'todo', label: 'To do' },
        { value: 'done', label: 'Done' },
      ],
    };
    expect(ok({ type: 'select', settings }, 'done')).toBe('done');
    try {
      ok({ type: 'select', settings }, 'Done');
      expect.unreachable();
    } catch (error) {
      expect((error as { allowed: unknown }).allowed).toEqual(['todo', 'done']);
    }
    expect(ok({ type: 'multi_select', settings }, ['done', 'todo', 'done'])).toEqual([
      'done',
      'todo',
    ]);
  });

  it('accepts bare values for multi-value composites and normalizes them', () => {
    expect(ok({ type: 'emails' }, 'Dana@Acme.com')).toEqual({
      primary: 'dana@acme.com',
      additional: [],
    });
    expect(
      ok({ type: 'emails' }, { primary: null, additional: ['a@x.io', 'b@x.io', 'A@x.io'] }),
    ).toEqual({ primary: 'a@x.io', additional: ['b@x.io'] });
    expect(bad({ type: 'emails' }, 'not-an-email')).toThrow();
    expect(ok({ type: 'links' }, 'acme.com')).toEqual({
      primary: { url: 'https://acme.com' },
      additional: [],
    });
    expect(ok({ type: 'phones' }, '+972 50 123 4567')).toEqual({
      primary: { number: '+972 50 123 4567' },
      additional: [],
    });
  });

  it('enforces maxValues without truncating', () => {
    expect(
      bad(
        { type: 'emails', settings: { maxValues: 1 } },
        { primary: 'a@x.io', additional: ['b@x.io'] },
      ),
    ).toThrow('at most 1');
  });

  it('parses names and money', () => {
    expect(ok({ type: 'full_name' }, 'Dana Bat Levi')).toEqual({ first: 'Dana', last: 'Bat Levi' });
    expect(ok({ type: 'money' }, { amountMicros: 5_000_000, currency: 'ils' })).toEqual({
      amountMicros: 5_000_000,
      currency: 'ILS',
    });
    expect(bad({ type: 'address' }, { city: 'Tel Aviv', planet: 'Earth' })).toThrow();
  });

  it('refuses writes to the read-only side of a relation', () => {
    expect(
      bad(
        { type: 'relation', settings: { relationCardinality: 'one_to_many' } },
        '0d6b0c38-2f55-4b4e-9d7c-6f3f2b4c1a10',
      ),
    ).toThrow('read-only');
    expect(
      bad({ type: 'relation', settings: { relationCardinality: 'many_to_one' } }, 'abc'),
    ).toThrow('ID of the related record');
  });
});

describe('prepareValues', () => {
  const fields = [
    field({ name: 'name', isNullable: false }),
    field({ name: 'age', type: 'number' }),
    field({ name: 'people', type: 'relation', settings: { relationCardinality: 'one_to_many' } }),
  ];
  const object = {
    name: 'thing',
    activeFields: fields,
    fieldsByName: new Map(fields.map((f) => [f.name, f])),
  } as unknown as CompiledObject;

  it('lists every problem at once, naming the field', () => {
    try {
      prepareValues(object, { age: 'old', colour: 'red' }, 'create');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details?.errors).toEqual([
        { field: 'age', message: 'expected a finite number' },
        { field: 'colour', message: 'unknown field on thing', allowed: ['name', 'age'] },
        { field: 'name', message: 'is required' },
      ]);
    }
  });

  it('allows null to clear a nullable field but not a required one', () => {
    expect(prepareValues(object, { age: null }, 'update').get(fields[1] as FieldState)).toBeNull();
    expect(() => prepareValues(object, { name: null }, 'update')).toThrow(AppError);
  });
});
