import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let t: TestApp;
let keys: Record<'agent' | 'reader', string>;
let otherKey: string;

beforeAll(async () => {
  t = startTestApp(backend);
  ({ keys } = await t.setupWorkspace(
    { name: 'Acme', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write', 'schema:write'] },
      reader: { actor: { type: 'user', id: 'viewer' }, scopes: ['read'] },
    },
  ));
  otherKey = (
    await t.setupWorkspace(
      { name: 'Other' },
      { agent: { actor: { type: 'agent', id: 'other' }, scopes: ['read'] } },
    )
  ).keys.agent;
  // Company ← person (cascade) ← task (cascade): two levels.
  const change = await t.request('/v1/schema/changes', {
    key: keys.agent,
    body: {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: {
            name: 'employer',
            label: 'Employer',
            type: 'relation',
            settings: { targetObject: 'company', inverseField: 'staff', onDelete: 'cascade' },
          },
        },
        {
          op: 'create_field',
          object: 'task',
          field: {
            name: 'owner',
            label: 'Owner',
            type: 'relation',
            settings: { targetObject: 'person', inverseField: 'ownedTasks', onDelete: 'cascade' },
          },
        },
      ],
    },
  });
  expect(change.body).toMatchObject({ status: 'applied' });
});

const create = async (object: string, values: Record<string, unknown>) => {
  const res = await t.request(`/v1/objects/${object}/records`, {
    key: keys.agent,
    body: { values },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

describe('GET /v1/records/:id/delete-impact', () => {
  it('counts what a delete would take with it, at any depth, and matches the delete', async () => {
    const acme = await create('company', { name: 'Acme' });
    const dana = await create('person', { name: 'Dana Levi', employer: acme });
    await create('person', { name: 'Avi Cohen', employer: acme });
    await create('person', { name: 'Unrelated' });
    await create('task', { title: 'Call back', owner: dana });

    const impact = await t.request(`/v1/records/${acme}/delete-impact`, { key: keys.reader });
    expect(impact.status).toBe(200);
    expect(impact.body).toEqual({
      id: acme,
      records: [
        { object: 'person', count: 2 },
        { object: 'task', count: 1 },
      ],
    });
    // Reading the impact changes nothing.
    expect((await t.request(`/v1/records/${acme}`, { key: keys.reader })).status).toBe(200);

    const deleted = await t.request(`/v1/records/${acme}`, { key: keys.agent, method: 'DELETE' });
    expect(deleted.body.deletedRecordIds).toHaveLength(4);
  });

  it('is empty without cascading links, and hides other workspaces', async () => {
    const solo = await create('company', { name: 'Solo' });
    const impact = await t.request(`/v1/records/${solo}/delete-impact`, { key: keys.reader });
    expect(impact.body).toEqual({ id: solo, records: [] });
    const foreign = await t.request(`/v1/records/${solo}/delete-impact`, { key: otherKey });
    expect(foreign.status).toBe(404);
  });
});
