import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { RecordId } from '../../src/db/cbor.js';
import { fieldColumn } from '../../src/db/names.js';
import { AppError } from '../../src/errors.js';
import type { LogEventInput } from '../../src/memory/events.js';
import {
  factsOf,
  logEventFor,
  readEvent,
  remember,
  retractEventFor,
} from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  decideAssertion,
  deleteRecord,
  forget,
  mergeRecord,
  patchRecord,
  readRecord,
  upsertRecord,
  withRead,
  withWrite,
} from '../../src/records/service.js';
import { rowsByIds } from '../../src/records/store.js';
import { lockRecord, UniqueConflictError, writeFields } from '../../src/records/write.js';
import type { CompiledSchema } from '../../src/schema-engine/compiled.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { reviewPage } from '../../src/web/review.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';
import { expectDataMatchesAssertions as expectDataCache } from '../helpers/records.js';

const backend = useTestBackend();
/** A second process on the same namespace: its writes race through their own queue. */
let other: Backend;
let workspaceId: string;
let smokeId: string;

const AGENT: Actor = { type: 'agent', id: 'front-desk' };
const USER: Actor = { type: 'user', id: 'dana' };
const INTEGRATION: Actor = { type: 'integration', id: 'hubspot' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
/** Alternates between the two processes, so concurrent writes really compete. */
const proc = (i: number) => (i % 2 === 0 ? backend : other);

const reviewQueue = (caller: Caller, limit: number) =>
  withRead(backend, caller, (db, schema) => reviewPage(db, caller.workspaceId, schema, limit, {}));

async function schemaChange(operations: SchemaOperation[], actor: Actor = USER, ws = workspaceId) {
  return runSchemaChange(backend, {
    workspaceId: ws,
    actor,
    scopes: ['schema:write', 'admin'],
    operations,
  });
}

const schemaOf = (ws = workspaceId): Promise<CompiledSchema> =>
  withRead(backend, as(AGENT, ws), async (_db, schema) => schema);

const fieldIdOf = async (object: string, field: string) =>
  (await schemaOf()).objectsByName.get(object)?.fieldsByName.get(field)?.id as string;

/** The stored row (typed columns as `data`), its directory liveness and its search document. */
async function rawRecord(id: string) {
  return withRead(backend, as(AGENT), async (db, schema) => {
    const row = (await rowsByIds(db, workspaceId, schema, [id])).get(id);
    const [search] = await db.rows<{ label_text: string; all_text: string; folded: string }>(
      'SELECT label_text, all_text, folded FROM $doc;',
      { doc: new RecordId('search_documents', id) },
    );
    return row && { data: row.data, label: row.label, search, deleted_at: row.deleted_at };
  });
}

const expectDataMatchesAssertions = (id: string) => expectDataCache(backend, workspaceId, id);

beforeAll(async () => {
  other = backend.another();
  workspaceId = (await createWorkspace(backend, { name: 'Clinic', template: 'clinic' })).id;
  smokeId = (await createWorkspace(backend, { name: 'Smoke', template: 'sales' })).id;
});

let n = 0;
const email = () => `person${++n}@acme.com`;

describe('records and memory on SurrealDB', () => {
  const smokePerson = (values: Record<string, unknown> = {}) =>
    createRecord(backend, as(AGENT, smokeId), 'person', { emails: email(), ...values });

  const smokeLog = (input: Partial<LogEventInput> = {}) =>
    logEventFor(backend, as(AGENT, smokeId), {
      type: 'call',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00+02:00',
      fields: {},
      participants: [],
      about: [],
      ...input,
    });

  it('creates, patches and reads a record', async () => {
    const created = await smokePerson({ name: 'Dana Levi' });
    expect(created.created).toBe(true);
    expect(created.record.fields.name).toEqual({ first: 'Dana', last: 'Levi' });
    const patched = await patchRecord(backend, as(AGENT, smokeId), created.id, {
      values: { name: 'Dana Cohen' },
    });
    expect(patched.fields).toEqual({ name: 'applied' });
    const read = await readRecord(backend, as(AGENT, smokeId), created.id);
    expect(read.fields.name).toEqual({ first: 'Dana', last: 'Cohen' });
  });

  it('logs an event, dedupes a retry, and matches participants', async () => {
    const dana = await smokePerson({ name: 'Dana' });
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const input = {
      externalId: 'call-1',
      title: 'Kickoff',
      participants: [{ handle: danaEmail.toUpperCase(), role: 'customer' }],
    };
    const first = await smokeLog(input);
    expect(first.created).toBe(true);
    expect(first.participants.matched).toEqual([
      { id: expect.any(String), handle: danaEmail, role: 'customer', recordId: dana.id },
    ]);
    const retry = await smokeLog(input);
    expect(retry).toMatchObject({ id: first.id, created: false });
    await expect(smokeLog({ ...input, title: 'Different' })).rejects.toMatchObject({
      code: 'event_conflict',
    });
    const event = await readEvent(backend, as(AGENT, smokeId), first.id);
    expect(event.event?.title).toBe('Kickoff');
  });

  it('remembers facts and hides them when their source is retracted', async () => {
    const dana = await smokePerson({ name: 'Dana Fact' });
    const call = await smokeLog({ externalId: 'call-fact', title: 'Fact call' });
    const cited = await remember(backend, as(AGENT, smokeId), dana.id, {
      text: 'Prefers email',
      source: call.id,
    });
    const note = await remember(backend, as(AGENT, smokeId), dana.id, { text: 'Has two kids' });
    expect(note.fact.sources).toEqual([{ event: null, internal: true, quote: null }]);
    let facts = await factsOf(backend, as(AGENT, smokeId), dana.id, 10);
    expect(facts.facts.map((f) => f.content).sort()).toEqual(['Has two kids', 'Prefers email']);
    const retraction = await retractEventFor(backend, as(AGENT, smokeId), call.id);
    expect(retraction.hiddenFactIds).toEqual([cited.fact.id]);
    facts = await factsOf(backend, as(AGENT, smokeId), dana.id, 10);
    expect(facts.facts.map((f) => f.content)).toEqual(['Has two kids']);
  });

  it('retracts claims citing a deleted event', async () => {
    const dana = await smokePerson({ name: 'Before' });
    // A claim is as recent as its source (2.2): log one after the create.
    const call = await smokeLog({
      externalId: 'call-claim',
      occurredAt: new Date().toISOString(),
    });
    await patchRecord(backend, as(AGENT, smokeId), dana.id, {
      values: { name: 'After' },
      source: call.id,
    });
    expect((await readRecord(backend, as(AGENT, smokeId), dana.id)).fields.name).toEqual({
      first: 'After',
      last: '',
    });
    const deleted = await deleteRecord(backend, as(AGENT, smokeId), call.id);
    expect(deleted).toMatchObject({ retractedAssertions: 1, recomputedRecordIds: [dana.id] });
    expect((await readRecord(backend, as(AGENT, smokeId), dana.id)).fields.name).toEqual({
      first: 'Before',
      last: '',
    });
  });

  it('merges two people, moving links and facts to the survivor', async () => {
    const a = await smokePerson({ name: 'Ann' });
    const b = await smokePerson({ name: 'Ann B' });
    const bEmail = (b.record.fields.emails as { primary: string }).primary;
    const call = await smokeLog({ participants: [{ recordId: b.id }] });
    await remember(backend, as(AGENT, smokeId), b.id, { text: 'Likes tea' });
    const merged = await mergeRecord(backend, as(USER, smokeId), a.id, { recordId: b.id });
    expect(merged).toMatchObject({ id: a.id, mergedId: b.id, merged: true });
    const emails = merged.record.fields.emails as { primary: string; additional?: string[] };
    expect(emails.additional).toContain(bEmail);
    const event = await readEvent(backend, as(AGENT, smokeId), call.id);
    expect(event.event?.participants.matched.map((p) => p.recordId)).toEqual([a.id]);
    const facts = await factsOf(backend, as(AGENT, smokeId), a.id, 10);
    expect(facts.facts.map((f) => f.content)).toEqual(['Likes tea']);
    // The merged ID resolves to the survivor.
    expect((await readRecord(backend, as(AGENT, smokeId), b.id)).id).toBe(a.id);
  });

  it('forgets a person, their events and handles', async () => {
    const gone = await smokePerson({ name: 'Forget Me' });
    const goneEmail = (gone.record.fields.emails as { primary: string }).primary;
    const call = await smokeLog({
      externalId: 'call-forget',
      participants: [{ handle: goneEmail }],
    });
    await remember(backend, as(AGENT, smokeId), gone.id, { text: 'Secret' });
    const result = await forget(backend, as(USER, smokeId), gone.id);
    expect(result).toMatchObject({
      id: gone.id,
      forgotten: true,
      // The call and the internal note `remember` wrote about them.
      counts: { records: 1, events: 2, facts: 1, suppressedHandles: 1 },
    });
    await expect(readRecord(backend, as(AGENT, smokeId), gone.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(readEvent(backend, as(AGENT, smokeId), call.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    // The erased identity and the suppressed handle never come back.
    await expect(smokeLog({ externalId: 'call-forget' })).rejects.toMatchObject({
      code: 'event_retracted',
    });
    const again = await smokeLog({ participants: [{ handle: goneEmail }] });
    expect(again.participants.unmatched).toEqual([
      { id: expect.any(String), handle: null, role: null, reason: 'suppressed' },
    ]);
  });
});

describe('creating records', () => {
  it('stores values by field key, derived from assertions', async () => {
    const result = await createRecord(backend, as(AGENT), 'person', {
      name: 'Dana Levi',
      emails: 'Dana@Acme.com',
      jobTitle: 'CTO',
      preferredChannel: 'whatsapp',
    });
    expect(result).toMatchObject({
      created: true,
      fields: {
        name: 'applied',
        emails: 'applied',
        jobTitle: 'applied',
        preferredChannel: 'applied',
      },
      record: {
        object: 'person',
        label: 'Dana Levi',
        fields: {
          name: { first: 'Dana', last: 'Levi' },
          emails: { primary: 'dana@acme.com', additional: [] },
          jobTitle: 'CTO',
        },
        createdBy: AGENT,
      },
    });
    const raw = await rawRecord(result.id);
    expect(raw?.data).toMatchObject({ jobTitle: 'CTO', emails: { primary: 'dana@acme.com' } });
    // The label is indexed on its own (the tsvector's weight A); the body holds the rest.
    expect(raw?.search?.label_text).toBe('Dana Levi');
    expect(raw?.search?.folded).toContain('dana');
    expect(raw?.search?.folded).toContain('cto');
    await expectDataMatchesAssertions(result.id);

    const db = await backend.workspace(workspaceId);
    const identifiers = await db.rows(
      'SELECT kind, value FROM record_identifiers WHERE record = $id;',
      {
        id: result.id,
      },
    );
    expect(identifiers).toEqual([{ kind: 'email', value: 'dana@acme.com' }]);
    // `is_claim` is a row in the separate unique-claim table (section 5).
    const claims = await db.rows('SELECT field_id, value FROM unique_claims WHERE record = $id;', {
      id: result.id,
    });
    expect(claims).toEqual([
      { field_id: await fieldIdOf('person', 'emails'), value: 'dana@acme.com' },
    ]);
  });

  it('rejects invalid values with every problem listed', async () => {
    await expect(
      createRecord(backend, as(AGENT), 'person', { preferredChannel: 'fax', shoeSize: 42 }),
    ).rejects.toMatchObject({
      code: 'invalid_values',
      details: {
        errors: [
          {
            field: 'preferredChannel',
            message: 'expected one of the options',
            allowed: ['email', 'phone', 'sms', 'whatsapp'],
          },
          expect.objectContaining({ field: 'shoeSize', message: 'unknown field on person' }),
        ],
      },
    });
  });

  it('two concurrent creates with the same email produce one record', async () => {
    const shared = email();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        createRecord(proc(i), as(AGENT), 'person', { emails: shared }),
      ),
    );
    const created = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter((r) => r.status === 'rejected');
    expect(created).toHaveLength(1);
    const winnerId = (created[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    for (const conflict of conflicts) {
      expect(conflict.reason).toBeInstanceOf(UniqueConflictError);
      expect((conflict.reason as UniqueConflictError).recordId).toBe(winnerId);
    }
    const person = (await schemaOf()).objectsByName.get('person');
    const db = await backend.workspace(workspaceId);
    const rows = await db.rows(
      `SELECT id FROM type::table($table) WHERE ${fieldColumn('emails')}.primary = $email;`,
      { table: person?.table, email: shared },
    );
    expect(rows).toHaveLength(1);
  });

  it('concurrent upserts with ifMissing create converge on one record', async () => {
    const shared = email();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertRecord(proc(i), as(AGENT), 'person', {
          match: { emails: shared },
          values: { jobTitle: `title ${i}` },
          ifMissing: 'create',
        }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await expectDataMatchesAssertions(results[0]?.id as string);
  });

  it('replays a create with the same idempotency key, even concurrently', async () => {
    const values = { name: 'Idem Potent', emails: email() };
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createRecord(proc(i), as(AGENT), 'person', values, { idempotencyKey: 'key-1' }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    await expect(
      createRecord(
        backend,
        as(AGENT),
        'person',
        { name: 'Someone else' },
        { idempotencyKey: 'key-1' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });
});

describe('writes to one record are serialized (rule 2.5)', () => {
  let fieldNames: string[];
  beforeAll(async () => {
    fieldNames = Array.from({ length: 20 }, (_, i) => `slot${i}`);
    await schemaChange([
      {
        op: 'create_object',
        object: {
          nameSingular: 'board',
          namePlural: 'boards',
          labelSingular: 'Board',
          labelPlural: 'Boards',
          labelField: 'title',
          fields: [
            { name: 'title', label: 'Title', type: 'text' },
            ...fieldNames.map((name) => ({ name, label: name, type: 'text' as const })),
          ],
        },
      },
    ]);
  });

  it('concurrent writes to different fields lose no values', async () => {
    const { id } = await createRecord(backend, as(AGENT), 'board', { title: 'Locks' });
    await Promise.all(
      fieldNames.map((name, i) =>
        patchRecord(proc(i), as(AGENT), id, { values: { [name]: name } }),
      ),
    );
    const record = await readRecord(backend, as(AGENT), id);
    for (const name of fieldNames) expect(record.fields[name]).toBe(name);
    await expectDataMatchesAssertions(id);
  });

  it('concurrent writes to one field leave exactly one active winner', async () => {
    const { id } = await createRecord(backend, as(AGENT), 'board', { title: 'Race' });
    const actors: Actor[] = [AGENT, USER, INTEGRATION, { type: 'agent', id: 'other' }];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        patchRecord(proc(i), as(actors[i % actors.length] as Actor), id, {
          values: { slot0: `value ${i}` },
        }),
      ),
    );
    const db = await backend.workspace(workspaceId);
    const active = await db.rows<{ actor: Actor }>(
      "SELECT actor FROM field_assertions WHERE record = $id AND field_id = $field AND status = 'active';",
      { id, field: await fieldIdOf('board', 'slot0') },
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.actor.type).toBe('user'); // highest precedence among the writers
    await expectDataMatchesAssertions(id);
  });
});

describe('precedence and review (rules 2.2, 2.3)', () => {
  it('holds a newer agent value against a user value for review', async () => {
    const { id } = await createRecord(backend, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    const agentWrite = await patchRecord(backend, as(AGENT), id, { values: { jobTitle: 'CEO' } });
    expect(agentWrite.fields).toEqual({ jobTitle: 'pending_review' });
    expect(agentWrite.record.fields.jobTitle).toBe('CTO');

    const queue = await reviewQueue(as(USER), 100);
    const pending = queue.pendingAssertions.find((p) => p.recordId === id);
    expect(pending).toMatchObject({
      object: 'person',
      field: 'jobTitle',
      value: 'CEO',
      currentValue: 'CTO',
      reason: 'outranked',
      actor: AGENT,
    });

    // An agent cannot approve its own claim.
    await expect(
      decideAssertion(backend, as(AGENT), pending?.id as string, 'accept'),
    ).rejects.toMatchObject({ status: 403 });

    const accepted = await decideAssertion(backend, as(USER), pending?.id as string, 'accept');
    expect(accepted).toMatchObject({ status: 'accepted', fields: { jobTitle: 'applied' } });
    expect(accepted.record.fields.jobTitle).toBe('CEO');

    const db = await backend.workspace(workspaceId);
    const history = await db.rows<Record<string, unknown>>(
      'SELECT actor, status, reviewed_by, created_at FROM field_assertions WHERE record = $id AND field_id = $field ORDER BY created_at;',
      { id, field: await fieldIdOf('person', 'jobTitle') },
    );
    expect(history.map(({ created_at: _, ...row }) => row)).toEqual([
      { actor: USER, status: 'superseded', reviewed_by: null },
      { actor: AGENT, status: 'superseded', reviewed_by: USER },
      { actor: USER, status: 'active', reviewed_by: null },
    ]);
    await expect(
      decideAssertion(backend, as(USER), pending?.id as string, 'accept'),
    ).rejects.toMatchObject({ code: 'not_pending' });
    await expectDataMatchesAssertions(id);
  });

  it('supersedes an agent value equal to the user value instead of holding it', async () => {
    const { id } = await createRecord(backend, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    const result = await patchRecord(backend, as(AGENT), id, { values: { jobTitle: 'CTO' } });
    expect(result.fields).toEqual({ jobTitle: 'superseded' });
  });

  it('lets integrations lose to people silently and agents beat agents by time', async () => {
    const { id } = await createRecord(backend, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    expect(
      (await patchRecord(backend, as(INTEGRATION), id, { values: { jobTitle: 'VP' } })).fields,
    ).toEqual({ jobTitle: 'superseded' });

    const second = await createRecord(backend, as(AGENT), 'person', {
      emails: email(),
      jobTitle: 'A',
    });
    const write = await patchRecord(backend, as({ type: 'agent', id: 'b' }), second.id, {
      values: { jobTitle: 'B' },
    });
    expect(write.fields).toEqual({ jobTitle: 'applied' });
    expect(write.record.fields.jobTitle).toBe('B');
  });

  it('keeps an older agent claim from overwriting a newer one', async () => {
    const { id } = await createRecord(backend, as(AGENT), 'person', {
      emails: email(),
      jobTitle: 'Now',
    });
    // The write protocol replaces the shared schema lock and the row lock (section 6).
    const { result: statuses } = await withWrite(
      backend,
      as(AGENT),
      { kind: 'test_write' },
      async (context) => {
        const object = context.schema.objectsByName.get('person');
        if (!object) throw new Error('no person');
        const record = await lockRecord(context, id);
        return writeFields(
          { ...context, confidenceThreshold: 0.5 },
          object,
          record,
          new Map([[object.fieldsByName.get('jobTitle') as never, 'From an old email']]),
          { observedAt: new Date('2024-01-01T00:00:00Z') },
        );
      },
    );
    expect(statuses).toEqual({ jobTitle: 'superseded' });
    expect((await readRecord(backend, as(AGENT), id)).fields.jobTitle).toBe('Now');
  });

  it('holds agent values below the confidence threshold', async () => {
    const { id } = await createRecord(backend, as(AGENT), 'person', { emails: email() });
    const { result: statuses } = await withWrite(
      backend,
      as(AGENT),
      { kind: 'test_write' },
      async (context) => {
        const object = context.schema.objectsByName.get('person');
        if (!object) throw new Error('no person');
        const record = await lockRecord(context, id);
        return writeFields(
          { ...context, confidenceThreshold: 0.5 },
          object,
          record,
          new Map([[object.fieldsByName.get('jobTitle') as never, 'Maybe CFO']]),
          { confidence: 0.2 },
        );
      },
    );
    expect(statuses).toEqual({ jobTitle: 'pending_review' });
    const queue = await reviewQueue(as(USER), 500);
    expect(queue.pendingAssertions.find((p) => p.recordId === id)?.reason).toBe('low_confidence');
  });

  it('rejects a pending assertion without changing the record', async () => {
    const { id } = await createRecord(backend, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    await patchRecord(backend, as(AGENT), id, { values: { jobTitle: 'Intern' } });
    const pending = (await reviewQueue(as(USER), 500)).pendingAssertions.find(
      (p) => p.recordId === id,
    );
    const rejected = await decideAssertion(backend, as(USER), pending?.id as string, 'reject');
    expect(rejected.record.fields.jobTitle).toBe('CTO');
    const after = await reviewQueue(as(USER), 500);
    expect(after.pendingAssertions.some((p) => p.id === pending?.id)).toBe(false);
  });

  it('clears a nullable field with null', async () => {
    const { id } = await createRecord(backend, as(AGENT), 'person', {
      emails: email(),
      jobTitle: 'X',
    });
    const result = await patchRecord(backend, as(AGENT), id, { values: { jobTitle: null } });
    expect(result.fields).toEqual({ jobTitle: 'applied' });
    expect(result.record.fields.jobTitle).toBeNull();
    await expectDataMatchesAssertions(id);
  });

  it('rejects a stale expectedUpdatedAt', async () => {
    const created = await createRecord(backend, as(USER), 'person', { emails: email() });
    await patchRecord(backend, as(USER), created.id, { values: { jobTitle: 'A' } });
    await expect(
      patchRecord(backend, as(USER), created.id, {
        values: { jobTitle: 'B' },
        expectedUpdatedAt: created.record.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 412, code: 'stale_write' });
  });
});

describe('upsert by match (6.2)', () => {
  it('updates the record whose unique email matches', async () => {
    const address = email();
    const { id } = await createRecord(backend, as(AGENT), 'person', { emails: address });
    const result = await upsertRecord(backend, as(AGENT), 'person', {
      match: { emails: address.toUpperCase() },
      values: { address: { street1: '12 Rothschild Blvd', city: 'Tel Aviv' } },
      ifMissing: 'fail',
    });
    expect(result).toMatchObject({ id, created: false, fields: { address: 'applied' } });
  });

  it('fails by default when nothing matches, and creates with ifMissing create', async () => {
    const address = email();
    await expect(
      upsertRecord(backend, as(AGENT), 'person', {
        match: { emails: address },
        values: {},
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({ status: 404, message: expect.stringContaining('ifMissing') });
    const created = await upsertRecord(backend, as(AGENT), 'person', {
      match: { emails: address },
      values: { jobTitle: 'New' },
      ifMissing: 'create',
    });
    expect(created.created).toBe(true);
    expect(created.record.fields.emails).toEqual({ primary: address, additional: [] });
  });

  it('refuses names and phones, pointing to search', async () => {
    await expect(
      upsertRecord(backend, as(AGENT), 'person', {
        match: { phones: '+972501234567' },
        values: {},
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_match',
      message: expect.stringContaining('search or query_records'),
      details: { allowed: ['emails'] },
    });
    await expect(
      upsertRecord(backend, as(AGENT), 'person', {
        match: { name: 'Dana Levi' },
        values: {},
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'invalid_match' });
  });

  it('returns a conflict with the candidate when identifiers point at different records', async () => {
    const first = email();
    const a = await createRecord(backend, as(AGENT), 'person', { emails: first });
    const b = await createRecord(backend, as(AGENT), 'person', { emails: email() });
    await expect(
      upsertRecord(backend, as(AGENT), 'person', {
        id: b.id,
        values: { emails: first },
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'unique_conflict', details: { candidates: [a.id] } });
    expect((await readRecord(backend, as(AGENT), b.id)).fields.emails).not.toEqual({
      primary: first,
      additional: [],
    });
  });
});

describe('relations', () => {
  it('links a person to a company and shows both sides', async () => {
    const company = await createRecord(backend, as(AGENT), 'company', {
      name: 'Acme',
      domain: 'https://www.acme.com',
    });
    const person = await createRecord(backend, as(AGENT), 'person', {
      emails: email(),
      company: company.id,
    });
    expect(person.record.fields.company).toBe(company.id);
    const companyRecord = await readRecord(backend, as(AGENT), company.id);
    expect(companyRecord.fields.people).toEqual([person.id]);

    const db = await backend.workspace(workspaceId);
    const domains = await db.rows(
      'SELECT kind, value FROM record_identifiers WHERE record = $id;',
      {
        id: company.id,
      },
    );
    expect(domains).toEqual([{ kind: 'domain', value: 'acme.com' }]);
  });

  it('rejects links to missing records and records of the wrong object', async () => {
    const task = await createRecord(backend, as(AGENT), 'task', { title: 'Call back' });
    await expect(
      createRecord(backend, as(AGENT), 'person', { emails: email(), company: task.id }),
    ).rejects.toMatchObject({
      code: 'invalid_values',
      details: { errors: [{ field: 'company', message: `record ${task.id} is not a company` }] },
    });
  });

  it('stops resolving a link once its target is deleted', async () => {
    const company = await createRecord(backend, as(AGENT), 'company', { name: 'Gone Inc' });
    const person = await createRecord(backend, as(AGENT), 'person', {
      emails: email(),
      company: company.id,
    });
    await deleteRecord(backend, as(AGENT), company.id);
    expect((await readRecord(backend, as(AGENT), person.id)).fields.company).toBeUndefined();
  });

  it('cascades a soft delete through relations marked cascade', async () => {
    await schemaChange([
      {
        op: 'create_object',
        object: {
          nameSingular: 'visitNote',
          namePlural: 'visitNotes',
          labelSingular: 'Visit note',
          labelPlural: 'Visit notes',
          labelField: 'title',
          fields: [
            { name: 'title', label: 'Title', type: 'text' },
            {
              name: 'patient',
              label: 'Patient',
              type: 'relation',
              settings: { targetObject: 'person', inverseField: 'visitNotes', onDelete: 'cascade' },
            },
          ],
        },
      },
    ]);
    const person = await createRecord(backend, as(USER), 'person', { emails: email() });
    const note = await createRecord(backend, as(USER), 'visitNote', {
      title: 'First visit',
      patient: person.id,
    });
    const deleted = await deleteRecord(backend, as(USER), person.id);
    expect(deleted.deletedRecordIds.sort()).toEqual([person.id, note.id].sort());
    await expect(readRecord(backend, as(USER), note.id)).rejects.toMatchObject({
      code: 'record_deleted',
    });
  });
});

describe('deleted and merged records', () => {
  it('keeps uniqueness claims after a soft delete', async () => {
    const address = email();
    const { id } = await createRecord(backend, as(AGENT), 'person', { emails: address });
    await deleteRecord(backend, as(AGENT), id);
    await expect(readRecord(backend, as(AGENT), id)).rejects.toMatchObject({ status: 404 });
    await expect(
      createRecord(backend, as(AGENT), 'person', { emails: address }),
    ).rejects.toMatchObject({ code: 'unique_conflict', details: { recordId: id } });
    await expect(
      upsertRecord(backend, as(AGENT), 'person', {
        match: { emails: address },
        values: { jobTitle: 'x' },
        ifMissing: 'create',
      }),
    ).rejects.toMatchObject({ code: 'record_deleted' });
  });

  it('resolves a merged record ID to the surviving record', async () => {
    const survivor = await createRecord(backend, as(AGENT), 'person', { emails: email() });
    const merged = await createRecord(backend, as(AGENT), 'person', { emails: email() });
    // Merging is build step 5; set the outcome directly to test resolution.
    const person = (await schemaOf()).objectsByName.get('person');
    const admin = backend.adminDb((await backend.route(workspaceId)).database);
    await admin.query(
      'UPDATE $dir SET merged_into = $survivor, deleted_at = time::now(); UPDATE $row SET merged_into = $survivor, deleted_at = time::now();',
      {
        dir: new RecordId('record_directory', merged.id),
        row: new RecordId(person?.table as string, merged.id),
        survivor: survivor.id,
      },
    );
    expect((await readRecord(backend, as(AGENT), merged.id)).id).toBe(survivor.id);
    const patched = await patchRecord(backend, as(AGENT), merged.id, {
      values: { jobTitle: 'Via old ID' },
    });
    expect(patched.id).toBe(survivor.id);
  });
});

describe('workspace isolation', () => {
  // Row-level security is replaced by one database per workspace (spec section 4).
  it('stops workspace A from reading or writing workspace B records', async () => {
    const otherWorkspace = await createWorkspace(backend, { name: 'Other' });
    const secret = await createRecord(backend, as(AGENT, otherWorkspace.id), 'person', {
      emails: email(),
    });
    await expect(readRecord(backend, as(AGENT), secret.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      patchRecord(backend, as(AGENT), secret.id, { values: { jobTitle: 'x' } }),
    ).rejects.toMatchObject({ status: 404 });

    // Even a query with no filter at all sees only its own workspace's rows.
    const db = await backend.workspace(workspaceId);
    const visible = await db.rows<{ id: RecordId }>('SELECT id FROM record_directory;');
    expect(visible.map((r) => String(r.id.id))).not.toContain(secret.id);
  });
});

describe('schema checks against existing records (3)', () => {
  it('fails to make a field unique while records share values, listing them', async () => {
    const a = await createRecord(backend, as(AGENT), 'person', {
      emails: email(),
      jobTitle: 'Twin',
    });
    const b = await createRecord(backend, as(AGENT), 'person', {
      emails: email(),
      jobTitle: 'Twin',
    });
    const result = await schemaChange([
      { op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true },
    ]);
    expect(result.status).toBe('failed');
    // Other tests' records share titles too; these two must be among them.
    expect(result.recordIds).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('claims existing values atomically when a field becomes unique', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'task',
        field: { name: 'ticket', label: 'Ticket', type: 'text' },
      },
    ]);
    const task = await createRecord(backend, as(AGENT), 'task', { title: 'T', ticket: 'T-1' });
    const result = await schemaChange([
      { op: 'update_field', object: 'task', field: 'ticket', isUnique: true },
    ]);
    expect(result.status).toBe('applied');
    await expect(
      createRecord(backend, as(AGENT), 'task', { title: 'Dup', ticket: 'T-1' }),
    ).rejects.toMatchObject({ code: 'unique_conflict', details: { recordId: task.id } });
    const byMatch = await upsertRecord(backend, as(AGENT), 'task', {
      match: { ticket: 'T-1' },
      values: { title: 'Found by ticket' },
      ifMissing: 'fail',
    });
    expect(byMatch.id).toBe(task.id);
  });

  it('fails to make a field required while records lack it', async () => {
    const empty = await createRecord(backend, as(AGENT), 'appointment', { title: 'No time' });
    const result = await schemaChange([
      { op: 'update_field', object: 'appointment', field: 'startsAt', isNullable: false },
    ]);
    expect(result.status).toBe('failed');
    expect(result.recordIds).toContain(empty.id);
  });

  it('refuses to remove an option records still use', async () => {
    const used = await createRecord(backend, as(AGENT), 'appointment', {
      title: 'Checkup',
      status: 'no_show',
    });
    const result = await schemaChange([
      { op: 'remove_option', object: 'appointment', field: 'status', value: 'no_show' },
    ]);
    expect(result.status).toBe('failed');
    expect(result.recordIds).toEqual([used.id]);
  });

  it('recomputes labels when the label field changes', async () => {
    const { id } = await createRecord(backend, as(AGENT), 'board', {
      title: 'Old label',
      slot1: 'New',
    });
    await schemaChange([{ op: 'update_object', object: 'board', labelField: 'slot1' }]);
    expect((await rawRecord(id))?.label).toBe('New');
  });
});

describe('errors', () => {
  it('names the unknown object and lists the real ones', async () => {
    await expect(createRecord(backend, as(AGENT), 'patient', {})).rejects.toMatchObject({
      status: 404,
      details: { objects: expect.arrayContaining(['person', 'appointment']) },
    });
    await expect(
      createRecord(backend, as(AGENT), 'people', { emails: email() }),
    ).resolves.toBeDefined();
    expect(AppError).toBeDefined();
  });
});
