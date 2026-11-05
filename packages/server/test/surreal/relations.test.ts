import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { RecordId } from '../../src/db/cbor.js';
import { publicId, relationTable } from '../../src/db/names.js';
import { logEventFor } from '../../src/memory/service.js';
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
import type { CompiledSchema } from '../../src/schema-engine/compiled.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { describeSchema } from '../../src/schema-engine/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';
import { expectDataMatchesAssertions } from '../helpers/records.js';

/**
 * Native multi-record relations (spec 5): many_to_many fields hold a set of
 * records, written whole as one assertion, with one derived edge per member
 * and a read-only inverse on the other side.
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

const schemaOf = (): Promise<CompiledSchema> =>
  withRead(backend, as(AGENT), async (_db, schema) => schema);
const fieldOf = async (object: string, name: string) => {
  const compiled = (await schemaOf()).objectsByName.get(object);
  const field = compiled?.fieldsByName.get(name);
  if (!compiled || !field) throw new Error(`no ${object}.${name}`);
  return { object: compiled, field };
};
const runtime = () => backend.workspace(workspaceId);
const admin = async () => backend.adminDb((await backend.route(workspaceId)).database);

let n = 0;
const person = () => createRecord(backend, as(AGENT), 'person', { emails: `rel${++n}@acme.test` });
const deal = (values: Record<string, unknown> = {}, actor = AGENT) =>
  createRecord(backend, as(actor), 'deal', { name: `Deal ${++n}`, ...values });
const contactsOf = async (id: string) =>
  (await readRecord(backend, as(AGENT), id)).fields.contacts as string[];
/** A record's edges in a relation field's table, by target. */
const edgesOf = async (object: string, name: string, id: string) => {
  const { object: owner, field } = await fieldOf(object, name);
  const rows = await (await runtime()).rows<{ out: RecordId }>(
    'SELECT out FROM type::table($table) WHERE in = $source;',
    { table: relationTable(field.universalId), source: new RecordId(owner.table, id) },
  );
  return rows
    .map((r) => ({ target_record_id: publicId(r.out) }))
    .sort((a, b) => a.target_record_id.localeCompare(b.target_record_id));
};
const edges = (id: string) => edgesOf('deal', 'contacts', id);
/** Every assertion of one field of a record, oldest first. */
const assertionValues = async (id: string, object: string, name: string) => {
  const { field } = await fieldOf(object, name);
  const rows = await (await runtime()).rows<{ created_at: Date; value: string[] }>(
    'SELECT created_at, value FROM field_assertions WHERE record = $id AND field_id = $field ORDER BY created_at;',
    { id, field: field.id },
  );
  return rows.map((r) => ({ value: r.value }));
};

beforeAll(async () => {
  other = backend.another();
  workspaceId = (await createWorkspace(backend, { name: 'Acme', template: 'sales' })).id;
  const result = await schemaChange([
    {
      op: 'create_field',
      object: 'deal',
      field: {
        name: 'contacts',
        label: 'Contacts',
        type: 'relation',
        settings: {
          targetObject: 'person',
          relationCardinality: 'many_to_many',
          inverseField: 'contactDeals',
        },
      },
    },
  ]);
  expect(result.status).toBe('applied');
});

describe('schema', () => {
  it('describes the owning side and its read-only inverse', async () => {
    const described = await describeSchema(backend, as(AGENT));
    const fieldOf = (object: string, name: string) =>
      described.objects.find((o) => o.nameSingular === object)?.fields.find((f) => f.name === name);
    expect(fieldOf('deal', 'contacts')).toMatchObject({
      readOnly: false,
      settings: { relationCardinality: 'many_to_many', targetObject: 'person' },
    });
    expect(fieldOf('person', 'contactDeals')).toMatchObject({
      readOnly: true,
      settings: { relationCardinality: 'many_to_many', isInverse: true, targetObject: 'deal' },
    });
    // Existing inverses are marked too.
    expect(fieldOf('company', 'people')?.settings).toMatchObject({
      relationCardinality: 'one_to_many',
      isInverse: true,
    });
  });

  it('refuses onDelete: cascade on a many_to_many field', async () => {
    await expect(
      schemaChange([
        {
          op: 'create_field',
          object: 'deal',
          field: {
            name: 'watchers',
            label: 'Watchers',
            type: 'relation',
            settings: {
              targetObject: 'person',
              relationCardinality: 'many_to_many',
              onDelete: 'cascade',
            },
          },
        },
      ]),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'deal.watchers' })] });
  });
});

