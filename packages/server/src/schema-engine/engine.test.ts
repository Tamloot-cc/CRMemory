import { describe, expect, it } from 'vitest';
import { BASE_OBJECT_IDS, BASE_OPERATIONS, TEMPLATES } from '../templates/index.js';
import { applyOperations, deriveUuid } from './apply.js';
import { classifyOp, diffSchemas, isDestructive } from './diff.js';
import type { FieldDefinitionInput, SchemaOperation } from './operations.js';
import type { SchemaState } from './types.js';
import { validateSchema } from './validate.js';

const EMPTY: SchemaState = { objects: [] };

/** Applies operations and returns the desired state, failing on any issue. */
function applyValid(
  state: SchemaState,
  operations: SchemaOperation[],
  owner: 'agent' | 'system' = 'agent',
) {
  const { state: desired, issues } = applyOperations(state, operations, { owner });
  expect([...issues, ...validateSchema(desired)]).toEqual([]);
  return desired;
}

/** Reference issues from apply, or else validation issues. */
function issuesOf(state: SchemaState, operations: SchemaOperation[]) {
  const { state: desired, issues } = applyOperations(state, operations, { owner: 'agent' });
  return issues.length > 0 ? issues : validateSchema(desired);
}

const base = applyValid(EMPTY, BASE_OPERATIONS, 'system');

const field = (state: SchemaState, object: string, name: string) =>
  state.objects
    .find((o) => o.nameSingular === object)
    ?.fields.find((f) => f.name === name && f.status === 'active');

describe('base objects', () => {
  it('creates person, company and task with fixed universal IDs', () => {
    expect(base.objects.map((o) => [o.nameSingular, o.universalId])).toEqual([
      ['company', BASE_OBJECT_IDS.company],
      ['person', BASE_OBJECT_IDS.person],
      ['task', BASE_OBJECT_IDS.task],
    ]);
  });

  it('derives the same inverse fields every time', () => {
    const again = applyValid(EMPTY, BASE_OPERATIONS, 'system');
    expect(field(again, 'company', 'people')?.universalId).toBe(
      field(base, 'company', 'people')?.universalId,
    );
    const company = field(base, 'person', 'company');
    expect(field(base, 'company', 'people')).toMatchObject({
      type: 'relation',
      settings: {
        relationCardinality: 'one_to_many',
        targetObjectId: BASE_OBJECT_IDS.person,
        inverseFieldId: company?.universalId,
      },
    });
    expect(company?.settings.inverseFieldId).toBe(deriveUuid(`${company?.universalId}:inverse`));
  });

  it('makes person.emails unique, which is destructive outside the trusted seed path', () => {
    expect(field(base, 'person', 'emails')?.isUnique).toBe(true);
    const ops = diffSchemas(EMPTY, base);
    const emails = ops.find((op) => op.kind === 'create_field' && op.field.name === 'emails');
    expect(emails && classifyOp(emails)).toBe('destructive');
  });
});

describe('templates', () => {
  for (const template of Object.values(TEMPLATES)) {
    it(`${template.name} applies to the base objects with additive operations only`, () => {
      const desired = applyValid(base, template.operations, 'system');
      const ops = diffSchemas(base, desired);
      expect(ops.filter((op) => classifyOp(op) !== 'additive')).toEqual([]);
      expect(ops.length > 0).toBe(template.name !== 'blank');
    });
  }

  it('can all be applied to one workspace', () => {
    const all = Object.values(TEMPLATES).flatMap((t) => t.operations);
    const desired = applyValid(base, all, 'system');
    expect(desired.objects.map((o) => o.nameSingular)).toEqual([
      'company',
      'person',
      'task',
      'deal',
      'project',
      'proposal',
      'appointment',
      'property',
      'viewing',
      'job',
      'application',
    ]);
  });

  it('uses universal IDs no other template or base object uses', () => {
    const all = Object.values(TEMPLATES).flatMap((t) => t.operations);
    const desired = applyValid(base, all, 'system');
    const ids = desired.objects.flatMap((o) => [
      o.universalId,
      ...o.fields.map((f) => f.universalId),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('adds clinic fields to person', () => {
    const desired = applyValid(base, TEMPLATES.clinic.operations, 'system');
    expect(field(desired, 'person', 'dateOfBirth')?.type).toBe('date');
    expect(field(desired, 'person', 'appointments')?.settings.relationCardinality).toBe(
      'one_to_many',
    );
  });

  it('reports every collision with existing custom names', () => {
    const custom = applyValid(base, [
      {
        op: 'create_object',
        object: {
          nameSingular: 'deal',
          namePlural: 'deals',
          labelSingular: 'Deal',
          labelPlural: 'Deals',
          labelField: 'title',
          fields: [{ name: 'title', label: 'Title', type: 'text' }],
        },
      },
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'industry', label: 'I', type: 'text' },
      },
    ]);
    const issues = issuesOf(custom, TEMPLATES.sales.operations);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['deal', 'company.industry']));
  });
});

