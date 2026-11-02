import { FIELD_TYPES, type FieldView, validateFieldValue } from '@retainer/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { decimalToMicros, FieldDisplay, FieldInput, microsToDecimal } from './common.js';
import { fields } from './index.js';

const f = (type: FieldView['type']): FieldView => ({
  type,
  name: 'value',
  label: 'Value',
  description: null,
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'system',
});
describe('field registry and numeric precision', () => {
  it('covers every field type', () => {
    expect(Object.keys(fields).sort()).toEqual([...FIELD_TYPES].sort());
  });
  it('converts decimal amounts exactly and rejects unsafe values', () => {
    expect(decimalToMicros('0.000001')).toBe(1);
    expect(decimalToMicros('123.456789')).toBe(123456789);
    expect(decimalToMicros('-0.3')).toBe(-300000);
    expect(microsToDecimal(123456789)).toBe('123.456789');
    expect(microsToDecimal(0)).toBe('0');
    expect(() => decimalToMicros('0.0000001')).toThrow();
    expect(() => decimalToMicros('999999999999999999')).toThrow();
  });
  it('round-trips representative values for every type through public validation', () => {
    const values: Record<FieldView['type'], unknown> = {
      text: 'Hello',
      number: 12.5,
      boolean: false,
      date: '2026-11-02',
      date_time: '2026-11-02T12:00:00Z',
      select: 'a',
      multi_select: ['a'],
      money: { amountMicros: 1234567, currency: 'USD' },
      emails: { primary: 'a@test.com', additional: [] },
      phones: { primary: { number: '+972501234567', countryCode: 'IL' }, additional: [] },
      links: { primary: { url: 'https://example.com', label: 'Site' }, additional: [] },
      full_name: { first: 'Dana', last: 'Levi' },
      address: { city: 'Tel Aviv' },
      relation: '10000000-0000-4000-8000-000000000001',
      json: { a: 1 },
    };
    for (const type of FIELD_TYPES) {
      const field = {
        ...f(type),
        settings: {
          options: [{ value: 'a', label: 'A' }],
          relationCardinality: 'many_to_one' as const,
        },
      };
      const value = validateFieldValue(field, values[type]);
      expect(validateFieldValue(field, value)).toEqual(value);
      render(<FieldDisplay field={field} value={value} />);
    }
  });
  it('shows empty and false values distinctly', () => {
    render(<FieldDisplay field={f('boolean')} value={false} />);
    expect(screen.getByRole('img', { name: 'No' })).toBeTruthy();
  });
});
function EmailEditor() {
  const [v, setV] = useState<unknown>({ primary: 'a@test.com', additional: [] });
  return (
    <FieldInput field={{ ...f('emails'), settings: { maxValues: 2 } }} value={v} onChange={setV} />
  );
}
it('edits composite lists as whole values, promotes primary and enforces the cap', async () => {
  const user = userEvent.setup();
  render(<EmailEditor />);
  await user.click(screen.getByRole('button', { name: 'Add email' }));
  await user.type(screen.getByRole('textbox', { name: 'Email 2' }), 'b@test.com');
  expect((screen.getByRole('button', { name: 'Add email' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole('button', { name: 'Set primary' }));
  expect((screen.getByRole('textbox', { name: 'Email 1' }) as HTMLInputElement).value).toBe(
    'b@test.com',
  );
});

it('treats empty composites as empty without hiding zero or false', () => {
  expect(fields.emails.isEmpty({ primary: null, additional: [] })).toBe(true);
  expect(fields.full_name.isEmpty({ first: '', last: '' })).toBe(true);
  expect(fields.address.isEmpty({})).toBe(true);
  expect(fields.number.isEmpty(0)).toBe(false);
  expect(fields.boolean.isEmpty(false)).toBe(false);
  expect(fields.json.isEmpty({})).toBe(false);
});
