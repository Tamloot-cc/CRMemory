import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revokeApiKey } from '../../src/auth/keys.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { attachedEventPage } from '../../src/memory/events.js';
import { withRead } from '../../src/records/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let db: TestDatabase, t: TestApp, keys: Record<'user' | 'agent' | 'reader' | 'other', string>;
beforeEach(async () => {
  db = await createTestDatabase();
  t = startTestApp(db);
  const first = await t.setupWorkspace(
    { name: 'Web' },
    {
      user: { actor: { type: 'user', id: 'dana' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'bot' }, scopes: ['read', 'write', 'schema:write'] },
      reader: { actor: { type: 'user', id: 'reader' }, scopes: ['read'] },
    },
  );
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { other: { actor: { type: 'user', id: 'other' }, scopes: ['admin'] } },
  );
  keys = { ...first.keys, ...other.keys };
});
afterEach(async () => {
  await db?.drop();
});
const create = (values: Record<string, unknown>, key = keys.user) =>
  t.request('/v1/objects/person/records', { key, body: { values } });
async function pending(count = 3) {
  const record = (await create({ name: 'Dana', jobTitle: 'CTO' })).body.record;
  for (let i = 0; i < count; i++)
    await t.request(`/v1/records/${record.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: `Proposal ${i}` } },
    });
  return record;
}
describe('web session', () => {
  it('sets a protected cookie, returns the actor, checks CSRF and clears the session', async () => {
    expect((await t.request('/auth/session', { body: { key: keys.user } })).status).toBe(403);
    const login = await t.request('/auth/session', {
      body: { key: keys.user },
      headers: { 'X-Retainer-Client': 'web' },
    });
    expect(login.status).toBe(200);
    expect(login.body.actor).toEqual({ type: 'user', id: 'dana' });
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('Secure');
    const secureLogin = await t.request('https://retainer.test/auth/session', {
      body: { key: keys.user },
      headers: { 'X-Retainer-Client': 'web' },
    });
    expect(secureLogin.headers.get('set-cookie')).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    const cookie = setCookie.split(';')[0] ?? '';
    expect((await t.request('/v1/me', { headers: { cookie } })).body.workspace.name).toBe('Web');
    expect(
      (await t.request('/v1/objects/person/query', { body: {}, headers: { cookie } })).status,
    ).toBe(403);
    expect(
      (
        await t.request('/v1/objects/person/query', {
          body: {},
          headers: { cookie, 'X-Retainer-Client': 'web' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.request('/v1/objects/person/query', {
          body: {},
          headers: { cookie, 'X-Retainer-Client': 'web', origin: 'https://evil.test' },
        })
      ).status,
    ).toBe(403);
    const logout = await t.request('/auth/session', {
      method: 'DELETE',
      headers: { 'X-Retainer-Client': 'web', cookie },
    });
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('keeps bearer precedence, scopes, revocation and MCP CSRF enforcement', async () => {
    const cookie = `retainer_session=${keys.user}`;
    expect(
      (await t.request('/v1/me', { key: keys.other, headers: { cookie } })).body.workspace.name,
    ).toBe('Other');
    expect(
      (await t.request('/v1/me', { headers: { cookie, authorization: 'invalid' } })).status,
    ).toBe(401);
    expect((await create({ name: 'Blocked' }, keys.reader)).status).toBe(403);
    expect(
      (await t.request('/mcp', { method: 'POST', headers: { cookie }, body: {} })).status,
    ).toBe(403);
    const [key] = await db.owner<
      { id: string }[]
    >`select id from api_keys where actor ->> 'id' = 'dana'`;
    if (!key) throw new Error('Missing test key');
    await revokeApiKey(db.owner, key.id);
    expect((await t.request('/v1/me', { headers: { cookie } })).status).toBe(401);
  });
});
describe('web read contracts', () => {
  it('pages pending assertions without skipping when a reviewed row disappears, and supports off-page links', async () => {
    await pending();
    const first = await t.request('/v1/review?limit=1', { key: keys.user });
    expect(first.body.totals.pendingAssertions).toBe(3);
    const id = first.body.pendingAssertions[0].id;
    expect(first.body.nextCursors.pendingAssertions).toBeTruthy();
    await t.request(`/v1/assertions/${id}/reject`, { key: keys.user, method: 'POST' });
    const next = await t.request(
      `/v1/review?limit=1&pendingAssertionsCursor=${first.body.nextCursors.pendingAssertions}`,
      { key: keys.user },
    );
    expect(next.body.totals.pendingAssertions).toBe(2);
    expect(next.body.pendingAssertions[0].id).not.toBe(id);
    const third = await t.request(
      `/v1/review?limit=1&pendingAssertionsCursor=${next.body.nextCursors.pendingAssertions}`,
      { key: keys.user },
    );
    expect(third.body.pendingAssertions).toHaveLength(1);
    expect(third.body.pendingAssertions[0].id).not.toBe(next.body.pendingAssertions[0].id);
    const direct = await t.request(`/v1/assertions/${third.body.pendingAssertions[0].id}`, {
      key: keys.user,
    });
    expect(direct.body.status).toBe('pending_review');
    expect((await t.request(`/v1/assertions/${id}`, { key: keys.other })).status).toBe(404);
    expect(
      (await t.request('/v1/review?pendingAssertionsCursor=invalid', { key: keys.user })).status,
    ).toBe(400);
  });
  it('returns winning provenance, source details, all assertion statuses and relation labels under RLS', async () => {
    const company = (
      await t.request('/v1/objects/company/records', {
        key: keys.user,
        body: { values: { name: 'Acme' } },
      })
    ).body.record;
    const record = (await create({ name: 'Dana', company: company.id })).body.record;
    const event = (
      await t.request('/v1/events', {
        key: keys.agent,
        body: {
          type: 'meeting',
          channel: 'zoom',
          occurredAt: '2026-10-20T10:00:00Z',
          title: 'Review meeting',
          summary: 'A meeting',
          participants: [{ recordId: record.id }],
        },
      })
    ).body;
    await t.request(`/v1/records/${record.id}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'CTO' }, source: event.id },
    });
    const read = await t.request(`/v1/records/${record.id}?include=provenance,relationReferences`, {
      key: keys.user,
    });
    expect(read.body.provenance.jobTitle.assertion).toMatchObject({
      sourceRecordId: event.id,
      isInitial: false,
      source: {
        id: event.id,
        type: 'meeting',
        title: 'Review meeting',
        occurredAt: '2026-10-20T10:00:00.000Z',
      },
    });
    expect(read.body.relationReferences[company.id].label).toBe('Acme');
    const list = await t.request('/v1/objects/person/query', {
      key: keys.user,
      body: { include: ['relationReferences'] },
    });
    expect(list.body.relationReferences[company.id].label).toBe('Acme');
    const history = await t.request(`/v1/records/${record.id}/assertions?field=jobTitle&limit=1`, {
      key: keys.user,
    });
    expect(history.body.items).toHaveLength(1);
    const events = (await t.request(`/v1/records/${record.id}/events`, { key: keys.user })).body;
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({
      id: event.id,
      object: 'meeting',
      via: { kind: 'participant' },
      event: { title: 'Review meeting', summary: 'A meeting' },
    });
    // The claims an event supports: values on other records that cite it.
    const claims = (await t.request(`/v1/events/${event.id}/claims`, { key: keys.user })).body;
    expect(
      claims.assertions
        .filter((a: { isInitial: boolean }) => !a.isInitial)
        .map((a: { recordId: string; field: string }) => [a.recordId, a.field]),
    ).toEqual([[record.id, 'jobTitle']]);
    for (const path of [
      `/v1/records/${record.id}?include=provenance`,
      `/v1/records/${record.id}/assertions`,
      `/v1/records/${record.id}/facts`,
      `/v1/records/${record.id}/events`,
      `/v1/events/${event.id}/claims`,
    ])
      expect((await t.request(path, { key: keys.other })).status).toBe(404);
  });
  it('returns independent outcomes when reviewers compete and acceptance preserves newer human values', async () => {
    const record = await pending(1);
    const queue = (await t.request('/v1/review', { key: keys.user })).body;
    await t.request(`/v1/records/${record.id}`, {
      method: 'PATCH',
      key: keys.user,
      body: { values: { jobTitle: 'President' } },
    });
    const id = queue.pendingAssertions[0].id;
    const results = await Promise.all(
      ['accept', 'reject'].map((decision) =>
        t.request(`/v1/assertions/${id}/${decision}`, { key: keys.user, method: 'POST' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await t.request(`/v1/records/${record.id}`, { key: keys.user })).body.fields.jobTitle,
    ).toBe('President');
    const history = (await t.request(`/v1/records/${record.id}/assertions`, { key: keys.user }))
      .body.items;
    expect(history.find((a: any) => a.id === id).reviewedBy).toEqual({ type: 'user', id: 'dana' });
  });
  it('paginates facts and schema changes with totals', async () => {
    const record = (await create({ name: 'Dana' })).body.record;
    for (let i = 0; i < 3; i++)
      await t.request(`/v1/records/${record.id}/facts`, {
        key: keys.agent,
        body: { text: `Fact ${i}` },
      });
    const first = (await t.request(`/v1/records/${record.id}/facts?limit=1`, { key: keys.user }))
      .body;
    const next = (
      await t.request(`/v1/records/${record.id}/facts?limit=1&cursor=${first.nextCursor}`, {
        key: keys.user,
      })
    ).body;
    expect(next.facts[0].id).not.toBe(first.facts[0].id);
    for (let i = 0; i < 2; i++)
      await t.request('/v1/schema/changes', {
        key: keys.agent,
        body: {
          operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
          reason: `Change ${i}`,
        },
      });
    const changes = (
      await t.request('/v1/schema/changes?limit=1&status=proposed', { key: keys.user })
    ).body;
    expect(changes.total).toBe(2);
    expect(changes.nextCursor).toBeTruthy();
    const nextChanges = (
      await t.request(`/v1/schema/changes?limit=1&status=proposed&cursor=${changes.nextCursor}`, {
        key: keys.user,
      })
    ).body;
    expect(nextChanges.changes[0].id).not.toBe(changes.changes[0].id);
  });
});