describe('apply', () => {
  it('assigns a key equal to the name and never reuses keys', () => {
    const withNotes = applyValid(base, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'notes', label: 'Notes', type: 'text' },
      },
    ]);
    expect(field(withNotes, 'person', 'notes')?.key).toBe('notes');
    const deleted = applyValid(withNotes, [
      { op: 'delete_field', object: 'person', field: 'notes' },
    ]);
    const recreated = applyValid(deleted, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'notes', label: 'Notes', type: 'text' },
      },
    ]);
    expect(field(recreated, 'person', 'notes')?.key).toBe('notes_2');
  });

  it('keeps the key when a field is renamed', () => {
    const renamed = applyValid(base, [
      { op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' },
    ]);
    expect(field(renamed, 'person', 'role')?.key).toBe('jobTitle');
  });

  it('refuses type changes and names what to do instead', () => {
    expect(
      issuesOf(base, [{ op: 'update_field', object: 'person', field: 'jobTitle', type: 'number' }]),
    ).toEqual([
      {
        path: 'person.jobTitle',
        message: 'changing a field type is not supported; create a new field and delete this one',
      },
    ]);
  });

  it('lists the known objects for an unknown reference', () => {
    const [issue] = issuesOf(base, [{ op: 'delete_object', object: 'dela' }]);
    expect(issue?.message).toContain('objects: company, person, task');
  });

  it('protects base objects and label fields', () => {
    expect(issuesOf(base, [{ op: 'delete_object', object: 'person' }])[0]?.message).toContain(
      'base objects',
    );
    expect(
      issuesOf(base, [{ op: 'delete_field', object: 'person', field: 'name' }])[0]?.message,
    ).toContain('label field');
  });

  it('deprecates both sides of a relation together', () => {
    const desired = applyValid(base, [{ op: 'delete_field', object: 'task', field: 'company' }]);
    expect(field(desired, 'task', 'company')).toBeUndefined();
    expect(field(desired, 'company', 'tasks')).toBeUndefined();
  });

  it('deletes relations pointing at a deleted object', () => {
    const withDeal = applyValid(base, TEMPLATES.sales.operations);
    const desired = applyValid(withDeal, [{ op: 'delete_object', object: 'deal' }]);
    expect(field(desired, 'company', 'deals')).toBeUndefined();
    expect(field(desired, 'person', 'deals')).toBeUndefined();
    const ops = diffSchemas(withDeal, desired);
    expect(ops.map((op) => op.kind).sort()).toEqual([
      'deprecate_field',
      'deprecate_field',
      'deprecate_object',
    ]);
  });
});

