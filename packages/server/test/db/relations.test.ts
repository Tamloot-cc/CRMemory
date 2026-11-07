import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { logEventFor } from '../../src/memory/service.js';
import {
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
 * Native multi-record relations (spec 5): many_to_many fields hold a set of
 * records, written whole as one assertion, with one derived edge per member
 * and a read-only inverse on the other side.
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
const person = () => createRecord(app, as(AGENT), 'person', { emails: `rel${++n}@acme.test` });
const deal = (values: Record<string, unknown> = {}, actor = AGENT) =>
  createRecord(app, as(actor), 'deal', { name: `Deal ${++n}`, ...values });
const contactsOf = async (id: string) =>
  (await readRecord(app, as(AGENT), id)).fields.contacts as string[];
const edges = (id: string) =>
  db.owner<{ target_record_id: string; is_collection: boolean }[]>`
    select l.target_record_id, l.is_collection from record_links l
    join fields f on f.id = l.field_id
    where l.source_record_id = ${id} and f.name = 'contacts'
    order by l.target_record_id`;

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 20 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Acme', template: 'sales' })).id;
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
    const described = await describeSchema(app, as(AGENT));
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
    expect((await edges(created.id)).every((e) => e.is_collection)).toBe(true);

    await patchRecord(app, as(AGENT), created.id, { values: { contacts: [c.id] } });
    expect(await contactsOf(created.id)).toEqual([c.id]);
    await patchRecord(app, as(AGENT), created.id, { values: { contacts: [] } });
    expect(await contactsOf(created.id)).toEqual([]);
    expect(await edges(created.id)).toEqual([]);
    await expectDataMatchesAssertions(app, workspaceId, created.id);

    // One assertion per write, holding the whole set.
    const [history] = await db.owner<{ count: number }[]>`
      select count(*)::int from field_assertions a join fields f on f.id = a.field_id
      where a.record_id = ${created.id} and f.name = 'contacts'`;
    expect(history?.count).toBe(3);
  });

  it('rejects null, and rolls back the whole write for one invalid member', async () => {
    const a = await person();
    const created = await deal({ contacts: [a.id] });
    await expect(
      patchRecord(app, as(AGENT), created.id, { values: { contacts: null } }),
    ).rejects.toMatchObject({ code: 'invalid_values' });

    const company = await createRecord(app, as(AGENT), 'company', { name: 'Not a person' });
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(
      patchRecord(app, as(AGENT), created.id, {
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
    const after = await readRecord(app, as(AGENT), created.id);
    expect(after.fields.contacts).toEqual([a.id]);
    expect(after.label).not.toBe('Renamed');
  });

  it('refuses writes to the inverse side', async () => {
    const a = await person();
    const created = await deal();
    await expect(
      patchRecord(app, as(AGENT), a.id, { values: { contactDeals: [created.id] } }),
    ).rejects.toMatchObject({ code: 'invalid_values' });
  });

  it('reads the inverse from the owning side, and drops deleted members', async () => {
    const [a, b] = [await person(), await person()];
    const first = await deal({ contacts: [a.id, b.id] });
    const second = await deal({ contacts: [a.id] });
    expect((await readRecord(app, as(AGENT), a.id)).fields.contactDeals).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    await deleteRecord(app, as(USER), b.id);
    expect(await contactsOf(first.id)).toEqual([a.id]);
  });

  it('keeps a pending set from changing the edges', async () => {
    const [a, b] = [await person(), await person()];
    const created = await deal({ contacts: [a.id] }, USER);
    const write = await patchRecord(app, as(AGENT), created.id, { values: { contacts: [b.id] } });
    expect(write.fields).toEqual({ contacts: 'pending_review' });
    expect((await edges(created.id)).map((e) => e.target_record_id)).toEqual([a.id]);
  });

  it('recomputes the set when its source event is deleted', async () => {
    const [a, b] = [await person(), await person()];
    const log = (externalId: string, occurredAt: string) =>
      logEventFor(app, as(AGENT), {
        type: 'conversation',
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
      app,
      as(AGENT),
      'deal',
      { name: 'Sourced', contacts: [a.id] },
      { source: early.id },
    );
    await patchRecord(app, as(AGENT), created.id, {
      values: { contacts: [a.id, b.id] },
      source: late.id,
    });
    expect(await contactsOf(created.id)).toEqual([a.id, b.id].sort());
    await deleteRecord(app, as(USER), late.id);
    expect(await contactsOf(created.id)).toEqual([a.id]);
    expect((await edges(created.id)).map((e) => e.target_record_id)).toEqual([a.id]);
  });
});

describe('the database guarantee', () => {
  it('holds a single-record field to one target, whatever a writer claims', async () => {
    const acme = await createRecord(app, as(AGENT), 'company', { name: 'Acme' });
    const globex = await createRecord(app, as(AGENT), 'company', { name: 'Globex' });
    const dana = await createRecord(app, as(AGENT), 'person', {
      emails: `single${++n}@acme.test`,
      company: acme.id,
    });
    const [link] = await db.owner<{ field_id: string }[]>`
      select field_id from record_links where source_record_id = ${dana.id}`;
    const insert = (isCollection: boolean) =>
      db.owner`
        insert into record_links (workspace_id, field_id, source_record_id, target_record_id,
          is_collection, created_by)
        values (${workspaceId}, ${link?.field_id as string}, ${dana.id}, ${globex.id},
          ${isCollection}, ${db.owner.json(AGENT)})`;
    await expect(insert(false)).rejects.toMatchObject({ code: '23505' });
    await expect(insert(true)).rejects.toMatchObject({ code: '23505' });
    await expect(
      db.owner`update record_links set is_collection = true where source_record_id = ${dana.id}`.then(
        () => db.owner<{ is_collection: boolean }[]>`
          select is_collection from record_links where source_record_id = ${dana.id}`,
      ),
    ).resolves.toEqual([{ is_collection: false }]);
  });

  it('refuses edges on an inverse or non-relation field', async () => {
    const a = await person();
    const created = await deal();
    const fieldId = async (object: string, name: string) => {
      const [row] = await db.owner<{ id: string }[]>`
        select f.id from fields f join object_types o on o.id = f.object_type_id
        where o.workspace_id = ${workspaceId} and o.name_singular = ${object} and f.name = ${name}`;
      return row?.id as string;
    };
    for (const id of [await fieldId('person', 'contactDeals'), await fieldId('deal', 'name')]) {
      await expect(
        db.owner`
          insert into record_links (workspace_id, field_id, source_record_id, target_record_id,
            created_by)
          values (${workspaceId}, ${id}, ${a.id}, ${created.id}, ${db.owner.json(AGENT)})`,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('keeps one target when single-record writes race', async () => {
    const companies = await Promise.all(
      [1, 2, 3, 4].map((i) => createRecord(app, as(AGENT), 'company', { name: `Race ${i}` })),
    );
    const dana = await person();
    await Promise.all(
      companies.map((c) => patchRecord(app, as(AGENT), dana.id, { values: { company: c.id } })),
    );
    const links = await db.owner`
      select 1 from record_links l join fields f on f.id = l.field_id
      where l.source_record_id = ${dana.id} and f.name = 'company'`;
    expect(links).toHaveLength(1);
    await expectDataMatchesAssertions(app, workspaceId, dana.id);
  });
});

describe('queries', () => {
  it('filters with containsAny, containsAll and isEmpty', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    const ab = await deal({ contacts: [a.id, b.id] });
    const bc = await deal({ contacts: [b.id, c.id] });
    const none = await deal({ contacts: [] });
    const ids = async (filter: Record<string, unknown>) =>
      (await findRecords(app, as(AGENT), 'deal', { filter, limit: 200 })).records
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
        findRecords(app, as(AGENT), 'deal', { filter, limit: 10 }),
      ).rejects.toMatchObject({ code: 'invalid_filter' });
    }
    await expect(
      findRecords(app, as(AGENT), 'deal', {
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
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect(await contactsOf(both.id)).toEqual([a.id, c.id].sort());
    expect(await contactsOf(onlyB.id)).toEqual([a.id]);
    const values = await db.owner<{ value: string[] }[]>`
      select a.value from field_assertions a join fields f on f.id = a.field_id
      where a.record_id = ${both.id} and f.name = 'contacts'`;
    expect(values.every((v) => !v.value.includes(b.id))).toBe(true);
    await expectDataMatchesAssertions(app, workspaceId, both.id);
  });

  it('removes a forgotten record from every set assertion, so it cannot come back', async () => {
    const [a, b] = [await person(), await person()];
    const created = await deal({ contacts: [a.id] }, USER);
    await patchRecord(app, as(USER), created.id, { values: { contacts: [a.id, b.id] } });
    const result = await forget(app, as(USER), a.id);
    expect(result.recomputedRecordIds).toContain(created.id);
    expect(await contactsOf(created.id)).toEqual([b.id]);
    const values = await db.owner<{ value: string[] }[]>`
      select a.value from field_assertions a join fields f on f.id = a.field_id
      where a.record_id = ${created.id} and f.name = 'contacts' order by a.created_at`;
    expect(values.map((v) => v.value)).toEqual([[], [b.id]]);
  });
});

describe('events', () => {
  it('attaches an event to every member of its own set field, and retries match after merges', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'conversation',
        field: {
          name: 'accounts',
          label: 'Accounts',
          type: 'relation',
          settings: { targetObject: 'company', relationCardinality: 'many_to_many' },
        },
      },
    ]);
    const acme = await createRecord(app, as(AGENT), 'company', { name: 'Acme set' });
    const acmeDup = await createRecord(app, as(AGENT), 'company', { name: 'Acme set dup' });
    const input = {
      type: 'conversation',
      channel: 'calendar',
      externalId: `meet-${++n}`,
      occurredAt: '2026-10-05T09:00:00Z',
      fields: { accounts: [acme.id, acmeDup.id] },
      participants: [],
      about: [],
    };
    const meeting = await logEventFor(app, as(AGENT), input);
    for (const record of [acme.id, acmeDup.id]) {
      const page = await findRecords(app, as(AGENT), 'conversation', {
        linked: { record, link: 'field' },
        limit: 10,
      });
      expect(page.records.map((r) => r.id)).toEqual([meeting.id]);
    }
    // Two members collapse into one survivor: the original request is still a retry.
    await mergeRecord(app, as(USER), acme.id, { recordId: acmeDup.id });
    await expect(logEventFor(app, as(AGENT), input)).resolves.toMatchObject({
      id: meeting.id,
      created: false,
    });
    await expect(
      logEventFor(app, as(AGENT), { ...input, fields: { accounts: [acme.id] } }),
    ).resolves.toMatchObject({ id: meeting.id, created: false });
    const other = await createRecord(app, as(AGENT), 'company', { name: 'Other set' });
    await expect(
      logEventFor(app, as(AGENT), { ...input, fields: { accounts: [acme.id, other.id] } }),
    ).rejects.toMatchObject({ code: 'event_conflict' });
  });
});