it('searches labels within one object under RLS even when the label field is not filterable', async () => {
  await create({ name: 'Dana Levi' });
  await create({ name: 'Other person' });
  await t.request('/v1/objects/company/records', {
    key: keys.user,
    body: { values: { name: 'Dana Company' } },
  });
  await create({ name: 'Dana in another workspace' }, keys.other);
  const found = await t.request('/v1/objects/person/query', {
    key: keys.user,
    body: { search: 'Dana' },
  });
  expect(found.status).toBe(200);
  expect(found.body.records.map((r: any) => r.label)).toEqual(['Dana Levi']);
  const combined = await t.request('/v1/objects/person/query', {
    key: keys.user,
    body: { search: 'Dana', filter: { jobTitle: { eq: 'CEO' } } },
  });
  expect(combined.body.records).toHaveLength(0);
});

it('uses a configured external origin behind TLS proxies without trusting forwarded headers', async () => {
  const proxied = startTestApp(db, { publicOrigin: 'https://retainer.example/' });
  const headers = {
    'X-Retainer-Client': 'web',
    origin: 'https://retainer.example',
    'x-forwarded-proto': 'http',
    'x-forwarded-host': 'attacker.example',
  };
  const login = await proxied.request('http://localhost/auth/session', {
    body: { key: keys.user },
    headers,
  });
  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toContain('Secure');
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(
    (
      await proxied.request('http://localhost/v1/objects/person/query', {
        body: {},
        headers: { ...headers, cookie },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await proxied.request('http://localhost/auth/session', {
        body: { key: keys.user },
        headers: {
          ...headers,
          origin: 'https://attacker.example',
          'x-forwarded-host': 'retainer.example',
          'x-forwarded-proto': 'https',
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await proxied.request('http://localhost/v1/objects/person/query', {
        body: {},
        headers: { ...headers, cookie, origin: 'http://localhost' },
      })
    ).status,
  ).toBe(403);
  const mcp = await proxied.app.request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      ...headers,
      cookie,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'proxy-test', version: '1' },
      },
    }),
  });
  expect(mcp.status).toBe(200);
  await mcp.text();
  expect(
    (
      await proxied.request('http://localhost/auth/session', {
        method: 'DELETE',
        headers: { ...headers, cookie },
      })
    ).status,
  ).toBe(200);
});

