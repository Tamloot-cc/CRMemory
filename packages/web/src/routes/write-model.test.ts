import type { FieldView, ObjectView, PresentedRecord, SchemaDescription } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import {
  cascadeImpact,
  creatableFields,
  defaultSurvivor,
  forgetConfirmation,
  groupRecordHits,
  initialDraft,
  mergeRows,
  mergeValues,
  prepareCreateValues,
  serverFieldErrors,
} from './write-model.js';

const field = (name: string, type: FieldView['type'], extra: Partial<FieldView> = {}): FieldView =>
  ({
    name,
    label: name[0]?.toUpperCase() + name.slice(1),
    type,
    description: null,
    settings: {},
    readOnly: false,
    owner: 'system',
    isNullable: true,
    isUnique: false,
    isFilterable: true,
    isSearchable: false,
    ...extra,
  }) as FieldView;

const person: ObjectView = {
  nameSingular: 'person',
  namePlural: 'people',
  labelSingular: 'Person',
  labelPlural: 'People',
  description: null,
  labelField: 'name',
  owner: 'system',
  fields: [
    field('jobTitle', 'text'),
    field('active', 'boolean', { isNullable: false }),
    field('name', 'full_name'),
    field('emails', 'emails'),
    field('company', 'relation', {
      settings: {
        targetObject: 'company',
        inverseField: 'people',
        relationCardinality: 'many_to_one',
        onDelete: 'cascade',
      },
    }),
    field('position', 'number', { readOnly: true }),
    field('raw', 'json'),
    field('lastContact', 'date_time'),
    field('stage', 'select', {
      isNullable: false,
      settings: { options: [{ value: 'lead', label: 'Lead' }] as never },
    }),
  ],
};
const company: ObjectView = {
  ...person,
  nameSingular: 'company',
  namePlural: 'companies',
  labelSingular: 'Company',
  labelPlural: 'Companies',
  fields: [
    field('name', 'text'),
    field('people', 'relation', {
      settings: {
        targetObject: 'person',
        inverseField: 'company',
        relationCardinality: 'one_to_many',
      },
    }),
  ],
};
const schema = { objects: [person, company] } as SchemaDescription;
const record = (fields: Record<string, unknown>, extra: Partial<PresentedRecord> = {}) =>
  ({
    id: 'r1',
    object: 'person',
    label: 'Dana Levi',
    fields,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  }) as PresentedRecord;

describe('creatableFields', () => {
  it('puts the label field first, then required fields, and leaves out what people cannot write', () => {
    expect(creatableFields(person).map((f) => f.name)).toEqual([
      'name',
      'active',
      'stage',
      'jobTitle',
      'emails',
      'company',
      'lastContact',
    ]);
    expect(creatableFields(company).map((f) => f.name)).toEqual(['name']);
  });
});

describe('prepareCreateValues', () => {
  const list = creatableFields(person);
  it('starts required switches off and skips empty optional fields', () => {
    const draft: Record<string, unknown> = {
      ...initialDraft(list),
      stage: 'lead',
      jobTitle: '',
      name: null,
    };
    expect(draft.active).toBe(false);
    expect(prepareCreateValues(list, draft)).toEqual({
      values: { active: false, stage: 'lead' },
      errors: {},
    });
  });
  it('reports empty required fields and invalid values per field', () => {
    const { errors } = prepareCreateValues(list, { ...initialDraft(list), stage: 'won' });
    expect(Object.keys(errors)).toEqual(['stage']);
    expect(prepareCreateValues(list, {}).errors).toMatchObject({
      active: 'is required',
      stage: 'is required',
    });
  });
  it('normalizes values the way the server does', () => {
    const { values } = prepareCreateValues(list, {
      ...initialDraft(list),
      stage: 'lead',
      lastContact: '2026-11-02T09:30:00+02:00',
    });
    expect(values.lastContact).toBe('2026-11-02T07:30:00.000Z');
  });
});

describe('serverFieldErrors', () => {
  it('reads the per-field errors of a 422 and ignores anything else', () => {
    expect(
      serverFieldErrors({
        errors: [{ field: 'stage', message: 'expected one of the options' }, { message: 'x' }],
      }),
    ).toEqual({ stage: 'expected one of the options' });
    expect(serverFieldErrors(undefined)).toEqual({});
  });
});

describe('cascadeImpact', () => {
  it('counts linked records whose relation cascades on delete', () => {
    const acme = record({ name: 'Acme', people: ['p1', 'p2'] }, { object: 'company' });
    expect(cascadeImpact(schema, acme)).toEqual([{ object: 'person', label: 'People', count: 2 }]);
    expect(cascadeImpact(schema, { ...acme, fields: { people: ['p1'] } })).toEqual([
      { object: 'person', label: 'Person', count: 1 },
    ]);
    expect(cascadeImpact(schema, { ...acme, fields: { people: [] } })).toEqual([]);
  });
  it('ignores relations that only clear the link', () => {
    const setNull = {
      objects: [
        {
          ...person,
          fields: person.fields.map((f) =>
            f.name === 'company' ? { ...f, settings: { ...f.settings, onDelete: 'set_null' } } : f,
          ),
        },
        company,
      ],
    } as SchemaDescription;
    expect(cascadeImpact(setNull, record({ people: ['p1'] }, { object: 'company' }))).toEqual([]);
  });
});

describe('forgetConfirmation', () => {
  it('asks for the label, or a fixed word when there is none', () => {
    expect(forgetConfirmation({ label: ' Dana Levi ' })).toBe('Dana Levi');
    expect(forgetConfirmation({ label: null })).toBe('erase');
  });
});

describe('merging', () => {
  const keep = record({
    jobTitle: 'CTO',
    stage: 'lead',
    emails: { primary: 'dana@acme.test', additional: [] },
    company: null,
    raw: { a: 1 },
  });
  const away = record(
    {
      jobTitle: 'CEO',
      stage: 'lead',
      emails: { primary: 'dana@gmail.test', additional: [] },
      company: 'c1',
      raw: { a: 2 },
    },
    { id: 'r2', createdAt: '2025-06-01T00:00:00Z' },
  );
  it('lists only differing fields and offers a choice only when both have a value', () => {
    const rows = mergeRows(person, keep, away);
    expect(rows.map((r) => [r.field.name, r.conflict, r.combined])).toEqual([
      ['jobTitle', true, false],
      ['emails', true, true],
      ['company', false, false],
    ]);
  });
  it('sends only explicit decisions', () => {
    const rows = mergeRows(person, keep, away);
    expect(mergeValues(rows, {})).toBeUndefined();
    expect(mergeValues(rows, { jobTitle: 'merge', emails: 'auto', company: 'keep' })).toEqual({
      jobTitle: 'CEO',
    });
    expect(mergeValues(rows, { emails: 'keep' })).toEqual({
      emails: { primary: 'dana@acme.test', additional: [] },
    });
  });
  it('keeps the older record by default', () => {
    expect(defaultSurvivor(keep, away)).toBe(away);
    expect(defaultSurvivor(away, keep)).toBe(away);
  });
});

describe('groupRecordHits', () => {
  it('groups hits by object in first-seen order with plural labels', () => {
    const hit = (id: string, object: string) => ({ id, object, label: id, match: 'text' as const });
    expect(
      groupRecordHits(
        [hit('a', 'company'), hit('b', 'person'), hit('c', 'company')],
        [person, company],
      ).map((g) => [g.label, g.hits.map((h) => h.id)]),
    ).toEqual([
      ['Companies', ['a', 'c']],
      ['People', ['b']],
    ]);
  });
});
