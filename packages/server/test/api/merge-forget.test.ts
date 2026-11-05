import { beforeAll, describe, expect, it } from 'vitest';
import { consolidateWorkspace } from '../../src/worker/consolidate.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let workspaceId: string;
let keys: Record<'agent' | 'user' | 'admin' | 'agentAdmin' | 'reader', string>;
let otherKey: string;

beforeAll(async () => {
  t = startTestApp(db);
  const setup = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
      admin: { actor: { type: 'user', id: 'ops' }, scopes: ['admin'] },
      agentAdmin: { actor: { type: 'agent', id: 'root-bot' }, scopes: ['admin'] },
      reader: { actor: { type: 'user', id: 'viewer' }, scopes: ['read'] },
    },
  );
  ({ keys } = setup);
  workspaceId = setup.workspace.id;
  const other = await t.setupWorkspace(
    { name: 'Other', template: 'sales' },
    { user: { actor: { type: 'user', id: 'other' }, scopes: ['admin'] } },
  );
  otherKey = other.keys.user;
});

let n = 0;
const logEvent = async (body: Record<string, unknown>) => {
  const res = await t.request('/v1/events', {
    key: keys.agent,
    body: { type: 'conversation', channel: 'phone', occurredAt: '2026-10-01T09:00:00Z', ...body },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const createPerson = async (values: Record<string, unknown> = {}) => {
  const res = await t.request('/v1/objects/person/records', {
    key: keys.agent,
    body: { values: { name: 'Dana Levi', emails: `api${++n}@acme.test`, ...values } },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

describe('POST /v1/records/:id/merge', () => {
  it('moves the merged record’s event links to the survivor', async () => {
    const a = await createPerson();
    const b = await createPerson({ emails: 'merge.b@acme.test' });
    const call = await logEvent({ participants: [{ handle: 'merge.b@acme.test' }] });
    const note = await logEvent({ type: 'note', about: [b], occurredAt: '2026-09-01T09:00:00Z' });
    const res = await t.request(`/v1/records/${a}/merge`, {
      key: keys.user,
      body: { recordId: b },
    });
    expect(res.status).toBe(200);
    const events = await t.request(`/v1/records/${a}/events`, { key: keys.reader });
    expect(events.body.items.map((e: { id: string; via: unknown }) => [e.id, e.via])).toEqual([
      [call, { kind: 'participant' }],
      [note, { kind: 'about' }],
    ]);
    // `linked` takes the merged ID as its survivor.
    const linked = await t.request('/v1/objects/conversation/query', {
      key: keys.reader,
      body: { linked: { record: b } },
    });
    expect(linked.body.records.map((r: { id: string }) => r.id)).toEqual([call]);
  });

  it('merges as a user and returns the survivor', async () => {
    const a = await createPerson();
    const b = await createPerson({ jobTitle: 'CEO' });
    const res = await t.request(`/v1/records/${a}/merge`, {
      key: keys.user,
      body: { recordId: b },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: a,
      mergedId: b,
      merged: true,
      recomputedRecordIds: [],
      record: { id: a, fields: { jobTitle: 'CEO' } },
    });
    const read = await t.request(`/v1/records/${b}`, { key: keys.reader });
    expect(read.body.id).toBe(a);
  });

  it('refuses agents, read-only keys, bad bodies and other workspaces', async () => {
    const a = await createPerson();
    const b = await createPerson();
    const agent = await t.request(`/v1/records/${a}/merge`, {
      key: keys.agent,
      body: { recordId: b },
    });
    expect(agent.status).toBe(403);
    const reader = await t.request(`/v1/records/${a}/merge`, {
      key: keys.reader,
      body: { recordId: b },
    });
    expect(reader.status).toBe(403);
    const bad = await t.request(`/v1/records/${a}/merge`, { key: keys.user, body: { into: b } });
    expect(bad.status).toBe(400);
    const foreign = await t.request(`/v1/records/${a}/merge`, {
      key: otherKey,
      body: { recordId: b },
    });
    expect(foreign.status).toBe(404);
  });

  it('replays the Idempotency-Key header', async () => {
    const a = await createPerson();
    const b = await createPerson();
    const send = () =>
      t.request(`/v1/records/${a}/merge`, {
        key: keys.user,
        body: { recordId: b },
        headers: { 'idempotency-key': 'merge-api-1' },
      });
    const first = await send();
    const second = await send();
    expect(second.body).toEqual(first.body);
  });
});

describe('merge suggestions in review', () => {
  it('lists suggestions from the consolidator, and dismisses one as a user', async () => {
    const a = await createPerson({ name: 'Yael Mizrahi' });
    const b = await createPerson({ name: 'Yael Mizrachi' });
    await consolidateWorkspace(t.sql, workspaceId);
    const review = await t.request('/v1/review', { key: keys.reader });
    const suggestion = review.body.mergeSuggestions.find(
      (s: { recordIds: string[] }) => s.recordIds.includes(a) && s.recordIds.includes(b),
    );
    expect(suggestion).toMatchObject({ reason: 'similar names' });
    // Labels come with the pair, so the inbox needs no read per record.
    expect(suggestion.records).toEqual(
      expect.arrayContaining([
        { id: a, object: 'person', label: 'Yael Mizrahi' },
        { id: b, object: 'person', label: 'Yael Mizrachi' },
      ]),
    );
    expect(review.body.totals.mergeSuggestions).toBeGreaterThanOrEqual(1);

    const byAgent = await t.request(`/v1/review/merges/${suggestion.id}/dismiss`, {
      key: keys.agent,
      method: 'POST',
    });
    expect(byAgent.status).toBe(403);
    const dismissed = await t.request(`/v1/review/merges/${suggestion.id}/dismiss`, {
      key: keys.user,
      method: 'POST',
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toEqual({ id: suggestion.id, status: 'dismissed' });
    const missing = await t.request('/v1/review/merges/not-a-uuid/dismiss', {
      key: keys.user,
      method: 'POST',
    });
    expect(missing.status).toBe(404);
  });
});

describe('POST /v1/records/:id/forget', () => {
  it('needs the admin scope and a user actor', async () => {
    const id = await createPerson();
    const write = await t.request(`/v1/records/${id}/forget`, { key: keys.user, method: 'POST' });
    expect(write.status).toBe(403);
    const agent = await t.request(`/v1/records/${id}/forget`, {
      key: keys.agentAdmin,
      method: 'POST',
    });
    expect(agent.status).toBe(403);
    const foreign = await t.request(`/v1/records/${id}/forget`, { key: otherKey, method: 'POST' });
    expect(foreign.status).toBe(404);
  });

  it('erases the events the person took part in and keeps those only about them', async () => {
    const id = await createPerson({ name: 'Rina Erased', emails: 'rina@erased.test' });
    const colleague = await createPerson({ name: 'Colleague Kept' });
    const tookPart = await logEvent({
      externalId: 'erase-call-1',
      title: 'Pricing call',
      participants: [{ handle: 'rina@erased.test' }, { recordId: colleague }],
    });
    const aboutOnly = await logEvent({ type: 'conversation', title: 'Board prep', about: [id] });
    const mention = await logEvent({ type: 'conversation', title: 'Intro to Rina Erased' });
    const cited = await t.request(`/v1/records/${colleague}`, {
      key: keys.agent,
      method: 'PATCH',
      body: { values: { jobTitle: 'Buyer' }, source: tookPart },
    });
    expect(cited.status).toBe(200);
    // An uncited fact: its internal note is erased with the person.
    expect(
      (
        await t.request(`/v1/records/${id}/facts`, {
          key: keys.agent,
          body: { text: 'Prefers email.' },
        })
      ).status,
    ).toBe(201);

    const res = await t.request(`/v1/records/${id}/forget`, { key: keys.admin, method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      forgotten: true,
      counts: { records: 1, events: 2, facts: 1 },
      recomputedRecordIds: [colleague],
      reviewCandidates: { records: [], facts: [], events: [mention] },
    });
    expect(JSON.stringify(res.body)).not.toContain('rina@erased.test');

    expect((await t.request(`/v1/events/${tookPart}`, { key: keys.reader })).status).toBe(404);
    const kept = await t.request(`/v1/events/${aboutOnly}`, { key: keys.reader });
    expect(kept.status).toBe(200);
    expect(kept.body.event.about).toEqual([]);
    const colleagueRead = await t.request(`/v1/records/${colleague}`, { key: keys.reader });
    expect(colleagueRead.body.fields.jobTitle).toBeUndefined();
    const history = await t.request(`/v1/records/${colleague}/events`, { key: keys.reader });
    expect(history.body.items).toEqual([]);

    // The erased event's identity stays suppressed.
    const relog = await t.request('/v1/events', {
      key: keys.agent,
      body: {
        type: 'conversation',
        channel: 'phone',
        externalId: 'erase-call-1',
        occurredAt: '2026-10-01T09:00:00Z',
        title: 'Pricing call',
      },
    });
    expect(relog.status).toBe(409);
    expect(relog.body.error.code).toBe('event_retracted');
  });

  it('erases the record and returns counts and review candidates only', async () => {
    const id = await createPerson({ name: 'Avi Erased', emails: 'avi@erased.test' });
    const res = await t.request(`/v1/records/${id}/forget`, { key: keys.admin, method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      forgotten: true,
      counts: {
        records: 1,
        events: 0,
        facts: 0,
        assertions: 2,
        inboundRelations: 0,
        suppressedHandles: 1,
      },
      recomputedRecordIds: [],
      reviewCandidates: { records: [], facts: [], events: [] },
    });
    expect((await t.request(`/v1/records/${id}`, { key: keys.reader })).status).toBe(404);
    const again = await t.request('/v1/objects/person/records', {
      key: keys.agent,
      body: { values: { name: 'Avi', emails: 'avi@erased.test' } },
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'suppressed', details: { field: 'emails' } });
    expect(JSON.stringify(again.body)).not.toContain('avi@erased.test');
  });
});