it('keeps historical facts in event claims while record memory only lists current facts', async () => {
  const record = (await create({ name: 'Dana' })).body.record;
  const source = (
    await t.request('/v1/events', {
      key: keys.agent,
      body: {
        type: 'meeting',
        channel: 'test',
        occurredAt: '2026-10-20T10:00:00Z',
        title: 'Source',
      },
    })
  ).body;
  const ids: string[] = [];
  for (const text of ['Retracted', 'Ended', 'Superseded', 'Current'])
    ids.push(
      (
        await t.request(`/v1/records/${record.id}/facts`, {
          key: keys.agent,
          body: { text, source: source.id, quote: `Quote: ${text}` },
        })
      ).body.fact.id,
    );
  await t.request(`/v1/facts/${ids[0]}`, { key: keys.user, method: 'DELETE' });
  // Seed the two historical states written by consolidation in a migrated test DB.
  await db.owner`update facts set valid_to = '2026-10-21T10:00:00Z' where id = ${ids[1] as string}`;
  await db.owner`update facts set superseded_by = ${ids[3] as string} where id = ${ids[2] as string}`;
  const current = (await t.request(`/v1/records/${record.id}/facts`, { key: keys.user })).body;
  expect(current.facts.map((f: any) => f.content)).toEqual(['Current']);
  const claims = (await t.request(`/v1/events/${source.id}/claims`, { key: keys.user })).body;
  expect(Object.fromEntries(claims.facts.map((f: any) => [f.content, f.status]))).toEqual({
    Retracted: 'retracted',
    Ended: 'ended',
    Superseded: 'superseded',
    Current: 'current',
  });
  expect(claims.facts.find((f: any) => f.content === 'Retracted').sources[0].quote).toBe(
    'Quote: Retracted',
  );
  const first = (await t.request(`/v1/events/${source.id}/claims?limit=1`, { key: keys.user }))
    .body;
  const second = (
    await t.request(
      `/v1/events/${source.id}/claims?limit=1&factsCursor=${first.nextCursors.facts}`,
      { key: keys.user },
    )
  ).body;
  expect(second.facts[0].id).not.toBe(first.facts[0].id);
  expect((await t.request(`/v1/events/${source.id}/claims`, { key: keys.other })).status).toBe(404);
});

