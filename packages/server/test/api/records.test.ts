import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'user' | 'reader', string>;
let otherKey: string;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Clinic', template: 'clinic' },
    {
      agent: { actor: { type: 'agent', id: 'front-desk' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'agent', id: 'reader' }, scopes: ['read'] },
    },
  ));
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { agent: { actor: { type: 'agent', id: 'other' }, scopes: ['read', 'write'] } },
  );
  otherKey = other.keys.agent;
});

let n = 0;
const email = () => `api${++n}@clinic.test`;

const create = (object: string, values: Record<string, unknown>, key = keys.agent) =>
  t.request(`/v1/objects/${object}/records`, { key, body: { values } });

describe('POST /v1/objects/:object/records', () => {
  it('creates a record and reports each field', async () => {
    const res = await create('person', {
      name: 'Dana Levi',
      emails: email(),
      preferredChannel: 'sms',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      created: true,
      fields: { name: 'applied', emails: 'applied', preferredChannel: 'applied' },
      record: {
        id: res.body.id,
        object: 'person',
        label: 'Dana Levi',
        fields: {
          name: { first: 'Dana', last: 'Levi' },
          emails: { primary: expect.any(String), additional: [] },
          preferredChannel: 'sms',
        },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        createdBy: { type: 'agent', id: 'front-desk' },
        updatedBy: { type: 'agent', id: 'front-desk' },
      },
    });
  });

  it('takes the actor from the key, never from the payload', async () => {
    const res = await t.request('/v1/objects/person/records', {
      key: keys.agent,
      body: { values: { emails: email() }, actor: { type: 'user', id: 'ceo' } },
    });
    expect(res.status).toBe(400); // unknown keys are refused, so nobody can try
  });

  it('needs the write scope', async () => {
    expect((await create('person', { emails: email() }, keys.reader)).status).toBe(403);
  });

  it('names the field and the allowed values on invalid input', async () => {
    const res = await create('appointment', {
      title: 'Checkup',
      status: 'late',
      startsAt: 'tomorrow',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({
      code: 'invalid_values',
      message: 'invalid values for appointment',
      details: {
        errors: [
          {
            field: 'status',
            message: 'expected one of the options',
            allowed: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'],
          },
          {
            field: 'startsAt',
            message: 'include a time zone, e.g. 2026-11-02T09:30:00Z or +02:00',
          },
        ],
      },
    });
  });

  it('answers 404 for an unknown object, listing the objects', async () => {
    const res = await create('patient', {});
    expect(res.status).toBe(404);
    expect(res.body.error.details.objects).toContain('appointment');
  });

  it('answers 409 with the candidate for a taken email', async () => {
    const address = email();
    const first = await create('person', { emails: address });
    const second = await create('person', { emails: address });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({
      code: 'unique_conflict',
      details: { field: 'emails', recordId: first.body.id, candidates: [first.body.id] },
    });
  });

  it('replays a request with the same Idempotency-Key', async () => {
    const body = { values: { emails: email() } };
    const headers = { 'idempotency-key': 'abc-123' };
    const a = await t.request('/v1/objects/person/records', { key: keys.agent, body, headers });
    const b = await t.request('/v1/objects/person/records', { key: keys.agent, body, headers });
    expect(b.body.id).toBe(a.body.id);
    const c = await t.request('/v1/objects/person/records', {
      key: keys.agent,
      body: { values: { emails: email() } },
      headers,
    });
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe('idempotency_key_reused');
  });
});

describe('GET, PATCH and DELETE /v1/records/:id', () => {
  it('reads, updates and soft-deletes one record', async () => {
    const { body: created } = await create('person', { emails: email(), jobTitle: 'Nurse' });
    const read = await t.request(`/v1/records/${created.id}`, { key: keys.reader });
    expect(read.status).toBe(200);
    expect(read.body.fields.jobTitle).toBe('Nurse');

    const patched = await t.request(`/v1/records/${created.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'Head nurse' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ created: false, fields: { jobTitle: 'applied' } });

    const stale = await t.request(`/v1/records/${created.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'X' }, expectedUpdatedAt: created.record.updatedAt },
    });
    expect(stale.status).toBe(412);

    const deleted = await t.request(`/v1/records/${created.id}`, {
      method: 'DELETE',
      key: keys.agent,
    });
    expect(deleted.body).toEqual({ id: created.id, deleted: true, deletedRecordIds: [created.id] });
    expect((await t.request(`/v1/records/${created.id}`, { key: keys.reader })).status).toBe(404);
    const writeDeleted = await t.request(`/v1/records/${created.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'Ghost' } },
    });
    expect(writeDeleted.status).toBe(409);
    expect(writeDeleted.body.error.code).toBe('record_deleted');
  });

  it('answers 404 for malformed IDs and records of another workspace', async () => {
    expect((await t.request('/v1/records/not-a-uuid', { key: keys.reader })).status).toBe(404);
    const { body: theirs } = await create('person', { emails: email() }, otherKey);
    expect((await t.request(`/v1/records/${theirs.id}`, { key: keys.reader })).status).toBe(404);
    const write = await t.request(`/v1/records/${theirs.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'x' } },
    });
    expect(write.status).toBe(404);
  });
});

