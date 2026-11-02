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
const createPerson = async (values: Record<string, unknown> = {}) => {
  const res = await t.request('/v1/objects/person/records', {
    key: keys.agent,
    body: { values: { name: 'Dana Levi', emails: `api${++n}@acme.test`, ...values } },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

describe('POST /v1/records/:id/merge', () => {
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

  it('erases the record and returns counts and review candidates only', async () => {
    const id = await createPerson({ name: 'Avi Erased', emails: 'avi@erased.test' });
    const res = await t.request(`/v1/records/${id}/forget`, { key: keys.admin, method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      forgotten: true,
      counts: {
        records: 1,
        interactions: 0,
        facts: 0,
        assertions: 2,
        inboundRelations: 0,
        suppressedHandles: 1,
      },
      recomputedRecordIds: [],
      reviewCandidates: { records: [], facts: [], interactions: [] },
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