it('hydrates event pages in a bounded number of real database queries', async () => {
  const record = (await create({ name: 'Dana' })).body.record;
  for (let i = 0; i < 20; i++)
    await t.request('/v1/events', {
      key: keys.agent,
      body: {
        type: 'meeting',
        channel: 'test',
        occurredAt: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
        title: `Meeting ${i}`,
        participants: [
          { recordId: record.id, role: 'subject' },
          { handle: 'missing@example.test', role: 'guest' },
        ],
      },
    });
  const me = (await t.request('/v1/me', { key: keys.user })).body;
  let statements = 0;
  const sql = postgres(db.url, {
    connection: { role: RUNTIME_ROLE },
    onnotice: false,
    debug: () => {
      statements++;
    },
  });
  const caller = { workspaceId: me.workspace.id, actor: me.actor, scopes: ['read'] as const };
  const read = (limit: number) =>
    withRead(sql, caller, (tx, schema) =>
      attachedEventPage(tx, schema, caller.workspaceId, record.id, limit),
    );
  try {
    await read(1);
    statements = 0;
    await read(1);
    const one = statements;
    statements = 0;
    const all = await read(20);
    expect(statements).toBe(one);
    // The transaction, the page, then one read each for event columns, links,
    // live link targets and relation references in both directions.
    expect(statements).toBeLessThanOrEqual(10);
    expect(all.items).toHaveLength(20);
    expect(all.items[0]?.event.title).toBe('Meeting 19');
    expect(all.items[0]?.via).toEqual({ kind: 'participant' });
    expect(all.items[0]?.event.participants).toMatchObject({
      matched: [{ recordId: record.id, role: 'subject' }],
      unmatched: [{ handle: 'missing@example.test', reason: 'no_match' }],
    });
  } finally {
    await sql.end();
  }
});

