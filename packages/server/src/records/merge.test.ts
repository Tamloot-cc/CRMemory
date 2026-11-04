import { describe, expect, it } from 'vitest';
import type { FieldState } from '../schema-engine/types.js';
import { combineMultiValues } from './merge.js';

const field = (overrides: Partial<FieldState>): FieldState => ({
  universalId: 'u',
  key: 'k',
  name: 'emails',
  label: 'Emails',
  description: null,
  type: 'emails',
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  isProtected: false,
  owner: 'system',
  status: 'active',
  ...overrides,
});

describe('combineMultiValues (4.2)', () => {
  const emails = field({ type: 'emails' });

  it("keeps A's primary and puts every other value, deduplicated, in additional", () => {
    expect(
      combineMultiValues(
        emails,
        { primary: 'a@x.test', additional: ['shared@x.test'] },
        { primary: 'b@x.test', additional: ['shared@x.test', 'a@x.test'] },
      ),
    ).toEqual({ primary: 'a@x.test', additional: ['shared@x.test', 'b@x.test'] });
  });

  it("takes B's primary when A has none", () => {
    expect(
      combineMultiValues(
        emails,
        { primary: null, additional: ['a2@x.test'] },
        { primary: 'b@x.test', additional: [] },
      ),
    ).toEqual({ primary: 'b@x.test', additional: ['a2@x.test'] });
  });

  it('returns the one value when the other record has none', () => {
    const value = { primary: 'a@x.test', additional: [] };
    expect(combineMultiValues(emails, value, null)).toBe(value);
    expect(combineMultiValues(emails, null, value)).toBe(value);
  });

  it('deduplicates phones by number and links by URL', () => {
    const phones = field({ type: 'phones', name: 'phones' });
    expect(
      combineMultiValues(
        phones,
        { primary: { number: '+972 54 123 4567' }, additional: [] },
        { primary: { number: '+972-54-123-4567' }, additional: [{ number: '+1 415 555 0101' }] },
      ),
    ).toEqual({
      primary: { number: '+972 54 123 4567' },
      additional: [{ number: '+1 415 555 0101' }],
    });
    const links = field({ type: 'links', name: 'domain' });
    expect(
      combineMultiValues(
        links,
        { primary: { url: 'https://acme.example' }, additional: [] },
        { primary: { url: 'https://ACME.example' }, additional: [] },
      ),
    ).toEqual({ primary: { url: 'https://acme.example' }, additional: [] });
  });

  it('fails rather than truncate past maxValues, naming the field', () => {
    const limited = field({ type: 'emails', settings: { maxValues: 2 } });
    expect(() =>
      combineMultiValues(
        limited,
        { primary: 'a@x.test', additional: ['a2@x.test'] },
        { primary: 'b@x.test', additional: [] },
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'too_many_values',
        details: { field: 'emails', maxValues: 2 },
      }),
    );
  });
});
