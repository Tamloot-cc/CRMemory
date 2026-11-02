import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type McpTestClient, startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let agent: McpTestClient;
let agent2: McpTestClient;
let user: McpTestClient;
let reader: McpTestClient;
let outsider: McpTestClient;
let fresh: McpTestClient;
let salesAgentKey: string;
const clients: McpTestClient[] = [];

const TOOLS = [
  'apply_template',
  'describe_schema',
  'get_context',
  'get_record',
  'list_templates',
  'log_interaction',
  'propose_schema_change',
  'query_records',
  'remember',
  'search',
  'upsert_record',
];

beforeAll(async () => {
  t = startTestApp(db);
  const sales = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: {
        actor: { type: 'agent', id: 'inbox', name: 'Inbox agent' },
        scopes: ['read', 'write', 'schema:write'],
      },
      agent2: { actor: { type: 'agent', id: 'calendar' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'agent', id: 'reader' }, scopes: ['read'] },
    },
  );
  salesAgentKey = sales.keys.agent;
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { agent: { actor: { type: 'agent', id: 'other' }, scopes: ['read', 'write'] } },
  );
  const blank = await t.setupWorkspace(
    { name: 'Yael Realty' },
    { agent: { actor: { type: 'agent', id: 'setup' }, scopes: ['read', 'write', 'schema:write'] } },
  );
  for (const [key, assign] of [
    [sales.keys.agent, (c: McpTestClient) => (agent = c)],
    [sales.keys.agent2, (c: McpTestClient) => (agent2 = c)],
    [sales.keys.user, (c: McpTestClient) => (user = c)],
    [sales.keys.reader, (c: McpTestClient) => (reader = c)],
    [other.keys.agent, (c: McpTestClient) => (outsider = c)],
    [blank.keys.agent, (c: McpTestClient) => (fresh = c)],
  ] as const) {
    const client = await t.mcpClient(key);
    clients.push(client);
    assign(client);
  }
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

let n = 0;
const email = () => `mcp${++n}@acme.test`;

const createPerson = async (values: Record<string, unknown> = {}) => {
  const res = await agent.call('upsert_record', {
    object: 'person',
    values: { name: { first: 'Dana', last: 'Levi' }, emails: email(), ...values },
  });
  expect(res.isError).toBe(false);
  return res.body as { id: string; record: { fields: Record<string, unknown> } };
};

describe('connecting', () => {
  it('rejects a request without an API key', async () => {
    const res = await t.request('/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects an unknown API key', async () => {
    const res = await t.request('/mcp', {
      key: 'rtn_not_a_real_key',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.status).toBe(401);
  });

  it('serves clients that still speak the 2025 protocol', async () => {
    const post = async (body: unknown) => {
      const res = await t.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${salesAgentKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const data = text.split('\n').find((line) => line.startsWith('data: ')) ?? text;
      return JSON.parse(data.replace(/^data: /, ''));
    };
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'older-client', version: '1.0.0' },
      },
    });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const call = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'describe_schema', arguments: {} },
    });
    expect(JSON.parse(call.result.content[0].text).workspace.name).toBe('Acme Sales');
  });

  it('lists the tools, none of which takes a workspace', async () => {
    const { tools } = await agent.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('workspace');
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('actor');
    }
  });

  it('gives agents instructions that start from describe_schema', () => {
    expect(agent.getInstructions()).toContain('describe_schema');
  });

  it('spells out the memory workflow: log the interaction first, then cite it (4.1)', async () => {
    const instructions = agent.getInstructions() ?? '';
    const log = instructions.indexOf('1. log_interaction');
    expect(log).toBeGreaterThan(-1);
    expect(instructions.indexOf('2. upsert_record with source')).toBeGreaterThan(log);
    expect(instructions.indexOf('3. remember')).toBeGreaterThan(log);
    const { tools } = await agent.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('upsert_record')?.inputSchema.properties).toHaveProperty('source');
    expect(byName.get('upsert_record')?.description).toContain('log_interaction');
    expect(byName.get('remember')?.description).toContain('log_interaction');
    expect(byName.get('log_interaction')?.description).toContain('source');
  });
});