describe('validate', () => {
  const create = (overrides: Partial<FieldDefinitionInput>) =>
    issuesOf(base, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'x', label: 'X', type: 'text', ...overrides },
      },
    ]);

  const createObject = (nameSingular: string, namePlural: string) =>
    issuesOf(base, [
      {
        op: 'create_object',
        object: {
          nameSingular,
          namePlural,
          labelSingular: 'X',
          labelPlural: 'Xs',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text' }],
        },
      },
    ]).map((i) => i.message);

  it('rejects reserved and badly formed names', () => {
    expect(create({ name: 'createdAt' })[0]?.message).toContain('reserved');
    expect(create({ name: 'Foo bar' })[0]?.message).toContain('camelCase');
    expect(createObject('record', 'records')).toEqual([
      '"record" is reserved: it names a built-in API resource',
      '"records" is reserved: it names a built-in API resource',
    ]);
  });

  it.each([
    ['interaction', 'interactions', 'log_interaction'],
    ['fact', 'facts', 'remember'],
  ])('points an object named %s at the built-in feature', (singular, plural, tool) => {
    for (const message of createObject(singular, plural)) expect(message).toContain(tool);
  });

  it('rejects duplicate field names', () => {
    expect(create({ name: 'jobTitle' })[0]?.message).toContain('already used');
  });

  it('rejects unique phones and other unsupported unique types', () => {
    expect(create({ type: 'phones', isUnique: true })[0]?.message).toContain(
      'shared and reassigned',
    );
    expect(create({ type: 'address', isUnique: true })[0]?.message).toContain('cannot be unique');
  });

  it('requires options on select fields and unique option values', () => {
    expect(create({ type: 'select' })[0]?.message).toContain('at least one option');
    expect(
      create({
        type: 'select',
        settings: {
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'A2' },
          ],
        },
      })[0]?.message,
    ).toContain('listed twice');
  });

  it('requires a relation target', () => {
    expect(create({ type: 'relation' })[0]?.message).toContain('targetObject');
    expect(create({ type: 'relation', settings: { targetObject: 'nope' } })[0]?.message).toContain(
      'unknown object',
    );
  });

  it('rejects object names that collide across singular and plural', () => {
    const issues = issuesOf(base, [
      {
        op: 'create_object',
        object: {
          nameSingular: 'people',
          namePlural: 'peoples',
          labelSingular: 'P',
          labelPlural: 'Ps',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text' }],
        },
      },
    ]);
    expect(issues[0]?.message).toContain('already used by person');
  });
});

describe('diff and classify', () => {
  const diff = (operations: SchemaOperation[]) => diffSchemas(base, applyValid(base, operations));

  it('treats new objects, optional fields, options and labels as additive', () => {
    const ops = diff([
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'nickname', label: 'Nickname', type: 'text' },
      },
      {
        op: 'add_option',
        object: 'task',
        field: 'status',
        option: { value: 'blocked', label: 'Blocked' },
      },
      {
        op: 'update_field',
        object: 'person',
        field: 'jobTitle',
        label: 'Role',
        isSearchable: false,
      },
      { op: 'update_object', object: 'task', description: 'Work items' },
    ]);
    // Operations follow object order: person, then task.
    expect(ops.map((op) => [op.kind, classifyOp(op)])).toEqual([
      ['update_field', 'additive'],
      ['update_field', 'destructive'], // un-marking searchable is not listed as additive
      ['create_field', 'additive'],
      ['update_object', 'additive'],
      ['add_option', 'additive'],
    ]);
  });

  it('treats renames, deletions, removed options, required and unique as destructive', () => {
    const cases: SchemaOperation[][] = [
      [{ op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' }],
      [{ op: 'rename_object', object: 'task', nameSingular: 'todo', namePlural: 'todos' }],
      [{ op: 'delete_field', object: 'person', field: 'jobTitle' }],
      [{ op: 'remove_option', object: 'task', field: 'status', value: 'done' }],
      [{ op: 'update_field', object: 'person', field: 'jobTitle', isNullable: false }],
      [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'ssn', label: 'SSN', type: 'text', isUnique: true },
        },
      ],
      [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'tier', label: 'Tier', type: 'text', isNullable: false },
        },
      ],
    ];
    for (const operations of cases) {
      expect(isDestructive(diff(operations)), JSON.stringify(operations)).toBe(true);
    }
  });

  it('reports a rename as a rename, matched by universal ID', () => {
    expect(
      diff([{ op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' }]),
    ).toEqual([expect.objectContaining({ kind: 'rename_field', from: 'jobTitle', to: 'role' })]);
  });

  it('produces no operations when nothing changes', () => {
    expect(
      diff([{ op: 'update_field', object: 'person', field: 'jobTitle', label: 'Job title' }]),
    ).toEqual([]);
  });
});
