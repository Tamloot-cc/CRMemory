import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { consolidateWorkspace } from '../../src/worker/consolidate.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * The SDK against the real routes and a real database: each method reaches
 * the route it names and returns the shape its type promises.
 */

const backend = useTestBackend();
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
  t = startTestApp(backend);
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

    const meeting = await agent.logEvent({
      type: 'meeting',
      channel: 'calendar',
      occurredAt: '2026-10-01T09:00:00Z',
      title: 'Budget review with Noa',
      participants: [{ handle: 'noa@acme.test' }],
    });
    expect(meeting.participants.matched).toEqual([
      expect.objectContaining({ recordId: created.id }),
    ]);
    const { fact } = await agent.remember(created.id, {
      text: 'Noa prefers quarterly invoicing.',
      source: meeting.id,
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
    expect(pack.recentEvents.map((i) => [i.id, i.type, i.via])).toEqual([
      [meeting.id, 'meeting', { kind: 'participant' }],
    ]);
  });

  it('logs, reads, links and deletes an event, and lists its history and claims', async () => {
    const person = await agent.createRecord('person', {
      values: { name: 'Lior Katz', emails: 'lior@acme.test' },
    });
    const company = await agent.createRecord('company', { values: { name: 'Katz Ltd' } });
    const logged = await agent.logEvent({
      type: 'call',
      channel: 'phone',
      externalId: 'sdk-call-1',
      occurredAt: '2026-10-02T09:00:00Z',
      title: 'Intro call with Lior',
    });
    expect(logged).toMatchObject({ type: 'call', created: true, about: [] });
    await expect(
      agent.logEvent({
        type: 'call',
        channel: 'phone',
        externalId: 'sdk-call-1',
        occurredAt: '2026-10-02T09:00:00Z',
        title: 'Another title',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'event_conflict' });

    const linked = await agent.addEventLinks(logged.id, {
      participants: [{ handle: 'lior@acme.test', role: 'prospect' }],
      about: [company.id],
    });
    expect(linked.added.about).toEqual([company.id]);
    const participantId = linked.event?.participants.matched[0]?.id as string;
    expect(linked.event?.participants.matched[0]?.recordId).toBe(person.id);

    const read = await agent.event(logged.id);
    expect(read).toMatchObject({
      id: logged.id,
      object: 'call',
      event: { channel: 'phone', externalId: 'sdk-call-1', title: 'Intro call with Lior' },
    });
    const history = await agent.recordEvents(person.id);
    expect(history.items.map((e) => [e.id, e.via])).toEqual([[logged.id, { kind: 'participant' }]]);
    expect((await agent.recordEvents(company.id, { link: 'participant' })).items).toEqual([]);
    const timeline = await agent.timeline(person.id, { types: ['event'], limit: 5 });
    expect(timeline.items).toMatchObject([
      { kind: 'event', id: logged.id, via: { kind: 'participant' } },
    ]);
    const emails = await agent.timeline(person.id, { fields: ['emails'] });
    expect(emails.items.every((i) => i.kind === 'field_change' && i.field === 'emails')).toBe(true);

    await agent.upsertRecord('person', {
      id: person.id,
      values: { jobTitle: 'COO' },
      source: logged.id,
    });
    const claims = await agent.claims(logged.id);
    expect(claims.assertions.find((a) => a.recordId === person.id)).toMatchObject({
      field: 'jobTitle',
      sourceRecordId: logged.id,
      source: { id: logged.id, type: 'call', title: 'Intro call with Lior' },
    });

    await expect(agent.removeParticipant(logged.id, participantId)).rejects.toMatchObject({
      status: 403,
    });
    const without = await user.removeParticipant(logged.id, participantId);
    expect(without.event?.participants.matched).toEqual([]);
    expect((await user.removeAbout(logged.id, company.id)).event?.about).toEqual([]);

    const deleted = await agent.deleteEvent(logged.id);
    expect(deleted).toEqual({
      id: logged.id,
      deleted: true,
      retractedAssertions: 1,
      recomputedRecordIds: [person.id],
      hiddenFactIds: [],
    });
    await expect(agent.event(logged.id)).rejects.toMatchObject({ status: 404 });
    await expect(agent.deleteEvent(logged.id)).rejects.toMatchObject({
      status: 409,
      code: 'event_deleted',
    });
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
    await consolidateWorkspace(backend, workspaceId);
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
