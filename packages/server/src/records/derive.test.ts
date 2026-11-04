import { describe, expect, it } from 'vitest';
import type { FieldState } from '../schema-engine/types.js';
import {
  canonicalUniqueValue,
  identifiersFor,
  labelOf,
  lookupValue,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  searchTextOf,
} from './derive.js';

const field = (overrides: Partial<FieldState>): FieldState => ({
  universalId: 'u',
  key: 'k',
  name: 'k',
  label: 'K',
  description: null,
  type: 'text',
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  owner: 'system',
  status: 'active',
  ...overrides,
});

describe('normalization (shared by writes and lookups)', () => {
  it('lowercases and trims emails', () => {
    expect(normalizeEmail('  Dana@Acme.COM ')).toBe('dana@acme.com');
  });

  it('formats phones as E.164', () => {
    expect(normalizePhone('050-123-4567', 'IL')).toBe('+972501234567');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
  });

  it('keeps digits when a phone cannot be parsed', () => {
    expect(normalizePhone('12-34')).toBe('1234');
    expect(normalizePhone('+99 12')).toBe('+9912');
  });

  it('reduces links to their host', () => {
    expect(normalizeDomain('https://www.Acme.com/about')).toBe('acme.com');
    expect(normalizeDomain('acme.co.il')).toBe('acme.co.il');
    expect(normalizeDomain('not a url')).toBeNull();
  });

  it('keeps the JSON type of unique values, so 1 and "1" differ', () => {
    expect(canonicalUniqueValue(1)).toBe('1');
    expect(canonicalUniqueValue('1')).toBe('"1"');
    expect(canonicalUniqueValue(' A-17 ')).toBe('"A-17"');
  });
});

describe('identifiersFor', () => {
  it('lists every email once, as claims of a unique field', () => {
    const emails = field({ type: 'emails', isUnique: true });
    expect(
      identifiersFor(emails, { primary: 'Dana@acme.com', additional: ['dana@acme.com', 'd@x.io'] }),
    ).toEqual([
      { kind: 'email', value: 'dana@acme.com' },
      { kind: 'email', value: 'd@x.io' },
    ]);
  });

  it('lists phones and domains, and nothing for null', () => {
    expect(
      identifiersFor(field({ type: 'phones' }), {
        primary: { number: '050-123-4567', countryCode: 'IL' },
        additional: [],
      }),
    ).toEqual([{ kind: 'phone', value: '+972501234567' }]);
    expect(
      identifiersFor(field({ type: 'links' }), {
        primary: { url: 'https://www.acme.com' },
        additional: [],
      }),
    ).toEqual([{ kind: 'domain', value: 'acme.com' }]);
    expect(identifiersFor(field({ type: 'emails' }), null)).toEqual([]);
  });

  it('claims the canonical value of other unique fields only', () => {
    expect(identifiersFor(field({ type: 'number', isUnique: true }), 7)).toEqual([
      { kind: 'value', value: '7' },
    ]);
    expect(identifiersFor(field({ type: 'text' }), 'anything')).toEqual([]);
  });

  it('looks up a match value the way it was stored', () => {
    expect(lookupValue(field({ type: 'emails' }), ' DANA@acme.com')).toBe('dana@acme.com');
    expect(lookupValue(field({ type: 'text', isUnique: true }), 'A-17')).toBe('"A-17"');
  });
});

describe('label and search text', () => {
  it('labels a full name and a select by its option label', () => {
    expect(labelOf(field({ type: 'full_name' }), { first: 'Dana', last: 'Levi' })).toBe(
      'Dana Levi',
    );
    const status = field({
      type: 'select',
      settings: { options: [{ value: 'in_progress', label: 'In progress' }] },
    });
    expect(labelOf(status, 'in_progress')).toBe('In progress');
    expect(labelOf(field({ type: 'text' }), '   ')).toBeNull();
  });

  it('indexes searchable fields apart from the label', () => {
    const name = field({ key: 'name', type: 'full_name', isSearchable: true });
    const title = field({ key: 'jobTitle', isSearchable: true });
    const secret = field({ key: 'notes', isSearchable: false });
    expect(
      searchTextOf([name, title, secret], name, {
        name: { first: 'דנה', last: 'לוי' },
        jobTitle: 'CTO',
        notes: 'private',
      }),
    ).toEqual({ label: 'דנה לוי', body: 'CTO' });
  });

  it('adds the domain of each email and link once, after the field text', () => {
    const name = field({ key: 'name', type: 'full_name', isSearchable: true });
    const emails = field({ key: 'emails', type: 'emails', isSearchable: true });
    const links = field({ key: 'links', type: 'links', isSearchable: true });
    expect(
      searchTextOf([name, emails, links], name, {
        name: { first: 'Dana', last: 'Levi' },
        emails: { primary: 'dana@Acme.com', additional: ['d@acme.com', 'dana@globex.io'] },
        links: {
          primary: { url: 'https://www.acme.com/pricing', label: 'Pricing' },
          additional: [{ url: 'not a url', label: null }],
        },
      }).body,
    ).toBe(
      'dana@Acme.com d@acme.com dana@globex.io Pricing https://www.acme.com/pricing ' +
        'not a url acme.com globex.io',
    );
  });
});
