import type { FieldView, ObjectView } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import {
  cardinality,
  describeOperation,
  matchesField,
  parseStatus,
  relationEdges,
  relativeTime,
  typeDetail,
} from './schema-model.js';
import { sortObjects } from './state.js';

const field = (over: Partial<FieldView> & Pick<FieldView, 'name' | 'type'>): FieldView => ({
  label: over.name,
  description: null,
  settings: {},
  readOnly: false,
  owner: 'system',
  isNullable: true,
  isUnique: false,
  isFilterable: false,
  isSearchable: false,
  ...over,
});
const object = (over: Partial<ObjectView> & Pick<ObjectView, 'nameSingular'>): ObjectView => ({
  namePlural: `${over.nameSingular}s`,
  labelSingular: over.nameSingular,
  labelPlural: `${over.nameSingular}s`,
  description: null,
  labelField: 'name',
  owner: 'system',
  fields: [],
  ...over,
});
const person = object({
  nameSingular: 'person',
  namePlural: 'people',
  labelSingular: 'Person',
  labelPlural: 'People',
  fields: [
    field({ name: 'name', label: 'Name', type: 'text' }),
    field({
      name: 'relationship',
      label: 'Relationship',
      type: 'select',
      settings: { options: [{ value: 'advisor', label: 'Advisor' }] },
    }),
    field({
      name: 'company',
      label: 'Company',
      type: 'relation',
      settings: {
        targetObject: 'company',
        inverseField: 'people',
        relationCardinality: 'many_to_one',
      },
    }),
  ],
});
const company = object({
  nameSingular: 'company',
  namePlural: 'companies',
  labelSingular: 'Company',
  labelPlural: 'Companies',
  fields: [
    field({
      name: 'people',
      label: 'People',
      type: 'relation',
      readOnly: true,
      settings: {
        targetObject: 'person',
        inverseField: 'company',
        relationCardinality: 'one_to_many',
      },
    }),
  ],
});
const deal = object({ nameSingular: 'deal', owner: 'agent' });
const objects = [deal, person, company];

describe('schema page model', () => {
  it('puts system objects first and keeps schema order otherwise', () => {
    expect(sortObjects(objects).map((o) => o.nameSingular)).toEqual(['person', 'company', 'deal']);
  });

  it('draws each relation once, from its many side to its one side', () => {
    expect(relationEdges(objects)).toEqual([
      {
        id: 'person.company',
        from: { node: 'person', row: 'company' },
        to: { node: 'company', row: 'people' },
        description: 'Company: Each person has one company. Each company has many people.',
      },
    ]);
  });

  it('keeps a one-to-many field without its other side, and drops missing targets', () => {
    const lonely = object({
      nameSingular: 'company',
      labelSingular: 'Company',
      labelPlural: 'Companies',
      fields: [
        field({
          name: 'staff',
          label: 'Staff',
          type: 'relation',
          settings: { targetObject: 'person', relationCardinality: 'one_to_many' },
        }),
        field({ name: 'ghost', label: 'Ghost', type: 'relation', settings: { targetObject: 'x' } }),
      ],
    });
    const edges = relationEdges([
      object({ nameSingular: 'person', labelSingular: 'Person' }),
      lonely,
    ]);
    expect(edges.map((e) => [e.from, e.to])).toEqual([
      [
        { node: 'person', row: undefined },
        { node: 'company', row: 'staff' },
      ],
    ]);
  });

  it('words cardinality the same way everywhere', () => {
    expect(cardinality(person, company, false)).toBe('Each person has one company');
    expect(cardinality(company, person, true)).toBe('Each company has many people');
    expect(cardinality(person, null, true)).toBe('Each person has many records');
  });

  it('describes what settings add to a type', () => {
    const [name, relationship, toCompany] = person.fields as [FieldView, FieldView, FieldView];
    expect(typeDetail(name, objects)).toBeNull();
    expect(typeDetail(relationship, objects)).toBe('1 option');
    expect(typeDetail(toCompany, objects)).toBe('One Company');
    expect(typeDetail(company.fields[0] as FieldView, objects)).toBe('Many People');
    expect(typeDetail(field({ name: 'e', type: 'emails', settings: { maxValues: 5 } }), [])).toBe(
      'Up to 5',
    );
  });

  it('filters fields by label, API name or type', () => {
    const f = person.fields[1] as FieldView;
    expect(matchesField(f, '')).toBe(true);
    expect(matchesField(f, 'RELATION')).toBe(true);
    expect(matchesField(f, 'single sel')).toBe(true);
    expect(matchesField(f, 'money')).toBe(false);
  });

  it('accepts only known change statuses', () => {
    expect(parseStatus('applied')).toBe('applied');
    expect(parseStatus('bogus')).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    expect(relativeTime('2026-11-03T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-11-03T09:00:00Z', now)).toMatch(/3 hours ago/);
  });

  it('describes every operation in words, with labels from the schema', () => {
    const d = (op: Parameters<typeof describeOperation>[0]) => describeOperation(op, objects);
    expect(
      d({
        op: 'add_option',
        object: 'person',
        field: 'relationship',
        option: { value: 'collaborator', label: 'Collaborator' },
      }),
    ).toBe('Add option “Collaborator” to Person → Relationship');
    expect(
      d({ op: 'update_field', object: 'person', field: 'name', isUnique: true, isNullable: false }),
    ).toBe('Change Person → Name: required, unique');
    expect(
      d({
        op: 'create_field',
        object: 'company',
        field: { name: 'arr', label: 'ARR', type: 'money' },
      }),
    ).toBe('Add field ARR (Money) to Company');
    expect(
      d({
        op: 'create_object',
        object: {
          nameSingular: 'touchpoint',
          namePlural: 'touchpoints',
          labelSingular: 'Touchpoint',
          labelPlural: 'Touchpoints',
          labelField: 'title',
          fields: [{ name: 'title', label: 'Title', type: 'text' }],
        },
      }),
    ).toBe('Add object Touchpoint with 1 field');
    expect(d({ op: 'update_object', object: 'person', description: null })).toBe(
      'Change Person: clear description',
    );
    expect(d({ op: 'rename_field', object: 'person', field: 'name', name: 'fullName' })).toBe(
      'Rename Person → Name to fullName',
    );
    expect(d({ op: 'delete_field', object: 'ghost', field: 'gone' })).toBe(
      'Delete field ghost → gone',
    );
    expect(d({ op: 'remove_option', object: 'person', field: 'relationship', value: 'x' })).toBe(
      'Remove option x from Person → Relationship',
    );
    expect(
      describeOperation({ op: 'future_thing' } as unknown as Parameters<typeof d>[0], objects),
    ).toBe('future thing');
  });
});
