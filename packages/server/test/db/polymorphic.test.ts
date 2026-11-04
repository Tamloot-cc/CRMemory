import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  findRecords,
  forget,
  mergeRecord,
  patchRecord,
  readRecord,
} from '../../src/records/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { describeSchema } from '../../src/schema-engine/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';
import { expectDataMatchesAssertions } from '../helpers/records.js';

/**
 * Polymorphic relations (spec 5.1, 5.3): a relation that may point at any of
 * several objects, single-record or a set, validated against all of them.
 */

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
const schemaChange = (operations: SchemaOperation[]) =>
  inWorkspace(app, workspaceId, (tx) =>
    runSchemaChange(tx, {
      workspaceId,
      actor: USER,
      scopes: ['schema:write', 'admin'],
      operations,
    }),
  );

let n = 0;
const company = () => createRecord(app, as(AGENT), 'company', { name: `Co ${++n}` });
const person = () => createRecord(app, as(AGENT), 'person', { emails: `poly${++n}@acme.test` });
const deal = (values: Record<string, unknown>) =>
  createRecord(app, as(AGENT), 'deal', { name: `Deal ${++n}`, ...values });

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 20 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Acme', template: 'sales' })).id;
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
    const described = await describeSchema(app, as(AGENT));
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
    expect((await readRecord(app, as(AGENT), forPerson.id)).fields.stakeholders).toEqual(
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
      (await findRecords(app, as(AGENT), 'deal', { filter, limit: 200 })).records.map((r) => r.id);
    expect(await ids({ customer: acme.id })).toEqual([a.id]);
    expect(await ids({ customer: { in: [acme.id, dana.id] } })).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
    expect(await ids({ stakeholders: { containsAny: [acme.id] } })).toEqual([b.id]);
  });

  it('applies onDelete per target, and merges and forgets through any target type', async () => {
    const [acme, acmeDup, dana] = [await company(), await company(), await person()];
    const cascaded = await deal({ customer: dana.id });
    await deleteRecord(app, as(USER), dana.id);
    await expect(readRecord(app, as(AGENT), cascaded.id)).rejects.toMatchObject({
      code: 'record_deleted',
    });

    const merged = await deal({ customer: acmeDup.id, stakeholders: [acme.id, acmeDup.id] });
    await mergeRecord(app, as(USER), acme.id, { recordId: acmeDup.id });
    const after = await readRecord(app, as(AGENT), merged.id);
    expect(after.fields).toMatchObject({ customer: acme.id, stakeholders: [acme.id] });
    await expectDataMatchesAssertions(app, workspaceId, merged.id);

    const noa = await person();
    const kept = await deal({ stakeholders: [acme.id, noa.id] });
    await forget(app, as(USER), noa.id);
    expect((await readRecord(app, as(AGENT), kept.id)).fields.stakeholders).toEqual([acme.id]);
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
      targets.map((t) => patchRecord(app, as(AGENT), created.id, { values: { customer: t.id } })),
    );
    const links = await db.owner`
      select 1 from record_links l join fields f on f.id = l.field_id
      where l.source_record_id = ${created.id} and f.name = 'customer'`;
    expect(links).toHaveLength(1);
  });
});