describe('GET /v1/records/:id/events', () => {
  const logEvent = async (body: Record<string, unknown>) => {
    const res = await t.request('/v1/events', {
      key: keys.agent,
      body: { type: 'call', channel: 'test', ...body },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const page = async (id: string, query = '', key = keys.user) =>
    t.request(`/v1/records/${id}/events${query}`, { key });

  it('lists attached events newest first, once each, with how they are attached', async () => {
    const change = await t.request('/v1/schema/changes', {
      key: keys.user,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'call',
            field: {
              name: 'account',
              label: 'Account',
              type: 'relation',
              settings: { targetObject: 'company', inverseField: 'accountCalls' },
            },
          },
        ],
      },
    });
    expect(change.body.status).toBe('applied');
    const company = (
      await t.request('/v1/objects/company/records', {
        key: keys.user,
        body: { values: { name: 'Acme' } },
      })
    ).body.record.id as string;
    const dana = (await create({ name: 'Dana', emails: 'dana@acme.test' })).body.record
      .id as string;

    const participant = await logEvent({
      occurredAt: '2026-10-04T10:00:00Z',
      participants: [{ handle: 'dana@acme.test' }],
      about: [dana, company],
      fields: { account: company },
    });
    const about = await logEvent({ occurredAt: '2026-10-03T10:00:00Z', about: [dana] });
    const field = await logEvent({
      occurredAt: '2026-10-02T10:00:00Z',
      fields: { account: company },
    });
    const deleted = await logEvent({ occurredAt: '2026-10-01T10:00:00Z', about: [dana] });
    await t.request(`/v1/events/${deleted}`, { key: keys.agent, method: 'DELETE' });
    // The note behind an uncited fact is never listed.
    await t.request(`/v1/records/${dana}/facts`, { key: keys.agent, body: { text: 'Uncited' } });
    await t.request(`/v1/records/${company}/facts`, { key: keys.agent, body: { text: 'Uncited' } });

    const via = async (id: string, query = '') =>
      ((await page(id, query)).body.items as { id: string; via: unknown }[]).map((e) => [
        e.id,
        e.via,
      ]);
    expect(await via(dana)).toEqual([
      [participant, { kind: 'participant' }],
      [about, { kind: 'about' }],
    ]);
    expect(await via(company)).toEqual([
      [participant, { kind: 'about' }],
      [field, { kind: 'field', field: 'account' }],
    ]);
    // A record is linked once: as a participant, its about link was dropped.
    expect(await via(dana, '?link=about')).toEqual([[about, { kind: 'about' }]]);
    expect(await via(dana, '?link=participant')).toEqual([[participant, { kind: 'participant' }]]);
    expect(await via(company, '?link=field')).toEqual([
      [participant, { kind: 'field', field: 'account' }],
      [field, { kind: 'field', field: 'account' }],
    ]);

    const full = (await page(company, '?limit=1')).body;
    expect(full.items[0]).toMatchObject({
      id: participant,
      object: 'call',
      fields: { account: company },
      event: {
        occurredAt: '2026-10-04T10:00:00.000Z',
        channel: 'test',
        externalId: null,
        participants: { matched: [{ recordId: dana }], unmatched: [] },
        about: [company],
      },
    });
    const next = (await page(company, `?limit=1&cursor=${full.nextCursor}`)).body;
    expect(next.items.map((e: { id: string }) => e.id)).toEqual([field]);
    expect(next.nextCursor).toBeNull();

    expect((await page(dana, '?link=rollup')).status).toBe(400);
    expect((await page(dana, '?cursor=invalid')).status).toBe(400);
    expect((await page(dana, '', keys.other)).status).toBe(404);
    expect((await page(dana, '', keys.reader)).status).toBe(200);
  });

  it("lists an event's initial values beside the claims on other records", async () => {
    const dana = (await create({ name: 'Dana' })).body.record.id as string;
    const event = await logEvent({
      type: 'meeting',
      occurredAt: '2026-10-04T10:00:00Z',
      title: 'Kickoff',
    });
    await t.request(`/v1/records/${dana}`, {
      method: 'PATCH',
      key: keys.agent,
      body: { values: { jobTitle: 'CTO' }, source: event },
    });
    const claims = (await t.request(`/v1/events/${event}/claims`, { key: keys.user })).body;
    expect(
      claims.assertions
        .map((a: { recordId: string; field: string; isInitial: boolean }) => [
          a.recordId === event ? 'event' : 'dana',
          a.field,
          a.isInitial,
        ])
        .sort(),
    ).toEqual([
      ['dana', 'jobTitle', false],
      ['event', 'title', true],
    ]);
    // An entity has no claims to list.
    expect((await t.request(`/v1/events/${dana}/claims`, { key: keys.user })).status).toBe(404);
  });
});
