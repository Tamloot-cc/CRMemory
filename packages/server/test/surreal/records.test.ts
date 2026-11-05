import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LogEventInput } from '../../src/memory/events.js';
import {
  factsOf,
  logEventFor,
  readEvent,
  remember,
  retractEventFor,
} from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  forget,
  mergeRecord,
  patchRecord,
  readRecord,
} from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox', name: 'Inbox agent' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

let n = 0;
const email = () => `smoke${++n}@acme.test`;

const person = (values: Record<string, unknown> = {}) =>
  createRecord(backend, as(AGENT), 'person', { emails: email(), ...values });

const log = (input: Partial<LogEventInput> = {}) =>
  logEventFor(backend, as(AGENT), {
    type: 'call',
    channel: 'zoom',
    occurredAt: '2026-10-29T14:00:00+02:00',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });

beforeAll(async () => {
  workspaceId = (await createWorkspace(backend, { name: 'Smoke', template: 'sales' })).id;
});

describe('records and memory on SurrealDB', () => {
  it('creates, patches and reads a record', async () => {
    const created = await person({ name: 'Dana Levi' });
    expect(created.created).toBe(true);
    expect(created.record.fields.name).toEqual({ first: 'Dana', last: 'Levi' });
    const patched = await patchRecord(backend, as(AGENT), created.id, {
      values: { name: 'Dana Cohen' },
    });
    expect(patched.fields).toEqual({ name: 'applied' });
    const read = await readRecord(backend, as(AGENT), created.id);
    expect(read.fields.name).toEqual({ first: 'Dana', last: 'Cohen' });
  });

  it('logs an event, dedupes a retry, and matches participants', async () => {
    const dana = await person({ name: 'Dana' });
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const input = {
      externalId: 'call-1',
      title: 'Kickoff',
      participants: [{ handle: danaEmail.toUpperCase(), role: 'customer' }],
    };
    const first = await log(input);
    expect(first.created).toBe(true);
    expect(first.participants.matched).toEqual([
      { id: expect.any(String), handle: danaEmail, role: 'customer', recordId: dana.id },
    ]);
    const retry = await log(input);
    expect(retry).toMatchObject({ id: first.id, created: false });
    await expect(log({ ...input, title: 'Different' })).rejects.toMatchObject({
      code: 'event_conflict',
    });
    const event = await readEvent(backend, as(AGENT), first.id);
    expect(event.event?.title).toBe('Kickoff');
  });

  it('remembers facts and hides them when their source is retracted', async () => {
    const dana = await person({ name: 'Dana Fact' });
    const call = await log({ externalId: 'call-fact', title: 'Fact call' });
    const cited = await remember(backend, as(AGENT), dana.id, {
      text: 'Prefers email',
      source: call.id,
    });
    const note = await remember(backend, as(AGENT), dana.id, { text: 'Has two kids' });
    expect(note.fact.sources).toEqual([{ event: null, internal: true, quote: null }]);
    let facts = await factsOf(backend, as(AGENT), dana.id, 10);
    expect(facts.facts.map((f) => f.content).sort()).toEqual(['Has two kids', 'Prefers email']);
    const retraction = await retractEventFor(backend, as(AGENT), call.id);
    expect(retraction.hiddenFactIds).toEqual([cited.fact.id]);
    facts = await factsOf(backend, as(AGENT), dana.id, 10);
    expect(facts.facts.map((f) => f.content)).toEqual(['Has two kids']);
  });

  it('retracts claims citing a deleted event', async () => {
    const dana = await person({ name: 'Before' });
    // A claim is as recent as its source (2.2): log one after the create.
    const call = await log({
      externalId: 'call-claim',
      occurredAt: new Date().toISOString(),
    });
    await patchRecord(backend, as(AGENT), dana.id, {
      values: { name: 'After' },
      source: call.id,
    });
    expect((await readRecord(backend, as(AGENT), dana.id)).fields.name).toEqual({
      first: 'After',
      last: '',
    });
    const deleted = await deleteRecord(backend, as(AGENT), call.id);
    expect(deleted).toMatchObject({ retractedAssertions: 1, recomputedRecordIds: [dana.id] });
    expect((await readRecord(backend, as(AGENT), dana.id)).fields.name).toEqual({
      first: 'Before',
      last: '',
    });
  });

  it('merges two people, moving links and facts to the survivor', async () => {
    const a = await person({ name: 'Ann' });
    const b = await person({ name: 'Ann B' });
    const bEmail = (b.record.fields.emails as { primary: string }).primary;
    const call = await log({ participants: [{ recordId: b.id }] });
    await remember(backend, as(AGENT), b.id, { text: 'Likes tea' });
    const merged = await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    expect(merged).toMatchObject({ id: a.id, mergedId: b.id, merged: true });
    const emails = merged.record.fields.emails as { primary: string; additional?: string[] };
    expect(emails.additional).toContain(bEmail);
    const event = await readEvent(backend, as(AGENT), call.id);
    expect(event.event?.participants.matched.map((p) => p.recordId)).toEqual([a.id]);
    const facts = await factsOf(backend, as(AGENT), a.id, 10);
    expect(facts.facts.map((f) => f.content)).toEqual(['Likes tea']);
    // The merged ID resolves to the survivor.
    expect((await readRecord(backend, as(AGENT), b.id)).id).toBe(a.id);
  });

  it('forgets a person, their events and handles', async () => {
    const gone = await person({ name: 'Forget Me' });
    const goneEmail = (gone.record.fields.emails as { primary: string }).primary;
    const call = await log({ externalId: 'call-forget', participants: [{ handle: goneEmail }] });
    await remember(backend, as(AGENT), gone.id, { text: 'Secret' });
    const result = await forget(backend, as(USER), gone.id);
    expect(result).toMatchObject({
      id: gone.id,
      forgotten: true,
      // The call and the internal note `remember` wrote about them.
      counts: { records: 1, events: 2, facts: 1, suppressedHandles: 1 },
    });
    await expect(readRecord(backend, as(AGENT), gone.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(readEvent(backend, as(AGENT), call.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    // The erased identity and the suppressed handle never come back.
    await expect(log({ externalId: 'call-forget' })).rejects.toMatchObject({
      code: 'event_retracted',
    });
    const again = await log({ participants: [{ handle: goneEmail }] });
    expect(again.participants.unmatched).toEqual([
      { id: expect.any(String), handle: null, role: null, reason: 'suppressed' },
    ]);
  });
});
