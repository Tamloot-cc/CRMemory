import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'user', string>;
let otherKey: string;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
    },
  ));
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { agent: { actor: { type: 'agent', id: 'other' }, scopes: ['read', 'write'] } },
  );
  otherKey = other.keys.agent;
});

/** A word no other test uses, so tests sharing the workspace do not see each other's rows. */
const word = () => `w${randomBytes(4).toString('hex')}`;

const create = async (object: string, values: Record<string, unknown>, key = keys.agent) => {
  const res = await t.request(`/v1/objects/${object}/records`, { key, body: { values } });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const logInteraction = async (body: Record<string, unknown>) => {
  const res = await t.request('/v1/interactions', {
    key: keys.agent,
    body: { kind: 'call', channel: 'zoom', occurredAt: '2026-10-29T14:00:00+02:00', ...body },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const rememberFact = async (record: string, text: string, source?: string) => {
  const res = await t.request(`/v1/records/${record}/facts`, {
    key: keys.agent,
    body: { text, ...(source ? { source } : {}) },
  });
  expect(res.status).toBe(201);
  return res.body.fact.id as string;
};

const search = (body: Record<string, unknown>, key = keys.agent) =>
  t.request('/v1/search', { key, body });

describe('POST /v1/search', () => {
  it('finds records, facts and interactions, grouped by type with their record IDs', async () => {
    const tag = word();
    const email = `${tag}@acme.test`;
    const dana = await create('person', { name: `Dana ${tag}`, emails: email });
    const call = await logInteraction({
      title: `Renewal call ${tag}`,
      summary: 'Talked about pricing.',
      participants: [{ handle: email }, { handle: 'nobody@acme.test' }],
    });
    const fact = await rememberFact(dana, `Legal review ${tag} takes two weeks.`, call);

    const res = await search({ query: tag });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      records: [{ id: dana, object: 'person', label: `Dana ${tag}`, match: 'text' }],
      facts: [
        {
          id: fact,
          record: dana,
          content: `Legal review ${tag} takes two weeks.`,
          validFrom: '2026-10-29T12:00:00.000Z',
        },
      ],
      interactions: [
        {
          id: call,
          kind: 'call',
          occurredAt: '2026-10-29T12:00:00.000Z',
          title: `Renewal call ${tag}`,
          summary: 'Talked about pricing.',
          records: [dana],
        },
      ],
    });
  });

  it('supports quoted phrases, OR and -word, and matches whole words only', async () => {
    const [a, b] = [word(), word()];
    const one = await create('company', { name: `${a} alpha` });
    const two = await create('company', { name: `${a} beta` });
    const three = await create('company', { name: `${b} gamma` });
    const ids = async (query: string) =>
      ((await search({ query })).body.records as { id: string; match: string }[])
        .filter((r) => r.match === 'text')
        .map((r) => r.id)
        .sort();

    expect(await ids(`${a} -beta`)).toEqual([one]);
    expect(await ids(`"${a} beta"`)).toEqual([two]);
    expect(await ids(`"beta ${a}"`)).toEqual([]);
    expect(await ids(`${a} OR ${b}`)).toEqual([one, two, three].sort());
    // No stemming or prefix matching: part of a word does not match.
    expect(await ids(a.slice(0, -1))).toEqual([]);
  });

  it('ranks short, precise matches first and honors the limit', async () => {
    const tag = word();
    const long = await create('company', {
      name: `${tag} ${Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ')}`,
    });
    const short = await create('company', { name: `${tag} ${tag}` });
    const res = await search({ query: tag, limit: 1 });
    expect(res.body.records.map((r: { id: string }) => r.id)).toEqual([short]);
    const both = await search({ query: tag });
    expect(both.body.records.map((r: { id: string }) => r.id)).toEqual([short, long]);
  });

  it('falls back to similar labels only when no record matches word for word', async () => {
    const tag = word();
    const dana = await create('person', { name: `Dana Levi${tag}` });
    const res = await search({ query: `Dana Levy${tag}` });
    expect(res.body.records).toEqual([
      { id: dana, object: 'person', label: `Dana Levi${tag}`, match: 'similar_label' },
    ]);
    // A word-for-word hit wins outright; similar labels are not added to it.
    const exact = await create('person', { name: `Dana Levy${tag}` });
    const again = await search({ query: `Dana Levy${tag}` });
    expect(again.body.records.map((r: { id: string }) => r.id)).toEqual([exact]);
  });

  it('hides deleted records, retracted facts and interactions, and facts with no live source', async () => {
    const tag = word();
    const email = `${tag}@acme.test`;
    const person = await create('person', { name: `Gone ${tag}`, emails: email });
    const kept = await create('company', { name: `Kept ${tag}` });
    const call = await logInteraction({ title: `Call ${tag}`, participants: [{ handle: email }] });
    await rememberFact(kept, `Cited ${tag}`, call);
    const retracted = await rememberFact(kept, `Retracted ${tag}`);
    await rememberFact(person, `About the deleted ${tag}`);

    expect(
      (await t.request(`/v1/facts/${retracted}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    expect(
      (await t.request(`/v1/records/${person}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    let res = await search({ query: tag });
    expect(res.body.records.map((r: { id: string }) => r.id)).toEqual([kept]);
    expect(res.body.facts.map((f: { content: string }) => f.content)).toEqual([`Cited ${tag}`]);
    // The call stays; its deleted participant is no longer listed.
    expect(res.body.interactions).toMatchObject([{ id: call, records: [] }]);

    expect(
      (await t.request(`/v1/interactions/${call}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    res = await search({ query: tag });
    expect(res.body.interactions).toEqual([]);
    expect(res.body.facts).toEqual([]);
  });

  it("never returns another workspace's rows", async () => {
    const tag = word();
    await create('company', { name: `Private ${tag}` });
    const res = await search({ query: tag }, otherKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ records: [], facts: [], interactions: [] });
  });

  it('validates the body and needs a key', async () => {
    expect((await search({ query: '   ' })).status).toBe(400);
    expect((await search({ query: 'x', limit: 51 })).status).toBe(400);
    expect((await search({ query: 'x', object: 'person' })).status).toBe(400);
    expect((await t.request('/v1/search', { body: { query: 'x' } })).status).toBe(401);
    // A query with no words is valid and matches nothing.
    expect((await search({ query: '!!!' })).body).toEqual({
      records: [],
      facts: [],
      interactions: [],
    });
  });
});

describe('GET /v1/records/:id/context', () => {
  const context = (id: string, query = '', key = keys.agent) =>
    t.request(`/v1/records/${id}/context${query}`, { key });

  it('packs values with provenance, open tasks, facts and recent interactions', async () => {
    const tag = word();
    const email = `${tag}@acme.test`;
    const noa = await create('person', { name: 'Noa Shapira', emails: email });
    const patch = await t.request(`/v1/records/${noa}`, {
      key: keys.user,
      method: 'PATCH',
      body: { values: { jobTitle: 'Head of Data' } },
    });
    expect(patch.status).toBe(200);

    const later = await create('task', {
      title: 'Later',
      status: 'todo',
      dueDate: '2026-12-01',
      person: noa,
    });
    const undated = await create('task', { title: 'Undated', status: 'in_progress', person: noa });
    const soon = await create('task', {
      title: 'Soon',
      status: 'todo',
      dueDate: '2026-11-04',
      person: noa,
    });
    await create('task', { title: 'Finished', status: 'done', dueDate: '2026-10-01', person: noa });
    await create('task', { title: 'Unrelated', status: 'todo' });

    const demo = await logInteraction({
      kind: 'meeting',
      occurredAt: '2026-10-21T09:00:00Z',
      title: 'Demo',
      summary: 'Showed the data platform.',
      participants: [{ handle: email }],
    });
    const followUp = await logInteraction({
      occurredAt: '2026-10-25T09:00:00Z',
      title: 'Follow-up',
      participants: [{ handle: email }],
    });
    const sso = await rememberFact(noa, 'Needs SSO before agreeing to a pilot', demo);
    // Uncited: its note interaction is not listed again under interactions.
    const budget = await rememberFact(noa, 'Budget is approved for Q1');

    const res = await context(noa);
    expect(res.status).toBe(200);
    const pack = res.body;
    expect(pack.record).toEqual({
      id: noa,
      object: 'person',
      label: 'Noa Shapira',
      fields: {
        name: {
          value: { first: 'Noa', last: 'Shapira' },
          writtenBy: { type: 'agent', id: 'inbox' },
          observedAt: expect.any(String),
        },
        emails: {
          value: { primary: email, additional: [] },
          writtenBy: { type: 'agent', id: 'inbox' },
          observedAt: expect.any(String),
        },
        jobTitle: {
          value: 'Head of Data',
          writtenBy: { type: 'user', id: 'maya' },
          observedAt: expect.any(String),
        },
      },
    });
    expect(pack.openTasks).toEqual([
      { id: soon, title: 'Soon', status: 'todo', dueDate: '2026-11-04' },
      { id: later, title: 'Later', status: 'todo', dueDate: '2026-12-01' },
      { id: undated, title: 'Undated', status: 'in_progress', dueDate: null },
    ]);
    expect(pack.facts).toEqual([
      {
        id: budget,
        content: 'Budget is approved for Q1',
        validFrom: expect.any(String),
        writtenBy: { type: 'agent', id: 'inbox' },
        sources: [expect.any(String)],
      },
      {
        id: sso,
        content: 'Needs SSO before agreeing to a pilot',
        validFrom: '2026-10-21T09:00:00.000Z',
        writtenBy: { type: 'agent', id: 'inbox' },
        sources: [demo],
      },
    ]);
    expect(pack.recentInteractions).toEqual([
      {
        id: followUp,
        kind: 'call',
        occurredAt: '2026-10-25T09:00:00.000Z',
        title: 'Follow-up',
        summary: null,
      },
      {
        id: demo,
        kind: 'meeting',
        occurredAt: '2026-10-21T09:00:00.000Z',
        title: 'Demo',
        summary: 'Showed the data platform.',
      },
    ]);
    expect(pack.omitted).toEqual({ openTasks: 0, facts: 0, recentInteractions: 0 });
    expect(pack.tokenEstimate).toBe(
      Math.ceil(JSON.stringify({ ...pack, tokenEstimate: undefined }).length / 4),
    );
    expect(pack.tokenEstimate).toBeLessThanOrEqual(2000);
  });

  it('fits the sections to the budget, always keeping the values, and counts what it left out', async () => {
    const company = await create('company', { name: `Budget ${word()}` });
    for (let i = 0; i < 3; i++) {
      await create('task', { title: `Task ${i} ${'x'.repeat(600)}`, status: 'todo', company });
    }
    await rememberFact(company, `A fact ${'y'.repeat(200)}`);

    const tiny = await context(company, '?tokenBudget=1');
    expect(tiny.status).toBe(200);
    expect(tiny.body.record.fields.name).toBeDefined();
    expect(tiny.body).toMatchObject({
      openTasks: [],
      facts: [],
      recentInteractions: [],
      omitted: { openTasks: 3, facts: 1, recentInteractions: 0 },
    });

    // Room for two tasks and the fact: the third task does not fit, and the
    // section after it still gets the rest.
    const full = await context(company);
    const head = Math.ceil(JSON.stringify(full.body.record).length / 4);
    const task = Math.ceil(JSON.stringify(full.body.openTasks[0]).length / 4);
    const fact = Math.ceil(JSON.stringify(full.body.facts[0]).length / 4);
    const some = await context(company, `?tokenBudget=${head + 2 * task + fact + 5}`);
    expect(some.body.openTasks).toHaveLength(2);
    expect(some.body.facts).toHaveLength(1);
    expect(some.body.omitted).toEqual({ openTasks: 1, facts: 0, recentInteractions: 0 });
  });

  it('refuses deleted, unknown and foreign records', async () => {
    const company = await create('company', { name: `Deleted ${word()}` });
    expect(
      (await t.request(`/v1/records/${company}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    const deleted = await context(company);
    expect(deleted.status).toBe(404);
    expect(deleted.body.error.code).toBe('record_deleted');

    const unknown = await context('00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);

    const mine = await create('company', { name: `Mine ${word()}` });
    expect((await context(mine, '', otherKey)).status).toBe(404);
  });

  it('validates tokenBudget', async () => {
    const company = await create('company', { name: `Valid ${word()}` });
    for (const bad of ['0', '16001', 'abc', '1.5']) {
      const res = await context(company, `?tokenBudget=${bad}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await context(company, '?tokenBudget=16000')).status).toBe(200);
  });
});