describe('POST /v1/objects/:object/upsert', () => {
  it('updates by match and creates with ifMissing', async () => {
    const address = email();
    const missing = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { match: { emails: address }, values: { jobTitle: 'Doctor' } },
    });
    expect(missing.status).toBe(404);

    const created = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { match: { emails: address }, values: { jobTitle: 'Doctor' }, ifMissing: 'create' },
    });
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);

    const updated = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { match: { emails: address }, values: { address: { city: 'Haifa' } } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: created.body.id,
      created: false,
      fields: { address: 'applied' },
    });
  });

  it('refuses id and match together, and phones as a match', async () => {
    const both = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { id: '00000000-0000-4000-8000-000000000000', match: { emails: email() } },
    });
    expect(both.status).toBe(400);
    const phone = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { match: { phones: '+972501234567' } },
    });
    expect(phone.status).toBe(422);
    expect(phone.body.error.message).toContain('search or query_records');
  });
});

describe('POST /v1/objects/:object/query', () => {
  it('filters with structured conditions', async () => {
    await create('appointment', { title: 'Q-A', status: 'confirmed' });
    await create('appointment', { title: 'Q-B', status: 'cancelled' });
    const res = await t.request('/v1/objects/appointment/query', {
      key: keys.reader,
      body: { filter: { status: 'confirmed', title: { contains: 'Q-' } } },
    });
    expect(res.status).toBe(200);
    expect(res.body.records.map((r: { label: string }) => r.label)).toEqual(['Q-A']);
    expect(res.body.nextCursor).toBeNull();
  });

  it('explains invalid filters', async () => {
    const res = await t.request('/v1/objects/appointment/query', {
      key: keys.reader,
      body: { filter: { status: { contains: 'x' } } },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'invalid_filter', details: { field: 'status' } });
  });
});

describe('review', () => {
  it('lists a conflicting agent value and lets a user accept it', async () => {
    const { body: person } = await create(
      'person',
      { emails: email(), jobTitle: 'CTO' },
      keys.user,
    );
    const conflict = await t.request(`/v1/records/${person.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'CEO' } },
    });
    expect(conflict.body.fields).toEqual({ jobTitle: 'pending_review' });

    const review = await t.request('/v1/review', { key: keys.reader });
    expect(review.status).toBe(200);
    expect(review.body).toEqual({
      pendingAssertions: [
        expect.objectContaining({
          recordId: person.id,
          field: 'jobTitle',
          value: 'CEO',
          currentValue: 'CTO',
          reason: 'outranked',
        }),
      ],
      mergeSuggestions: [],
      unresolvedParticipants: [],
      totals: { pendingAssertions: 1, mergeSuggestions: 0, unresolvedParticipants: 0 },
      nextCursors: {
        pendingAssertions: null,
        mergeSuggestions: null,
        unresolvedParticipants: null,
      },
    });
    const assertionId = review.body.pendingAssertions[0].id;

    const byAgent = await t.request(`/v1/assertions/${assertionId}/accept`, {
      method: 'POST',
      key: keys.agent,
    });
    expect(byAgent.status).toBe(403);

    const accepted = await t.request(`/v1/assertions/${assertionId}/accept`, {
      method: 'POST',
      key: keys.user,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      assertionId,
      status: 'accepted',
      fields: { jobTitle: 'applied' },
      record: { fields: { jobTitle: 'CEO' } },
    });
    expect((await t.request('/v1/review', { key: keys.reader })).body.pendingAssertions).toEqual(
      [],
    );
  });

  it('lets a user reject a pending value', async () => {
    const { body: person } = await create(
      'person',
      { emails: email(), jobTitle: 'CTO' },
      keys.user,
    );
    await t.request(`/v1/records/${person.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'Intern' } },
    });
    const [pending] = (await t.request('/v1/review', { key: keys.reader })).body.pendingAssertions;
    const rejected = await t.request(`/v1/assertions/${pending.id}/reject`, {
      method: 'POST',
      key: keys.user,
    });
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      record: { fields: { jobTitle: 'CTO' } },
    });
  });

  it('shows another workspace nothing', async () => {
    const review = await t.request('/v1/review', { key: otherKey });
    expect(review.body.pendingAssertions).toEqual([]);
  });
});
