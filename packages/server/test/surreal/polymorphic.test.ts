import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { RecordId } from '../../src/db/cbor.js';
import { relationTable } from '../../src/db/names.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  findRecords,
  forget,
  mergeRecord,
  patchRecord,
  readRecord,
  withRead,
} from '../../src/records/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { describeSchema } from '../../src/schema-engine/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';
import { expectDataMatchesAssertions } from '../helpers/records.js';

/**
 * Polymorphic relations (spec 5.1, 5.3): a relation that may point at any of
 * several objects, single-record or a set, validated against all of them.
 */

const backend = useTestBackend();
let other: Backend;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
const schemaChange = (operations: SchemaOperation[]) =>
  runSchemaChange(backend, {
    workspaceId,
    actor: USER,
    scopes: ['schema:write', 'admin'],
    operations,
  });

let n = 0;
const company = () => createRecord(backend, as(AGENT), 'company', { name: `Co ${++n}` });
const person = () => createRecord(backend, as(AGENT), 'person', { emails: `poly${++n}@acme.test` });
const deal = (values: Record<string, unknown>) =>
  createRecord(backend, as(AGENT), 'deal', { name: `Deal ${++n}`, ...values });

beforeAll(async () => {
  other = backend.another();
  workspaceId = (await createWorkspace(backend, { name: 'Acme', template: 'sales' })).id;
  const result = await schemaChange([
    {
      op: 'create_field',
      object: 'deal',
      field: {
        name: 'customer',
        label: 'Customer',
        type: 'relation',
        settings: { targetObjects: ['company', 'person'], onDelete: 'cascade' },
      },
    },
    {
      op: 'create_field',
      object: 'deal',
      field: {
        name: 'stakeholders',
        label: 'Stakeholders',
        type: 'relation',
        settings: { targetObjects: ['company', 'person'], relationCardinality: 'many_to_many' },
      },
    },
  ]);
  expect(result.status).toBe('applied');
});

describe('polymorphic relations', () => {
  it('describes the allowed targets by name, with no inverse', async () => {
    const described = await describeSchema(backend, as(AGENT));
    const customer = described.objects
      .find((o) => o.nameSingular === 'deal')
      ?.fields.find((f) => f.name === 'customer');
    expect(customer?.settings).toMatchObject({ targetObjects: ['company', 'person'] });
    expect(customer?.settings.targetObject).toBeUndefined();
    expect(JSON.stringify(described)).not.toContain('targetObjectIds');
  });

  it('takes a record of any allowed object, and refuses others', async () => {
    const [acme, dana] = [await company(), await person()];
    const forCompany = await deal({ customer: acme.id });
    const forPerson = await deal({ customer: dana.id, stakeholders: [acme.id, dana.id] });
    expect(forCompany.record.fields.customer).toBe(acme.id);
    expect((await readRecord(backend, as(AGENT), forPerson.id)).fields.stakeholders).toEqual(
      [acme.id, dana.id].sort(),
    );
    await expect(deal({ customer: forCompany.id })).rejects.toMatchObject({
      code: 'invalid_values',
      details: {
        errors: [expect.objectContaining({ message: expect.stringMatching(/company or person/) })],
      },
    });
    await expect(deal({ stakeholders: [acme.id, forCompany.id] })).rejects.toMatchObject({
      code: 'invalid_values',
    });
  });

  it('finds the records pointing at one target by filtering on the field', async () => {
    const [acme, dana] = [await company(), await person()];
    const a = await deal({ customer: acme.id });
    const b = await deal({ customer: dana.id, stakeholders: [acme.id] });
    const ids = async (filter: Record<string, unknown>) =>
      (await findRecords(backend, as(AGENT), 'deal', { filter, limit: 200 })).records.map(
        (r) => r.id,
      );
    expect(await ids({ customer: acme.id })).toEqual([a.id]);
    expect(await ids({ customer: { in: [acme.id, dana.id] } })).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
    expect(await ids({ stakeholders: { containsAny: [acme.id] } })).toEqual([b.id]);
  });

  it('applies onDelete per target, and merges and forgets through any target type', async () => {
    const [acme, acmeDup, dana] = [await company(), await company(), await person()];
    const cascaded = await deal({ customer: dana.id });
    await deleteRecord(backend, as(USER), dana.id);
    await expect(readRecord(backend, as(AGENT), cascaded.id)).rejects.toMatchObject({
      code: 'record_deleted',
    });

    const merged = await deal({ customer: acmeDup.id, stakeholders: [acme.id, acmeDup.id] });
    await mergeRecord(backend, as(USER), acme.id, { recordId: acmeDup.id });
    const after = await readRecord(backend, as(AGENT), merged.id);
    expect(after.fields).toMatchObject({ customer: acme.id, stakeholders: [acme.id] });
    await expectDataMatchesAssertions(backend, workspaceId, merged.id);

    const noa = await person();
    const kept = await deal({ stakeholders: [acme.id, noa.id] });
    await forget(backend, as(USER), noa.id);
    expect((await readRecord(backend, as(AGENT), kept.id)).fields.stakeholders).toEqual([acme.id]);
  });

  it('refuses to delete one of the targets while the field exists', async () => {
    await schemaChange([
      {
        op: 'create_object',
        object: {
          nameSingular: 'household',
          namePlural: 'households',
          labelSingular: 'Household',
          labelPlural: 'Households',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text' }],
        },
      },
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'payer',
          label: 'Payer',
          type: 'relation',
          settings: { targetObjects: ['household', 'person'] },
        },
      },
    ]);
    await expect(
      schemaChange([{ op: 'delete_object', object: 'household' }]),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('deal.payer') })],
    });
    await schemaChange([{ op: 'delete_field', object: 'deal', field: 'payer' }]);
    await expect(
      schemaChange([{ op: 'delete_object', object: 'household' }]),
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('keeps one target when writes to a single-record field race', async () => {
    // A single-record polymorphic field still holds one edge under racing writes.
    const targets = [await company(), await person(), await company()];
    const created = await deal({});
    await Promise.all(
      targets.map((t, i) =>
        patchRecord(i % 2 === 0 ? backend : other, as(AGENT), created.id, {
          values: { customer: t.id },
        }),
      ),
    );
    const links = await withRead(backend, as(AGENT), async (db, schema) => {
      const object = schema.objectsByName.get('deal');
      const field = object?.fieldsByName.get('customer');
      return db.rows('SELECT id FROM type::table($table) WHERE in = $source;', {
        table: relationTable(field?.universalId as string),
        source: new RecordId(object?.table as string, created.id),
      });
    });
    expect(links).toHaveLength(1);
  });
});