describe('describe_schema, list_templates and apply_template', () => {
  it('shows a new workspace as not initialized, then applies a template', async () => {
    const before = await fresh.call('describe_schema');
    expect(before.isError).toBe(false);
    expect(before.body.workspace).toMatchObject({
      name: 'Yael Realty',
      initialized: false,
      templates: [],
    });
    expect(before.body.objects.map((o: { nameSingular: string }) => o.nameSingular).sort()).toEqual(
      ['company', 'person', 'task'],
    );

    const list = await fresh.call('list_templates');
    const realEstate = list.body.templates.find((x: { name: string }) => x.name === 'real_estate');
    expect(realEstate).toMatchObject({ applied: false });
    expect(realEstate.adds.objects.map((o: { name: string }) => o.name).sort()).toEqual([
      'property',
      'viewing',
    ]);

    const applied = await fresh.call('apply_template', { name: 'real_estate' });
    expect(applied.isError).toBe(false);
    expect(applied.body).toMatchObject({ status: 'applied', alreadyApplied: false });

    const again = await fresh.call('apply_template', { name: 'real_estate' });
    expect(again.body).toMatchObject({ status: 'unchanged', alreadyApplied: true });

    const after = await fresh.call('describe_schema');
    expect(after.body.workspace.initialized).toBe(true);
    expect(after.body.workspace.schemaVersion).toBeGreaterThan(before.body.workspace.schemaVersion);
    expect(after.body.objects.map((o: { nameSingular: string }) => o.nameSingular)).toContain(
      'viewing',
    );
  });

  it('names the templates when one is unknown', async () => {
    const res = await fresh.call('apply_template', { name: 'dentist' });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.details.templates).toContain('sales');
  });

  it('returns the same description as GET /v1/schema', async () => {
    const mcp = await agent.call('describe_schema');
    const rest = await t.request('/v1/schema', { key: salesAgentKey });
    expect(mcp.body).toEqual(rest.body);
  });
});

