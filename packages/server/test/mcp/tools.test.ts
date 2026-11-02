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

const STEP_2_TOOLS = [
  'apply_template',
  'describe_schema',
  'get_record',
  'list_templates',
  'propose_schema_change',
  'query_records',
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

  it('lists the step 2 tools, none of which takes a workspace', async () => {
    const { tools } = await agent.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(STEP_2_TOOLS);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('workspace');
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('actor');
    }
  });

  it('gives agents instructions that start from describe_schema', () => {
    expect(agent.getInstructions()).toContain('describe_schema');
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
