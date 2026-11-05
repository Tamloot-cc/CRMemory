import { describe, expect, it } from 'vitest';
import { validateFieldValue } from './values.js';

const f = (type: Parameters<typeof validateFieldValue>[0]['type'], settings = {}) => ({
  type,
  settings,
  isNullable: true,
});
describe('public field-aware validation', () => {
  it('enforces field settings and nullability, not just composite shape', () => {
    expect(() => validateFieldValue({ ...f('text'), isNullable: false }, null)).toThrow(
      'cannot be null',
    );
    expect(validateFieldValue(f('text'), null)).toBeNull();
    expect(() =>
      validateFieldValue(f('select', { options: [{ value: 'a', label: 'A' }] }), 'b'),
    ).toThrow('options');
    expect(() =>
      validateFieldValue(f('emails', { maxValues: 1 }), {
        primary: 'a@test.com',
        additional: ['b@test.com'],
      }),
    ).toThrow('at most 1');
    expect(() =>
      validateFieldValue(f('links'), { primary: { url: 'javascript://alert(1)' }, additional: [] }),
    ).toThrow();
    expect(() =>
      validateFieldValue(f('phones'), { primary: { number: 'abc' }, additional: [] }),
    ).toThrow('phone number');
    expect(() => validateFieldValue(f('full_name'), { first: '', last: '' })).toThrow('name needs');
    expect(() => validateFieldValue(f('date'), '2025-02-29')).toThrow('real calendar date');
  });

  it('keeps dates within the years Postgres can cast (0001–9999)', () => {
    expect(() => validateFieldValue(f('date'), '0000-01-01')).toThrow('year from 1 to 9999');
    expect(validateFieldValue(f('date'), '0001-01-01')).toBe('0001-01-01');
    expect(validateFieldValue(f('date'), '9999-12-31')).toBe('9999-12-31');
    expect(() => validateFieldValue(f('date_time'), '0000-06-01T00:00:00Z')).toThrow('year');
    expect(() => validateFieldValue(f('date_time'), '+010000-01-01T00:00:00Z')).toThrow('year');
    expect(validateFieldValue(f('date_time'), '9999-12-31T23:59:59Z')).toBe(
      '9999-12-31T23:59:59.000Z',
    );
  });
  it('normalizes the same way as server writes', () => {
    expect(
      validateFieldValue(f('emails'), { primary: 'Dana@ACME.com', additional: ['dana@acme.com'] }),
    ).toEqual({ primary: 'dana@acme.com', additional: [] });
    expect(validateFieldValue(f('money'), { amountMicros: 100, currency: 'usd' })).toEqual({
      amountMicros: 100,
      currency: 'USD',
    });
    expect(validateFieldValue(f('date_time'), '2026-11-02T10:00:00+02:00')).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('takes a set of record IDs for a many_to_many relation', () => {
    const set = f('relation', { relationCardinality: 'many_to_many' });
    const a = 'B0000000-0000-4000-8000-000000000002';
    const b = 'a0000000-0000-4000-8000-000000000001';
    expect(validateFieldValue(set, [a, b, a.toLowerCase()])).toEqual([b, a.toLowerCase()]);
    expect(validateFieldValue(set, [])).toEqual([]);
    expect(() => validateFieldValue(set, null)).toThrow('[] clears it');
    expect(() => validateFieldValue(set, b)).toThrow('array');
    expect(() => validateFieldValue(set, ['nope'])).toThrow('ID');
    expect(() => validateFieldValue({ ...set, isNullable: false }, [])).toThrow('at least one');
    expect(() =>
      validateFieldValue(f('relation', { relationCardinality: 'many_to_many', isInverse: true }), [
        b,
      ]),
    ).toThrow('read-only');
  });
});