describe('values', () => {
  it('normalizes a set, replaces it whole and clears it with []', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    const created = await deal({ contacts: [b.id, a.id, b.id] });
    const sorted = [a.id, b.id].sort();
    expect(created.record.fields.contacts).toEqual(sorted);
    expect((await edges(created.id)).map((e) => e.target_record_id)).toEqual(sorted);
    // `is_collection` is the set field's edge table: it has no single-source unique index.
    const { field } = await fieldOf('deal', 'contacts');
    const table = relationTable(field.universalId);
    const [info] = (await (await admin()).query(`INFO FOR TABLE ${table};`)) as [
      { indexes: Record<string, string> },
    ];
    expect(Object.keys(info.indexes)).not.toContain(`${table}_source_uq`);

    await patchRecord(backend, as(AGENT), created.id, { values: { contacts: [c.id] } });
    expect(await contactsOf(created.id)).toEqual([c.id]);
    await patchRecord(backend, as(AGENT), created.id, { values: { contacts: [] } });
    expect(await contactsOf(created.id)).toEqual([]);
    expect(await edges(created.id)).toEqual([]);
    await expectDataMatchesAssertions(backend, workspaceId, created.id);

    // One assertion per write, holding the whole set.
    expect(await assertionValues(created.id, 'deal', 'contacts')).toHaveLength(3);
  });

  it('rejects null, and rolls back the whole write for one invalid member', async () => {
    const a = await person();
    const created = await deal({ contacts: [a.id] });
    await expect(
      patchRecord(backend, as(AGENT), created.id, { values: { contacts: null } }),
    ).rejects.toMatchObject({ code: 'invalid_values' });

    const company = await createRecord(backend, as(AGENT), 'company', { name: 'Not a person' });
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(
      patchRecord(backend, as(AGENT), created.id, {
        values: { contacts: [a.id, company.id, missing], name: 'Renamed' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_values',
      details: {
        errors: expect.arrayContaining([
          expect.objectContaining({
            field: 'contacts',
            message: expect.stringContaining('not a person'),
          }),
          expect.objectContaining({
            field: 'contacts',
            message: expect.stringContaining('no live record'),
          }),
        ]),
      },
    });
    const after = await readRecord(backend, as(AGENT), created.id);
    expect(after.fields.contacts).toEqual([a.id]);
    expect(after.label).not.toBe('Renamed');
  });

  it('refuses writes to the inverse side', async () => {
    const a = await person();
    const created = await deal();
    await expect(
      patchRecord(backend, as(AGENT), a.id, { values: { contactDeals: [created.id] } }),
    ).rejects.toMatchObject({ code: 'invalid_values' });
  });

  it('reads the inverse from the owning side, and drops deleted members', async () => {
    const [a, b] = [await person(), await person()];
    const first = await deal({ contacts: [a.id, b.id] });
    const second = await deal({ contacts: [a.id] });
    expect((await readRecord(backend, as(AGENT), a.id)).fields.contactDeals).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    await deleteRecord(backend, as(USER), b.id);
    expect(await contactsOf(first.id)).toEqual([a.id]);
  });

  it('keeps a pending set from changing the edges', async () => {
    const [a, b] = [await person(), await person()];
    const created = await deal({ contacts: [a.id] }, USER);
    const write = await patchRecord(backend, as(AGENT), created.id, {
      values: { contacts: [b.id] },
    });
    expect(write.fields).toEqual({ contacts: 'pending_review' });
    expect((await edges(created.id)).map((e) => e.target_record_id)).toEqual([a.id]);
  });

  it('recomputes the set when its source event is deleted', async () => {
    const [a, b] = [await person(), await person()];
    const log = (externalId: string, occurredAt: string) =>
      logEventFor(backend, as(AGENT), {
        type: 'call',
        channel: 'zoom',
        externalId,
        occurredAt,
        fields: {},
        participants: [],
        about: [],
      });
    const early = await log(`set-${++n}`, '2026-10-01T10:00:00Z');
    const late = await log(`set-${++n}`, '2026-10-02T10:00:00Z');
    const created = await createRecord(
      backend,
      as(AGENT),
      'deal',
      { name: 'Sourced', contacts: [a.id] },
      { source: early.id },
    );
    await patchRecord(backend, as(AGENT), created.id, {
      values: { contacts: [a.id, b.id] },
      source: late.id,
    });
    expect(await contactsOf(created.id)).toEqual([a.id, b.id].sort());
    await deleteRecord(backend, as(USER), late.id);
    expect(await contactsOf(created.id)).toEqual([a.id]);
    expect((await edges(created.id)).map((e) => e.target_record_id)).toEqual([a.id]);
  });
});

describe('the database guarantee', () => {
  it('holds a single-record field to one target, whatever a writer claims', async () => {
    const acme = await createRecord(backend, as(AGENT), 'company', { name: 'Acme' });
    const globex = await createRecord(backend, as(AGENT), 'company', { name: 'Globex' });
    const dana = await createRecord(backend, as(AGENT), 'person', {
      emails: `single${++n}@acme.test`,
      company: acme.id,
    });
    const { object: personObject, field } = await fieldOf('person', 'company');
    const { object: companyObject } = await fieldOf('company', 'name');
    const table = relationTable(field.universalId);
    const vars = {
      from: new RecordId(personObject.table, dana.id),
      to: new RecordId(companyObject.table, globex.id),
      actor: AGENT,
      now: new Date(),
    };
    // A second edge is refused by the unique source index, from either session
    // (the Postgres `is_collection` flag has no counterpart: a set field has its own table).
    for (const db of [await admin(), await runtime()]) {
      await expect(
        db.query(
          `RELATE $from->${table}->$to CONTENT { created_by: $actor, created_at: $now } RETURN id;`,
          vars,
        ),
      ).rejects.toThrow(/_source_uq/);
    }
    // The schemafull edge table refuses an undeclared flag rather than storing it.
    await expect(
      (await admin()).query(`UPDATE ${table} SET is_collection = true WHERE in = $from;`, vars),
    ).rejects.toThrow(/no such field/);
    expect(await edgesOf('person', 'company', dana.id)).toEqual([{ target_record_id: acme.id }]);
  });

  // The check constraint is replaced by the physical model: inverse and
  // non-relation fields have no edge table, and in a STRICT database a
  // runtime session cannot create one by writing to it (spec sections 4, 5, 13).
  it('refuses edges on an inverse or non-relation field', async () => {
    const a = await person();
    const created = await deal();
    const { object: personObject } = await fieldOf('person', 'name');
    const { object: dealObject } = await fieldOf('deal', 'name');
    const [info] = (await (await admin()).query('INFO FOR DB;')) as [
      { tables: Record<string, string> },
    ];
    for (const [object, name] of [
      ['person', 'contactDeals'],
      ['deal', 'name'],
    ] as const) {
      const { field } = await fieldOf(object, name);
      const table = relationTable(field.universalId);
      expect(Object.keys(info.tables)).not.toContain(table);
      const db = await runtime();
      await expect(
        db.query(
          `RELATE $from->${table}->$to CONTENT { created_by: $actor, created_at: $now } RETURN id;`,
          {
            from: new RecordId(personObject.table, a.id),
            to: new RecordId(dealObject.table, created.id),
            actor: AGENT,
            now: new Date(),
          },
        ),
      ).rejects.toThrow(/does not exist/);
    }
    // The database is STRICT, so the refused writes defined nothing.
    const [after] = (await (await admin()).query('INFO FOR DB;')) as [
      { tables: Record<string, string> },
    ];
    expect(Object.keys(after.tables).sort()).toEqual(Object.keys(info.tables).sort());
  });

  it('keeps one target when single-record writes race', async () => {
    const companies = await Promise.all(
      [1, 2, 3, 4].map((i) => createRecord(backend, as(AGENT), 'company', { name: `Race ${i}` })),
    );
    const dana = await person();
    await Promise.all(
      companies.map((c, i) =>
        patchRecord(i % 2 === 0 ? backend : other, as(AGENT), dana.id, {
          values: { company: c.id },
        }),
      ),
    );
    expect(await edgesOf('person', 'company', dana.id)).toHaveLength(1);
    await expectDataMatchesAssertions(backend, workspaceId, dana.id);
  });
});

describe('queries', () => {
  it('filters with containsAny, containsAll and isEmpty', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    const ab = await deal({ contacts: [a.id, b.id] });
    const bc = await deal({ contacts: [b.id, c.id] });
    const none = await deal({ contacts: [] });
    const ids = async (filter: Record<string, unknown>) =>
      (await findRecords(backend, as(AGENT), 'deal', { filter, limit: 200 })).records
        .map((r) => r.id)
        .filter((id) => [ab.id, bc.id, none.id].includes(id))
        .sort();
    expect(await ids({ contacts: { containsAny: [a.id, c.id] } })).toEqual([ab.id, bc.id].sort());
    expect(await ids({ contacts: { containsAll: [b.id, c.id] } })).toEqual([bc.id]);
    expect(await ids({ contacts: { containsAll: [b.id, b.id] } })).toEqual([ab.id, bc.id].sort());
    expect(await ids({ contacts: { isEmpty: true } })).toEqual([none.id]);
    expect(await ids({ contacts: { isEmpty: false } })).toEqual([ab.id, bc.id].sort());
  });

  it('rejects comparisons, equality and sorting on a set', async () => {
    const a = await person();
    for (const filter of [
      { contacts: { gt: a.id } },
      { contacts: a.id },
      { contacts: { in: [a.id] } },
    ]) {
      await expect(
        findRecords(backend, as(AGENT), 'deal', { filter, limit: 10 }),
      ).rejects.toMatchObject({ code: 'invalid_filter' });
    }
    await expect(
      findRecords(backend, as(AGENT), 'deal', {
        sort: [{ field: 'contacts', direction: 'asc' }],
        limit: 10,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('merge and erasure', () => {
  it('points sets at the survivor once, in history too', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    const both = await deal({ contacts: [a.id, b.id, c.id] });
    const onlyB = await deal({ contacts: [b.id] });
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    expect(await contactsOf(both.id)).toEqual([a.id, c.id].sort());
    expect(await contactsOf(onlyB.id)).toEqual([a.id]);
    const values = await assertionValues(both.id, 'deal', 'contacts');
    expect(values.every((v) => !v.value.includes(b.id))).toBe(true);
    await expectDataMatchesAssertions(backend, workspaceId, both.id);
  });

  it('removes a forgotten record from every set assertion, so it cannot come back', async () => {
    const [a, b] = [await person(), await person()];
    const created = await deal({ contacts: [a.id] }, USER);
    await patchRecord(backend, as(USER), created.id, { values: { contacts: [a.id, b.id] } });
    const result = await forget(backend, as(USER), a.id);
    expect(result.recomputedRecordIds).toContain(created.id);
    expect(await contactsOf(created.id)).toEqual([b.id]);
    const values = await assertionValues(created.id, 'deal', 'contacts');
    expect(values.map((v) => v.value)).toEqual([[], [b.id]]);
  });
});

describe('events', () => {
  it('attaches an event to every member of its own set field, and retries match after merges', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'meeting',
        field: {
          name: 'accounts',
          label: 'Accounts',
          type: 'relation',
          settings: { targetObject: 'company', relationCardinality: 'many_to_many' },
        },
      },
    ]);
    const acme = await createRecord(backend, as(AGENT), 'company', { name: 'Acme set' });
    const acmeDup = await createRecord(backend, as(AGENT), 'company', { name: 'Acme set dup' });
    const input = {
      type: 'meeting',
      channel: 'calendar',
      externalId: `meet-${++n}`,
      occurredAt: '2026-10-05T09:00:00Z',
      fields: { accounts: [acme.id, acmeDup.id] },
      participants: [],
      about: [],
    };
    const meeting = await logEventFor(backend, as(AGENT), input);
    for (const record of [acme.id, acmeDup.id]) {
      const page = await findRecords(backend, as(AGENT), 'meeting', {
        linked: { record, link: 'field' },
        limit: 10,
      });
      expect(page.records.map((r) => r.id)).toEqual([meeting.id]);
    }
    // Two members collapse into one survivor: the original request is still a retry.
    await mergeRecord(backend, as(USER), acme.id, { recordId: acmeDup.id });
    await expect(logEventFor(backend, as(AGENT), input)).resolves.toMatchObject({
      id: meeting.id,
      created: false,
    });
    await expect(
      logEventFor(backend, as(AGENT), { ...input, fields: { accounts: [acme.id] } }),
    ).resolves.toMatchObject({ id: meeting.id, created: false });
    const otherCompany = await createRecord(backend, as(AGENT), 'company', { name: 'Other set' });
    await expect(
      logEventFor(backend, as(AGENT), {
        ...input,
        fields: { accounts: [acme.id, otherCompany.id] },
      }),
    ).rejects.toMatchObject({ code: 'event_conflict' });
  });
});
