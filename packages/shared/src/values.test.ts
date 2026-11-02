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
});
