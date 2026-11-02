import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { consolidateWorkspace } from '../../src/worker/consolidate.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * The SDK against the real routes and a real database: each method reaches
 * the route it names and returns the shape its type promises.
 */

const db = useTestDatabase();
let t: TestApp;
let workspaceId: string;
let agent: RetainerClient;
let user: RetainerClient;
let admin: RetainerClient;

const client = (apiKey: string) =>
  new RetainerClient({
    baseUrl: 'http://retainer.test/',
    apiKey,
    fetch: t.inProcessFetch,
  });

beforeAll(async () => {
  t = startTestApp(db);
  const setup = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
      admin: { actor: { type: 'user', id: 'ops' }, scopes: ['admin'] },
    },
  );
  workspaceId = setup.workspace.id;
  agent = client(setup.keys.agent);
  user = client(setup.keys.user);
  admin = client(setup.keys.admin);
});

describe('SDK against the server', () => {
  it('writes, cites, searches and reads context as an agent', async () => {
    const schema = await agent.schema();
    expect(schema.objects.map((o) => o.nameSingular)).toContain('person');

    const created = await agent.upsertRecord('person', {
      match: { emails: 'noa@acme.test' },
      ifMissing: 'create',
      values: { name: 'Noa Peretz', emails: 'noa@acme.test', jobTitle: 'CFO' },
    });
    expect(created.created).toBe(true);

    const interaction = await agent.logInteraction({
      kind: 'meeting',
      channel: 'calendar',
      occurredAt: '2026-10-01T09:00:00Z',
      title: 'Budget review with Noa',
      participants: [{ handle: 'noa@acme.test' }],
    });
    expect(interaction.participants.matched).toEqual([
      expect.objectContaining({ recordId: created.id }),
    ]);
    const { fact } = await agent.remember(created.id, {
      text: 'Noa prefers quarterly invoicing.',
      source: interaction.id,
    });

    const found = await agent.search({ query: 'quarterly invoicing' });
    expect(found.facts.map((f) => f.id)).toContain(fact.id);
    const byName = await agent.search({ query: 'Peretz', limit: 5 });
    expect(byName.records).toEqual([
      { id: created.id, object: 'person', label: 'Noa Peretz', match: 'text' },
    ]);

    const pack = await agent.context(created.id, { tokenBudget: 4000 });
    expect(pack.record).toMatchObject({ id: created.id, object: 'person', label: 'Noa Peretz' });
    expect(pack.record.fields.jobTitle?.value).toBe('CFO');
    expect(pack.facts.map((f) => f.id)).toEqual([fact.id]);
    expect(pack.recentInteractions.map((i) => i.id)).toEqual([interaction.id]);
  });

  it('merges suggested duplicates, dismisses a suggestion and forgets a person', async () => {
    const a = await agent.createRecord('person', {
      values: { name: 'Yael Mizrahi', emails: 'yael@one.test' },
    });
    const b = await agent.createRecord('person', {
      values: { name: 'Yael Mizrachi', emails: 'yael@two.test' },
    });
    const c = await agent.createRecord('person', {
      values: { name: 'Yael Mizrahy', emails: 'yael@three.test' },
    });
    await consolidateWorkspace(t.sql, workspaceId);
    const review = await user.review({ limit: 50 });
    const pair = (x: string, y: string) =>
      review.mergeSuggestions.find((s) => s.recordIds.includes(x) && s.recordIds.includes(y));
    const toDismiss = pair(a.id, c.id);
    expect(toDismiss).toBeDefined();
    expect(await user.dismissMergeSuggestion(toDismiss?.id as string)).toEqual({
      id: toDismiss?.id,
      status: 'dismissed',
    });

    const merged = await user.mergeRecords(a.id, { recordId: b.id }, 'sdk-merge-1');
    expect(merged).toMatchObject({ id: a.id, mergedId: b.id, merged: true });
    expect(await user.mergeRecords(a.id, { recordId: b.id }, 'sdk-merge-1')).toEqual(merged);
    expect((await user.record(b.id)).id).toBe(a.id);

    const forgotten = await admin.forget(c.id);
    expect(forgotten).toMatchObject({ id: c.id, forgotten: true, counts: { records: 1 } });
    await expect(user.record(c.id)).rejects.toMatchObject({ status: 404 });
  });

  it('raises typed errors for refused requests', async () => {
    const person = await agent.createRecord('person', {
      values: { name: 'Omer Bar', emails: 'omer@acme.test' },
    });
    const refused = await agent.forget(person.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RetainerApiError);
    expect(refused).toMatchObject({ status: 403 });
    await expect(agent.search({ query: '' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    await expect(agent.context(person.id, { tokenBudget: 0 })).rejects.toMatchObject({
      status: 400,
    });
  });
});
