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
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
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
const email = () => `rest${++n}@acme.test`;

const createPerson = async () => {
  const address = email();
  const res = await t.request('/v1/objects/person/records', {
    key: keys.agent,
    body: { values: { name: 'Dana Levi', emails: address } },
  });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, email: address };
};

const logCall = (body: Record<string, unknown> = {}, key = keys.agent) =>
  t.request('/v1/interactions', {
    key,
    body: { kind: 'call', channel: 'zoom', occurredAt: '2026-10-29T14:00:00+02:00', ...body },
  });

describe('POST /v1/interactions', () => {
  it('logs an interaction (201), and returns it again for the same input (200)', async () => {
    const dana = await createPerson();
    const body = {
      externalId: 'zoom-8812-3390',
      title: 'Acme renewal call',
      summary: 'Discussed the renewal.',
      participants: [
        { handle: dana.email, role: 'customer' },
        { handle: 'ron.peretz@acme.test', role: 'customer' },
      ],
    };
    const first = await logCall(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      id: expect.any(String),
      created: true,
      participants: {
        matched: [{ handle: dana.email, role: 'customer', recordId: dana.id }],
        unmatched: [{ handle: 'ron.peretz@acme.test', role: 'customer', reason: 'no_match' }],
      },
    });
    const again = await logCall(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, created: false });

    const conflict = await logCall({ ...body, summary: 'Something else.' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'interaction_conflict',
      details: { id: first.body.id },
    });
  });

  it('validates the shape and names the problems', async () => {
    const res = await logCall({ kind: 'fax', occurredAt: '2026-10-29T14:00:00' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    const paths = (res.body.error.details.issues as { path: string }[]).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['kind', 'occurredAt']));

    const bad = await logCall({ participants: [{ handle: 'not a handle' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_participants');
  });

  it('needs the write scope', async () => {
    const res = await logCall({}, keys.reader);
    expect(res.status).toBe(403);
  });
});

describe('GET and DELETE /v1/interactions/:id', () => {
  it('reads an interaction and retracts it, recomputing the values it supported', async () => {
    const dana = await createPerson();
    const older = await logCall({ occurredAt: '2026-09-01T10:00:00Z' });
    const newer = await logCall({ occurredAt: '2026-10-01T10:00:00Z' });
    for (const [title, source] of [
      ['Director', older.body.id],
      ['VP', newer.body.id],
    ]) {
      const res = await t.request(`/v1/records/${dana.id}`, {
        key: keys.agent,
        method: 'PATCH',
        body: { values: { jobTitle: title }, source },
      });
      expect(res.status).toBe(200);
    }

    const read = await t.request(`/v1/interactions/${newer.body.id}`, { key: keys.reader });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: newer.body.id, kind: 'call', channel: 'zoom' });

    const retract = await t.request(`/v1/interactions/${newer.body.id}`, {
      key: keys.agent,
      method: 'DELETE',
    });
    expect(retract.status).toBe(200);
    expect(retract.body).toMatchObject({ deleted: true, recomputedRecordIds: [dana.id] });
    const record = await t.request(`/v1/records/${dana.id}`, { key: keys.agent });
    expect(record.body.fields.jobTitle).toBe('Director');

    const gone = await t.request(`/v1/interactions/${newer.body.id}`, { key: keys.agent });
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('interaction_deleted');
  });

  it("returns 404 for a malformed ID and another workspace's interaction", async () => {
    const theirs = await logCall({}, otherKey);
    for (const path of ['/v1/interactions/nope', `/v1/interactions/${theirs.body.id}`]) {
      expect((await t.request(path, { key: keys.agent })).status).toBe(404);
      expect((await t.request(path, { key: keys.agent, method: 'DELETE' })).status).toBe(404);
    }
  });

  it('needs the write scope to retract', async () => {
    const call = await logCall();
    const res = await t.request(`/v1/interactions/${call.body.id}`, {
      key: keys.reader,
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });
});

describe('source on record writes', () => {
  it('accepts source on create and upsert, and rejects an unknown one', async () => {
    const call = await logCall({ occurredAt: '2026-10-20T09:00:00Z' });
    const created = await t.request('/v1/objects/person/records', {
      key: keys.agent,
      body: { values: { emails: email() }, source: call.body.id },
    });
    expect(created.status).toBe(201);
    const upserted = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { id: created.body.id, values: { jobTitle: 'CTO' }, source: call.body.id },
    });
    expect(upserted.status).toBe(200);
    expect(upserted.body.fields).toEqual({ jobTitle: 'applied' });
    const [row] = await db.owner<{ source_interaction_id: string; observed_at: Date }[]>`
      select source_interaction_id, observed_at from field_assertions
      where record_id = ${created.body.id} and value = '"CTO"'`;
    expect(row?.source_interaction_id).toBe(call.body.id);
    expect(row?.observed_at.toISOString()).toBe('2026-10-20T09:00:00.000Z');

    const unknown = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: {
        id: created.body.id,
        values: { jobTitle: 'CEO' },
        source: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('invalid_source');
  });
});

describe('facts', () => {
  it('remembers, lists and retracts facts', async () => {
    const dana = await createPerson();
    const call = await logCall({ occurredAt: '2026-10-29T14:00:00+02:00' });
    const created = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.agent,
      body: {
        text: 'Legal review at Acme usually takes two weeks.',
        source: call.body.id,
        quote: 'legal usually needs two weeks with these',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      fact: {
        id: expect.any(String),
        record: dana.id,
        content: 'Legal review at Acme usually takes two weeks.',
        kind: 'stated',
        validFrom: '2026-10-29T12:00:00.000Z',
        validTo: null,
        writtenBy: { type: 'agent', id: 'inbox' },
        sources: [{ interaction: call.body.id, quote: 'legal usually needs two weeks with these' }],
      },
      noteInteraction: null,
    });

    const listed = await t.request(`/v1/records/${dana.id}/facts`, { key: keys.reader });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ record: dana.id, facts: [created.body.fact] });

    const retracted = await t.request(`/v1/facts/${created.body.fact.id}`, {
      key: keys.user,
      method: 'DELETE',
    });
    expect(retracted.status).toBe(200);
    expect(retracted.body).toEqual({ id: created.body.fact.id, deleted: true });
    const after = await t.request(`/v1/records/${dana.id}/facts`, { key: keys.agent });
    expect(after.body.facts).toEqual([]);
  });

  it('replays a POST with the same Idempotency-Key and rejects reuse with another body', async () => {
    const dana = await createPerson();
    const post = (text: string) =>
      t.request(`/v1/records/${dana.id}/facts`, {
        key: keys.agent,
        headers: { 'idempotency-key': 'rest-fact-1' },
        body: { text },
      });
    const [a, b] = await Promise.all([post('Prefers mornings.'), post('Prefers mornings.')]);
    expect(a.body).toEqual(b.body);
    expect(a.body.noteInteraction).toEqual(expect.any(String));
    const reused = await post('Prefers evenings.');
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
  });

  it('validates the body and the scope', async () => {
    const dana = await createPerson();
    const empty = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.agent,
      body: { text: '' },
    });
    expect(empty.status).toBe(400);
    const quoteOnly = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.agent,
      body: { text: 'x', quote: 'y' },
    });
    expect(quoteOnly.status).toBe(400);
    const reader = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.reader,
      body: { text: 'x' },
    });
    expect(reader.status).toBe(403);
    const missing = await t.request('/v1/facts/00000000-0000-4000-8000-000000000000', {
      key: keys.agent,
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });
});

describe('GET /v1/review', () => {
  it('lists participants that match deleted records', async () => {
    const gone = await createPerson();
    await t.request(`/v1/records/${gone.id}`, { key: keys.agent, method: 'DELETE' });
    const call = await logCall({ title: 'Call', participants: [{ handle: gone.email }] });
    expect(call.body.participants.unmatched).toEqual([
      { handle: gone.email, role: null, reason: 'deleted_record' },
    ]);
    const review = await t.request('/v1/review', { key: keys.user });
    expect(review.body.unresolvedParticipants).toContainEqual(
      expect.objectContaining({ interactionId: call.body.id, deletedRecordIds: [gone.id] }),
    );
  });
});
