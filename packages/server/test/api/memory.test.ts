import { beforeAll, describe, expect, it } from 'vitest';
import { RecordId } from '../../src/db/cbor.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let t: TestApp;
let keys: Record<'agent' | 'user' | 'reader', string>;
let otherKey: string;
let workspaceId: string;

beforeAll(async () => {
  t = startTestApp(backend);
  let workspace: { id: string };
  ({ keys, workspace } = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'agent', id: 'reader' }, scopes: ['read'] },
    },
  ));
  workspaceId = workspace.id;
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

const createCompany = async (name = `Acme ${++n}`) => {
  const res = await t.request('/v1/objects/company/records', {
    key: keys.agent,
    body: { values: { name } },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const logCall = (body: Record<string, unknown> = {}, key = keys.agent) =>
  t.request('/v1/events', {
    key,
    body: { type: 'call', channel: 'zoom', occurredAt: '2026-10-29T14:00:00+02:00', ...body },
  });

/** Runtime reads of the workspace's database, parameters only. */
const rows = async <T = Record<string, unknown>>(
  text: string,
  vars: Record<string, unknown> = {},
) => (await backend.workspace(workspaceId)).rows<T>(text, vars);

/** The internal note `remember` created for a fact with no source. */
const internalNoteOf = async (factId: string) => {
  const [row] = await rows<{ source: string }>('SELECT source FROM fact_sources WHERE fact = $f;', {
    f: factId,
  });
  return row?.source as string;
};

describe('POST /v1/events', () => {
  it('logs an event (201), and returns it again for the same input (200)', async () => {
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
      type: 'call',
      created: true,
      participants: {
        matched: [
          { id: expect.any(String), handle: dana.email, role: 'customer', recordId: dana.id },
        ],
        unmatched: [
          {
            id: expect.any(String),
            handle: 'ron.peretz@acme.test',
            role: 'customer',
            reason: 'no_match',
          },
        ],
      },
      about: [],
    });
    const again = await logCall(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      ...first.body,
      created: false,
      added: { participants: { matched: [], unmatched: [] }, about: [] },
    });

    const conflict = await logCall({ ...body, summary: 'Something else.' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'event_conflict',
      details: { id: first.body.id },
    });
    // The identity spans event types: the same source as a meeting conflicts too.
    const otherType = await logCall({ ...body, type: 'meeting' });
    expect(otherType.status).toBe(409);
    expect(otherType.body.error.code).toBe('event_conflict');
  });

  it('validates the shape and names the problems', async () => {
    const res = await logCall({ type: '', occurredAt: '2026-10-29T14:00:00' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    const paths = (res.body.error.details.issues as { path: string }[]).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['type', 'occurredAt']));

    const bad = await logCall({ participants: [{ handle: 'not a handle' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_participants');
  });

  it('logs only event types, by their API name', async () => {
    const unknown = await logCall({ type: 'fax' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.details.eventTypes).toEqual(
      expect.arrayContaining(['meeting', 'call', 'email', 'message', 'note']),
    );
    const entity = await logCall({ type: 'person' });
    expect(entity.status).toBe(422);
    expect(entity.body.error.code).toBe('not_an_event_type');
    // The hidden internal-note type is not an event type a caller can log.
    const internal = await logCall({ type: 'internalNote' });
    expect(internal.status).toBe(404);
    expect(unknown.body.error.details.eventTypes).not.toContain('internalNote');
  });

  it('takes the type’s other fields under fields, and title and summary only at the top level', async () => {
    const misplaced = await logCall({ fields: { title: 'In fields' } });
    expect(misplaced.status).toBe(422);
    expect(misplaced.body.error.code).toBe('invalid_values');
  });

  it('refuses an event that has not happened yet', async () => {
    const res = await logCall({ occurredAt: '2999-01-01T00:00:00Z' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_occurred_at');
  });

  it('needs the write scope', async () => {
    const res = await logCall({}, keys.reader);
    expect(res.status).toBe(403);
  });

  it('creates events only by logging them', async () => {
    const created = await t.request('/v1/objects/call/records', {
      key: keys.agent,
      body: { values: { title: 'Made as a record' } },
    });
    expect(created.status).toBe(422);
    expect(created.body.error.code).toBe('use_log_event');
    const upserted = await t.request('/v1/objects/call/upsert', {
      key: keys.agent,
      body: { values: { title: 'Made as a record' } },
    });
    expect(upserted.status).toBe(422);
    expect(upserted.body.error.code).toBe('use_log_event');
  });
});

describe('GET and DELETE /v1/events/:id', () => {
  it('reads an event and retracts it, recomputing the values it supported', async () => {
    const dana = await createPerson();
    const older = await logCall({ occurredAt: '2026-09-01T10:00:00Z' });
    const newer = await logCall({
      occurredAt: '2026-10-01T10:00:00Z',
      externalId: `zoom-${++n}`,
      title: 'Newer call',
    });
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

    const read = await t.request(`/v1/events/${newer.body.id}`, { key: keys.reader });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id: newer.body.id,
      object: 'call',
      label: 'Newer call',
      event: {
        occurredAt: '2026-10-01T10:00:00.000Z',
        channel: 'zoom',
        externalId: `zoom-${n}`,
        title: 'Newer call',
        summary: null,
        participants: { matched: [], unmatched: [] },
        about: [],
      },
    });
    // The record route reads the same event.
    const asRecord = await t.request(`/v1/records/${newer.body.id}`, { key: keys.reader });
    expect(asRecord.body).toEqual(read.body);

    const retract = await t.request(`/v1/events/${newer.body.id}`, {
      key: keys.agent,
      method: 'DELETE',
    });
    expect(retract.status).toBe(200);
    expect(retract.body).toEqual({
      id: newer.body.id,
      deleted: true,
      retractedAssertions: 1,
      recomputedRecordIds: [dana.id],
      hiddenFactIds: [],
    });
    const record = await t.request(`/v1/records/${dana.id}`, { key: keys.agent });
    expect(record.body.fields.jobTitle).toBe('Director');

    const gone = await t.request(`/v1/events/${newer.body.id}`, { key: keys.agent });
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('record_deleted');
    const twice = await t.request(`/v1/events/${newer.body.id}`, {
      key: keys.agent,
      method: 'DELETE',
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('event_deleted');

    // Its identity stays retracted: logging the same source again is refused.
    const relog = await logCall({
      occurredAt: '2026-10-01T10:00:00Z',
      externalId: `zoom-${n}`,
      title: 'Newer call',
    });
    expect(relog.status).toBe(409);
    expect(relog.body.error).toMatchObject({
      code: 'event_retracted',
      details: { id: newer.body.id },
    });
  });

  it('deletes an event through DELETE /v1/records/:id with the same retraction', async () => {
    const dana = await createPerson();
    const call = await logCall({ occurredAt: '2026-10-02T10:00:00Z' });
    await t.request(`/v1/records/${dana.id}`, {
      key: keys.agent,
      method: 'PATCH',
      body: { values: { jobTitle: 'Founder' }, source: call.body.id },
    });
    const fact = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.agent,
      body: { text: 'Founded the company in 2019.', source: call.body.id },
    });
    const res = await t.request(`/v1/records/${call.body.id}`, {
      key: keys.agent,
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: call.body.id,
      deleted: true,
      deletedRecordIds: [call.body.id],
      retractedAssertions: 1,
      recomputedRecordIds: [dana.id],
      hiddenFactIds: [fact.body.fact.id],
    });
    const record = await t.request(`/v1/records/${dana.id}`, { key: keys.agent });
    expect(record.body.fields.jobTitle).toBeUndefined();
  });

  it('reads only events: an entity is not one', async () => {
    const dana = await createPerson();
    for (const method of ['GET', 'DELETE']) {
      const res = await t.request(`/v1/events/${dana.id}`, { key: keys.agent, method });
      expect(res.status, method).toBe(404);
    }
    expect((await t.request(`/v1/records/${dana.id}`, { key: keys.agent })).status).toBe(200);
  });

  it("returns 404 for a malformed ID and another workspace's event", async () => {
    const theirs = await logCall({}, otherKey);
    expect(theirs.status).toBe(201);
    for (const path of ['/v1/events/nope', `/v1/events/${theirs.body.id}`]) {
      expect((await t.request(path, { key: keys.agent })).status).toBe(404);
      expect((await t.request(path, { key: keys.agent, method: 'DELETE' })).status).toBe(404);
    }
  });

  it('needs the write scope to retract', async () => {
    const call = await logCall();
    const res = await t.request(`/v1/events/${call.body.id}`, {
      key: keys.reader,
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });
});

describe('participants and about records of a logged event', () => {
  it('adds them with POST, and lets only a person remove them', async () => {
    const dana = await createPerson();
    const acme = await createCompany('Acme REST');
    const call = await logCall({ externalId: `rest-links-${++n}` });
    const path = `/v1/events/${call.body.id}`;

    const added = await t.request(`${path}/links`, {
      key: keys.agent,
      body: { participants: [{ handle: dana.email, role: 'customer' }], about: [acme] },
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      id: call.body.id,
      event: { about: [acme] },
      added: { about: [acme] },
    });
    const participantId = added.body.event.participants.matched[0].id;
    expect(added.body.event.participants.matched[0].recordId).toBe(dana.id);
    expect(added.body.added.participants.matched).toEqual([
      expect.objectContaining({ id: participantId }),
    ]);

    const again = await t.request(`${path}/links`, { key: keys.agent, body: { about: [acme] } });
    expect(again.body.added).toEqual({ participants: { matched: [], unmatched: [] }, about: [] });

    const empty = await t.request(`${path}/links`, { key: keys.agent, body: {} });
    expect(empty.status).toBe(400);
    const reader = await t.request(`${path}/links`, {
      key: keys.reader,
      body: { about: [acme] },
    });
    expect(reader.status).toBe(403);

    for (const sub of [`participants/${participantId}`, `about/${acme}`]) {
      const byAgent = await t.request(`${path}/${sub}`, { key: keys.agent, method: 'DELETE' });
      expect(byAgent.status).toBe(403);
      const byUser = await t.request(`${path}/${sub}`, { key: keys.user, method: 'DELETE' });
      expect(byUser.status).toBe(200);
      const twice = await t.request(`${path}/${sub}`, { key: keys.user, method: 'DELETE' });
      expect(twice.status).toBe(404);
    }
    const read = await t.request(path, { key: keys.reader });
    expect(read.body.event).toMatchObject({
      participants: { matched: [], unmatched: [] },
      about: [],
    });
  });

  it('refuses links on a deleted event or a record that is not an event', async () => {
    const acme = await createCompany();
    const call = await logCall();
    await t.request(`/v1/events/${call.body.id}`, { key: keys.agent, method: 'DELETE' });
    const deleted = await t.request(`/v1/events/${call.body.id}/links`, {
      key: keys.agent,
      body: { about: [acme] },
    });
    expect(deleted.status).toBe(404);
    expect(deleted.body.error.code).toBe('record_deleted');
    const entity = await t.request(`/v1/events/${acme}/links`, {
      key: keys.agent,
      body: { about: [acme] },
    });
    expect(entity.status).toBe(404);
  });
});

describe('POST /v1/objects/:event/query', () => {
  it('filters by built-in columns, counts and pages an event type', async () => {
    const channel = `rest-query-${++n}`;
    for (const day of ['01', '02', '03']) {
      expect((await logCall({ channel, occurredAt: `2026-10-${day}T10:00:00Z` })).status).toBe(201);
    }
    expect((await logCall({ channel, type: 'email' })).status).toBe(201);
    const res = await t.request('/v1/objects/call/query', {
      key: keys.reader,
      body: { filter: { channel: { eq: channel } }, sort: [{ field: 'occurredAt' }], limit: 2 },
    });
    expect(res.status).toBe(200);
    expect(
      res.body.records.map((r: { event: { occurredAt: string } }) => r.event.occurredAt),
    ).toEqual(['2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z']);
    const next = await t.request('/v1/objects/call/query', {
      key: keys.reader,
      body: {
        filter: { channel: { eq: channel } },
        sort: [{ field: 'occurredAt' }],
        limit: 2,
        cursor: res.body.nextCursor,
      },
    });
    expect(next.body.records).toHaveLength(1);
    expect(next.body.nextCursor).toBeNull();

    const later = await t.request('/v1/objects/call/query', {
      key: keys.reader,
      body: { filter: { channel: { eq: channel }, occurredAt: { gt: '2026-10-01T12:00:00Z' } } },
    });
    expect(later.body.records).toHaveLength(2);

    for (const [object, total] of [
      ['call', 3],
      ['email', 1],
    ] as const) {
      const counted = await t.request(`/v1/objects/${object}/aggregate`, {
        key: keys.reader,
        body: { filter: { channel: { eq: channel } } },
      });
      expect(counted.status).toBe(200);
      expect(counted.body.total, object).toBe(total);
    }

    const invalid = await t.request('/v1/objects/call/query', {
      key: keys.reader,
      body: { filter: { occurredAt: { contains: 'x' } } },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('invalid_filter');
    // Built-in event columns belong to event types only.
    const entity = await t.request('/v1/objects/person/query', {
      key: keys.reader,
      body: { filter: { channel: { eq: channel } } },
    });
    expect(entity.status).toBe(422);
  });

  it('lists the events linked to a record, narrowed by how they are attached', async () => {
    const dana = await createPerson();
    const acme = await createCompany();
    const asParticipant = await logCall({
      participants: [{ handle: dana.email }],
      about: [acme],
    });
    const asAbout = await logCall({ about: [dana.id] });
    await logCall({ about: [acme] });
    const query = (object: string, linked: Record<string, unknown>) =>
      t.request(`/v1/objects/${object}/query`, { key: keys.reader, body: { linked } });
    const ids = async (linked: Record<string, unknown>) =>
      ((await query('call', linked)).body.records as { id: string }[]).map((r) => r.id).sort();

    expect(await ids({ record: dana.id })).toEqual([asParticipant.body.id, asAbout.body.id].sort());
    expect(await ids({ record: dana.id, link: 'participant' })).toEqual([asParticipant.body.id]);
    expect(await ids({ record: dana.id, link: 'about' })).toEqual([asAbout.body.id]);
    expect(await ids({ record: dana.id, link: 'field' })).toEqual([]);
    expect(await ids({ record: '00000000-0000-4000-8000-000000000000' })).toEqual([]);

    const entity = await query('person', { record: dana.id });
    expect(entity.status).toBe(422);
    expect(entity.body.error.code).toBe('invalid_filter');
    const badLink = await query('call', { record: dana.id, link: 'rollup' });
    expect(badLink.status).toBe(400);
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
    const [row] = await rows<{ source: string; observed_at: Date }>(
      'SELECT source, observed_at FROM field_assertions WHERE record = $r AND value = $v;',
      { r: created.body.id, v: 'CTO' },
    );
    expect(row?.source).toBe(call.body.id);
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

    // An entity record is not evidence: only an event can be a source.
    const entity = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { id: created.body.id, values: { jobTitle: 'CEO' }, source: created.body.id },
    });
    expect(entity.status).toBe(422);
    expect(entity.body.error.code).toBe('invalid_source');

    await t.request(`/v1/events/${call.body.id}`, { key: keys.agent, method: 'DELETE' });
    const retracted = await t.request('/v1/objects/person/upsert', {
      key: keys.agent,
      body: { id: created.body.id, values: { jobTitle: 'CEO' }, source: call.body.id },
    });
    expect(retracted.status).toBe(409);
    expect(retracted.body.error.code).toBe('source_retracted');
  });

  it('edits an event’s text as an ordinary assertion', async () => {
    const call = await logCall({ title: 'First title', externalId: `edit-${++n}` });
    const patched = await t.request(`/v1/records/${call.body.id}`, {
      key: keys.user,
      method: 'PATCH',
      body: { values: { title: 'Corrected title' } },
    });
    expect(patched.status).toBe(200);
    const read = await t.request(`/v1/events/${call.body.id}`, { key: keys.reader });
    expect(read.body).toMatchObject({
      label: 'Corrected title',
      event: { title: 'Corrected title' },
    });
    // A retry compares with what was first logged, not the edit.
    const retry = await logCall({ title: 'First title', externalId: `edit-${n}` });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(call.body.id);
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
        sources: [{ event: call.body.id, quote: 'legal usually needs two weeks with these' }],
      },
    });

    const listed = await t.request(`/v1/records/${dana.id}/facts`, { key: keys.reader });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ record: dana.id, facts: [created.body.fact], nextCursor: null });

    const retracted = await t.request(`/v1/facts/${created.body.fact.id}`, {
      key: keys.user,
      method: 'DELETE',
    });
    expect(retracted.status).toBe(200);
    expect(retracted.body).toEqual({ id: created.body.fact.id, deleted: true });
    const after = await t.request(`/v1/records/${dana.id}/facts`, { key: keys.agent });
    expect(after.body.facts).toEqual([]);
  });

  it('cites an internal note for a fact without a source, never exposing its ID', async () => {
    const dana = await createPerson();
    const created = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.agent,
      body: { text: 'Prefers calls after 4pm.' },
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body)).toEqual(['fact']);
    expect(created.body.fact.sources).toEqual([{ event: null, internal: true, quote: null }]);
    const listed = await t.request(`/v1/records/${dana.id}/facts`, { key: keys.reader });
    expect(listed.body.facts[0].sources).toEqual([{ event: null, internal: true, quote: null }]);
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
    expect(a.body.fact.sources).toEqual([{ event: null, internal: true, quote: null }]);
    // One fact and one note, not two.
    const facts = await rows<{ id: RecordId }>('SELECT id FROM facts WHERE record = $r;', {
      r: dana.id,
    });
    expect(facts).toHaveLength(1);
    const sources = await rows('SELECT source FROM fact_sources WHERE fact = $f;', {
      f: String(facts[0]?.id.id),
    });
    expect(sources).toHaveLength(1);
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
    const entitySource = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.agent,
      body: { text: 'x', source: dana.id },
    });
    expect(entitySource.status).toBe(422);
    expect(entitySource.body.error.code).toBe('invalid_source');
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

describe('internal notes', () => {
  it('are invisible to every record and event route', async () => {
    const dana = await createPerson();
    const created = await t.request(`/v1/records/${dana.id}/facts`, {
      key: keys.agent,
      body: { text: 'Hidden note text.' },
    });
    const note = await internalNoteOf(created.body.fact.id);
    expect(note).toEqual(expect.any(String));

    const requests: [string, string, unknown?][] = [
      ['GET', `/v1/records/${note}`],
      ['GET', `/v1/records/${note}?include=provenance`],
      ['PATCH', `/v1/records/${note}`, { values: { summary: 'Edited' } }],
      ['DELETE', `/v1/records/${note}`],
      ['GET', `/v1/records/${note}/assertions`],
      ['GET', `/v1/records/${note}/facts`],
      ['GET', `/v1/records/${note}/events`],
      ['GET', `/v1/records/${note}/context`],
      ['GET', `/v1/records/${note}/timeline`],
      ['GET', `/v1/records/${note}/delete-impact`],
      ['GET', `/v1/events/${note}`],
      ['GET', `/v1/events/${note}/claims`],
      ['DELETE', `/v1/events/${note}`],
      ['POST', `/v1/events/${note}/links`, { about: [dana.id] }],
      ['POST', `/v1/records/${note}/facts`, { text: 'About the note' }],
      ['POST', '/v1/objects/internalNote/query', {}],
      ['POST', '/v1/objects/internalNotes/query', {}],
      ['POST', '/v1/objects/internalNote/aggregate', {}],
      ['POST', '/v1/objects/internalNote/records', { values: {} }],
      ['POST', '/v1/objects/internalNote/upsert', { id: note, values: { summary: 'Edited' } }],
    ];
    for (const [method, path, body] of requests) {
      const res = await t.request(path, {
        key: keys.user,
        method,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // Nor can a write cite it as a source.
    const cited = await t.request(`/v1/records/${dana.id}`, {
      key: keys.agent,
      method: 'PATCH',
      body: { values: { jobTitle: 'CTO' }, source: note },
    });
    expect(cited.status).toBe(422);
    expect(cited.body.error.code).toBe('invalid_source');

    const schema = await t.request('/v1/schema', { key: keys.reader });
    expect(schema.body.objects.map((o: { nameSingular: string }) => o.nameSingular)).not.toContain(
      'internalNote',
    );

    // The note and the fact are untouched by all of the above.
    const facts = await t.request(`/v1/records/${dana.id}/facts`, { key: keys.reader });
    expect(facts.body.facts.map((f: { content: string }) => f.content)).toEqual([
      'Hidden note text.',
    ]);
    const [entry] = await rows<{ deleted_at?: Date | null }>('SELECT deleted_at FROM $dir;', {
      dir: new RecordId('record_directory', note),
    });
    expect(entry).toBeDefined();
    expect(entry?.deleted_at ?? null).toBeNull();
  });

  it('reserves the channel of internal notes', async () => {
    const res = await logCall({ type: 'note', channel: 'retainer' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('reserved');
  });
});

describe('events cannot merge', () => {
  it('refuses to merge two events, or an event and an entity', async () => {
    const a = await logCall();
    const b = await logCall();
    const dana = await createPerson();
    const merge = (into: string, from: string) =>
      t.request(`/v1/records/${into}/merge`, { key: keys.user, body: { recordId: from } });
    const events = await merge(a.body.id, b.body.id);
    expect(events.status).toBe(422);
    expect(events.body.error.code).toBe('invalid_merge');
    // An event never survives a merge, and records of different objects never merge.
    for (const [into, from, code] of [
      [a.body.id, dana.id, 'invalid_merge'],
      [dana.id, a.body.id, 'wrong_object'],
    ] as const) {
      const res = await merge(into, from);
      expect(res.status, `${into} <- ${from}`).toBe(422);
      expect(res.body.error.code).toBe(code);
    }
    expect((await t.request(`/v1/events/${b.body.id}`, { key: keys.reader })).status).toBe(200);
  });
});

describe('GET /v1/review', () => {
  it('lists participants that match deleted records', async () => {
    const gone = await createPerson();
    await t.request(`/v1/records/${gone.id}`, { key: keys.agent, method: 'DELETE' });
    const call = await logCall({ title: 'Call', participants: [{ handle: gone.email }] });
    expect(call.body.participants.unmatched).toEqual([
      { id: expect.any(String), handle: gone.email, role: null, reason: 'deleted_record' },
    ]);
    const review = await t.request('/v1/review', { key: keys.user });
    expect(review.body.unresolvedParticipants).toContainEqual(
      expect.objectContaining({
        eventId: call.body.id,
        title: 'Call',
        deletedRecordIds: [gone.id],
      }),
    );
  });
});