describe('upsert_record', () => {
  it('creates a record attributed to the key, never to the payload', async () => {
    const res = await agent.call('upsert_record', {
      object: 'person',
      values: { name: { first: 'Ron', last: 'Peretz' }, emails: email() },
    });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({
      created: true,
      fields: { name: 'applied', emails: 'applied' },
      record: { createdBy: { type: 'agent', id: 'inbox', name: 'Inbox agent' } },
    });
  });

  it('rejects an actor smuggled into the arguments', async () => {
    const res = await agent.call('upsert_record', {
      object: 'person',
      values: { emails: email() },
      actor: { type: 'user', id: 'maya' },
    });
    expect(res.isError).toBe(true);
  });

  it('updates by match and fails on a miss unless ifMissing is "create"', async () => {
    const person = await createPerson();
    const address = (await agent.call('get_record', { id: person.id })).body.fields.emails
      .primary as string;

    const updated = await agent.call('upsert_record', {
      object: 'person',
      match: { emails: address },
      values: { address: { street1: '12 Rothschild Blvd', city: 'Tel Aviv', country: 'IL' } },
    });
    expect(updated.body).toMatchObject({
      id: person.id,
      created: false,
      fields: { address: 'applied' },
    });

    const missing = email();
    const miss = await agent.call('upsert_record', {
      object: 'person',
      match: { emails: missing },
      values: { jobTitle: 'COO' },
    });
    expect(miss.isError).toBe(true);
    expect(miss.body.error).toMatchObject({ code: 'not_found' });
    expect(miss.body.error.message).toContain('ifMissing: "create"');

    const created = await agent.call('upsert_record', {
      object: 'person',
      match: { emails: missing },
      ifMissing: 'create',
      values: { jobTitle: 'COO' },
    });
    expect(created.body).toMatchObject({
      created: true,
      fields: { emails: 'applied', jobTitle: 'applied' },
    });
  });

  it('rejects a match on phones and points to query_records', async () => {
    const res = await agent.call('upsert_record', {
      object: 'person',
      match: { phones: '+972545550199' },
      values: {},
    });
    expect(res.isError).toBe(true);
    expect(res.body.error).toMatchObject({
      code: 'invalid_match',
      details: { field: 'phones', allowed: ['emails'] },
    });
    expect(res.body.error.message).toContain('query_records');
  });

  it('names the field and the allowed options on a validation error, and writes nothing', async () => {
    const deal = await agent.call('upsert_record', {
      object: 'deal',
      values: { name: 'Acme renewal', stage: 'negotiation' },
    });
    const bad = await agent.call('upsert_record', {
      object: 'deal',
      id: deal.body.id,
      values: { stage: 'closed_won', amount: { amountMicros: 52_000_000_000, currency: 'USD' } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatchObject({
      code: 'invalid_values',
      details: {
        errors: [
          {
            field: 'stage',
            message: 'expected one of the options',
            allowed: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
          },
        ],
      },
    });
    const unchanged = await agent.call('get_record', { id: deal.body.id });
    expect(unchanged.body.fields.amount).toBeUndefined();
    expect(unchanged.body.fields.stage).toBe('negotiation');

    const retry = await agent.call('upsert_record', {
      object: 'deal',
      id: deal.body.id,
      values: { stage: 'won', amount: { amountMicros: 52_000_000_000, currency: 'USD' } },
    });
    expect(retry.body.fields).toEqual({ stage: 'applied', amount: 'applied' });
  });

  it('holds an agent value that disagrees with a person as pending_review', async () => {
    const person = await createPerson();
    const set = await user.call('upsert_record', {
      object: 'person',
      id: person.id,
      values: { jobTitle: 'VP Operations' },
    });
    expect(set.body.fields).toEqual({ jobTitle: 'applied' });

    const res = await agent.call('upsert_record', {
      object: 'person',
      id: person.id,
      values: { jobTitle: 'COO' },
    });
    expect(res.isError).toBe(false);
    expect(res.body.fields).toEqual({ jobTitle: 'pending_review' });
    expect(res.body.record.fields.jobTitle).toBe('VP Operations');
  });

  it('replays a create with the same idempotency key', async () => {
    const args = {
      object: 'person',
      values: { name: { first: 'Noa', last: 'Shapira' }, emails: email() },
      idempotencyKey: `create-${n}`,
    };
    const first = await agent.call('upsert_record', args);
    const second = await agent.call('upsert_record', args);
    expect(first.body.created).toBe(true);
    expect(second.body).toEqual(first.body);
  });

  it('rejects an idempotency key on a write by id or match', async () => {
    const person = await createPerson();
    const res = await agent.call('upsert_record', {
      object: 'person',
      id: person.id,
      values: { jobTitle: 'CFO' },
      idempotencyKey: 'not-for-updates',
    });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('ends two concurrent creates of one email on one record', async () => {
    const shared = email();
    const write = (client: McpTestClient, values: Record<string, unknown>) =>
      client.call('upsert_record', {
        object: 'person',
        match: { emails: shared },
        ifMissing: 'create',
        values,
      });
    const results = await Promise.all([
      write(agent, { name: { first: 'Ron', last: 'Peretz' }, jobTitle: 'Procurement lead' }),
      write(agent2, { name: { first: 'Ron', last: 'Peretz' } }),
      write(agent, { jobTitle: 'Procurement lead' }),
      write(agent2, { jobTitle: 'Procurement' }),
    ]);
    for (const r of results) expect(r.isError).toBe(false);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.body.created)).toHaveLength(1);

    const found = await agent.call('query_records', {
      object: 'person',
      filter: { id: { eq: results[0]?.body.id } },
    });
    expect(found.body.records).toHaveLength(1);
  });
});

describe('query_records and get_record', () => {
  it('filters and reads records', async () => {
    const person = await createPerson({ jobTitle: 'Head of Data' });
    const res = await agent.call('query_records', {
      object: 'person',
      filter: { jobTitle: 'Head of Data' },
    });
    expect(res.isError).toBe(false);
    expect(res.body.records.map((r: { id: string }) => r.id)).toContain(person.id);

    const one = await agent.call('get_record', { id: person.id });
    expect(one.body).toMatchObject({ id: person.id, object: 'person', label: 'Dana Levi' });
  });

  it('reports a bad filter with the allowed operators', async () => {
    const res = await agent.call('query_records', {
      object: 'person',
      filter: { createdAt: { like: '2026' } },
    });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('invalid_filter');
    expect(res.body.error.details.allowed).toContain('gte');
  });

  it("does not show another workspace's records", async () => {
    const person = await createPerson();
    const res = await outsider.call('get_record', { id: person.id });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('not_found');
  });

  it('reports an unknown object', async () => {
    const res = await agent.call('query_records', { object: 'spaceship' });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('propose_schema_change', () => {
  it('applies an additive change and proposes a destructive one', async () => {
    const added = await agent.call('propose_schema_change', {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: {
            name: 'preferredLanguage',
            label: 'Preferred language',
            type: 'select',
            isFilterable: true,
            settings: {
              options: [
                { value: 'he', label: 'Hebrew' },
                { value: 'en', label: 'English' },
              ],
            },
          },
        },
      ],
      reason: 'Contacts state a preferred language in most calls.',
    });
    expect(added.isError).toBe(false);
    expect(added.body.status).toBe('applied');

    const write = await agent.call('upsert_record', {
      object: 'person',
      values: { emails: email(), preferredLanguage: 'he' },
    });
    expect(write.body.fields.preferredLanguage).toBe('applied');

    const removal = await agent.call('propose_schema_change', {
      operations: [{ op: 'delete_field', object: 'person', field: 'preferredLanguage' }],
      reason: 'No longer needed.',
    });
    expect(removal.isError).toBe(false);
    expect(removal.body.status).toBe('proposed');

    const schema = await agent.call('describe_schema');
    const person = schema.body.objects.find(
      (o: { nameSingular: string }) => o.nameSingular === 'person',
    );
    expect(person.fields.map((f: { name: string }) => f.name)).toContain('preferredLanguage');
  });

  it('reports an invalid change with its issues', async () => {
    const res = await agent.call('propose_schema_change', {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'emails', label: 'Emails again', type: 'text' },
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('schema_invalid');
  });
});

describe('scopes', () => {
  it('lets a read-only key read but not write', async () => {
    const read = await reader.call('describe_schema');
    expect(read.isError).toBe(false);

    const write = await reader.call('upsert_record', {
      object: 'person',
      values: { emails: email() },
    });
    expect(write.isError).toBe(true);
    expect(write.body.error).toMatchObject({ code: 'forbidden', details: { required: 'write' } });
  });

  it('needs schema:write for schema changes and templates', async () => {
    const change = await agent2.call('propose_schema_change', {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'nickname', label: 'Nickname', type: 'text' },
        },
      ],
    });
    expect(change.body.error).toMatchObject({
      code: 'forbidden',
      details: { required: 'schema:write' },
    });

    const template = await agent2.call('apply_template', { name: 'recruiting' });
    expect(template.body.error.code).toBe('forbidden');
  });
});

describe('the memory workflow (4.1): log_interaction, then cite it', () => {
  let external = 0;
  const logCall = async (args: Record<string, unknown> = {}, client = agent) =>
    client.call('log_interaction', {
      kind: 'call',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00+02:00',
      ...args,
    });

  it('logs an interaction and returns matched and unmatched participants (6.2)', async () => {
    const dana = await createPerson();
    const danaEmail = dana.record.fields.emails as { primary: string };
    const res = await logCall({
      externalId: `zoom-${++external}`,
      title: 'Acme renewal call',
      summary: 'Discussed the renewal.',
      participants: [
        { handle: danaEmail.primary, role: 'customer' },
        { handle: 'ron.peretz@acme.test', role: 'customer' },
        { handle: '+972 54 123 4567', role: 'customer' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.body).toEqual({
      id: expect.any(String),
      created: true,
      participants: {
        matched: [{ handle: danaEmail.primary, role: 'customer', recordId: dana.id }],
        unmatched: [
          { handle: 'ron.peretz@acme.test', role: 'customer', reason: 'no_match' },
          { handle: '+972541234567', role: 'customer', reason: 'phone_only' },
        ],
      },
    });
  });

  it('returns one interaction for concurrent calls with the same externalId', async () => {
    const args = { externalId: `zoom-${++external}`, title: 'Concurrent call' };
    const results = await Promise.all([
      logCall(args, agent),
      logCall(args, agent),
      logCall(args, agent2),
      logCall(args, agent2),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.body.created)).toHaveLength(1);

    const conflict = await logCall({ ...args, title: 'Edited title' });
    expect(conflict.isError).toBe(true);
    expect(conflict.body.error).toMatchObject({ code: 'interaction_conflict' });
  });

  it('cites the interaction in upsert_record, so an older email loses to a newer call', async () => {
    const dana = await createPerson();
    const call = await logCall({ occurredAt: '2026-10-28T10:00:00Z' });
    const mail = await logCall({
      kind: 'email',
      channel: 'gmail',
      occurredAt: '2026-09-01T10:00:00Z',
    });
    const fromCall = await agent.call('upsert_record', {
      object: 'person',
      id: dana.id,
      values: { jobTitle: 'VP Sales' },
      source: call.body.id,
    });
    expect(fromCall.body.fields).toEqual({ jobTitle: 'applied' });
    const fromMail = await agent2.call('upsert_record', {
      object: 'person',
      id: dana.id,
      values: { jobTitle: 'Sales Director' },
      source: mail.body.id,
    });
    expect(fromMail.body.fields).toEqual({ jobTitle: 'superseded' });
    expect(fromMail.body.record.fields.jobTitle).toBe('VP Sales');

    const created = await agent.call('upsert_record', {
      object: 'person',
      values: { emails: email() },
      source: call.body.id,
    });
    expect(created.body.created).toBe(true);

    const unknown = await agent.call('upsert_record', {
      object: 'person',
      id: dana.id,
      values: { jobTitle: 'CEO' },
      source: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error.code).toBe('invalid_source');
    expect(unknown.body.error.message).toContain('log_interaction');
  });

  it('remembers a fact citing the interaction (6.2)', async () => {
    const dana = await createPerson();
    const call = await logCall();
    const res = await agent.call('remember', {
      record: dana.id,
      text: 'Legal review at Acme usually takes two weeks.',
      source: call.body.id,
      quote: 'legal usually needs two weeks with these',
    });
    expect(res.isError).toBe(false);
    expect(res.body).toEqual({
      fact: {
        id: expect.any(String),
        record: dana.id,
        content: 'Legal review at Acme usually takes two weeks.',
        kind: 'stated',
        validFrom: '2026-10-29T12:00:00.000Z',
        validTo: null,
        writtenBy: { type: 'agent', id: 'inbox', name: 'Inbox agent' },
        sources: [{ interaction: call.body.id, quote: 'legal usually needs two weeks with these' }],
      },
      noteInteraction: null,
    });

    const note = await agent.call('remember', { record: dana.id, text: 'Prefers WhatsApp.' });
    expect(note.body.noteInteraction).toEqual(expect.any(String));
    expect(note.body.fact.sources).toEqual([
      { interaction: note.body.noteInteraction, quote: null },
    ]);
  });

  it('replays concurrent remember calls with the same idempotency key', async () => {
    const dana = await createPerson();
    const args = { record: dana.id, text: 'Budget approved for Q1.', idempotencyKey: 'mcp-fact-1' };
    const results = await Promise.all([
      agent.call('remember', args),
      agent.call('remember', args),
      agent.call('remember', args),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(new Set(results.map((r) => r.body.fact.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.noteInteraction)).size).toBe(1);
  });

  it('needs the write scope to log or remember', async () => {
    const dana = await createPerson();
    const logged = await logCall({}, reader);
    expect(logged.isError).toBe(true);
    expect(logged.body.error.code).toBe('forbidden');
    const remembered = await reader.call('remember', { record: dana.id, text: 'x' });
    expect(remembered.body.error.code).toBe('forbidden');
  });

  it("cannot cite or remember on another workspace's data", async () => {
    const dana = await createPerson();
    const theirs = await logCall({}, outsider);
    const res = await agent.call('remember', {
      record: dana.id,
      text: 'x',
      source: theirs.body.id,
    });
    expect(res.body.error.code).toBe('invalid_source');
    const foreign = await outsider.call('remember', { record: dana.id, text: 'x' });
    expect(foreign.body.error.code).toBe('not_found');
  });
});

describe('finding and reading a record (5): search, then get_context', () => {
  it('finds a misspelled name, then reads its values, facts and interactions', async () => {
    const dana = await createPerson({ name: 'Dana Mizrahi-Katz', jobTitle: 'CFO' });
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const call = await agent.call('log_interaction', {
      kind: 'call',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00+02:00',
      title: 'Budget planning',
      participants: [{ handle: danaEmail }],
    });
    await agent.call('remember', {
      record: dana.id,
      text: 'Signs off on anything above 50k.',
      source: call.body.id,
    });

    const found = await reader.call('search', { query: 'Dana Mizrahi-Kats' });
    expect(found.isError).toBe(false);
    expect(found.body.records).toEqual([
      { id: dana.id, object: 'person', label: 'Dana Mizrahi-Katz', match: 'similar_label' },
    ]);
    const byFact = await reader.call('search', { query: '"signs off" OR nothingmatches' });
    expect(byFact.body.facts).toMatchObject([{ record: dana.id }]);

    const pack = await reader.call('get_context', { record: dana.id, tokenBudget: 500 });
    expect(pack.isError).toBe(false);
    expect(pack.body.record.fields.jobTitle).toEqual({
      value: 'CFO',
      writtenBy: { type: 'agent', id: 'inbox', name: 'Inbox agent' },
      observedAt: expect.any(String),
    });
    expect(pack.body.facts).toMatchObject([
      { content: 'Signs off on anything above 50k.', sources: [call.body.id] },
    ]);
    expect(pack.body.recentInteractions).toMatchObject([{ id: call.body.id }]);
    expect(pack.body.tokenEstimate).toBeLessThanOrEqual(500);
  });

  it('names the problem in validation errors and stays in its workspace', async () => {
    const bad = await agent.call('get_context', { record: 'not-an-id' });
    expect(bad.isError).toBe(true);
    const tooBig = await agent.call('get_context', {
      record: '00000000-0000-4000-8000-000000000000',
      tokenBudget: 99_999,
    });
    expect(tooBig.isError).toBe(true);
    const dana = await createPerson({ name: 'Ofri Ben-Ami' });
    const foreign = await outsider.call('get_context', { record: dana.id });
    expect(foreign.body.error.code).toBe('not_found');
    const nothing = await outsider.call('search', { query: 'Ofri' });
    expect(nothing.body).toEqual({ records: [], facts: [], interactions: [] });
  });
});
