import { type Actor, INTERNAL_NOTE_TYPE_ID } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import type { LogEventInput } from '../../src/memory/events.js';
import { factsOf, logEventFor, readEvent, remember } from '../../src/memory/service.js';
import { keyId, PREVIOUS_KEYS_ENV, SUPPRESSION_KEY_ENV } from '../../src/privacy/suppression.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  forget,
  mergeRecord,
  patchRecord,
  readRecord,
} from '../../src/records/service.js';
import { requestSchemaChange } from '../../src/schema-engine/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Privacy', template: 'sales' })).id;
});

let n = 0;
const email = () => `forget${++n}@acme.test`;
const person = (values: Record<string, unknown> = {}) =>
  createRecord(app, as(AGENT), 'person', { emails: email(), ...values });
const log = (input: Partial<LogEventInput> = {}) =>
  logEventFor(app, as(AGENT), {
    type: 'call',
    channel: 'zoom',
    occurredAt: '2026-10-29T14:00:00+02:00',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });

const count = async (query: Promise<{ count: number }[]>) => (await query)[0]?.count ?? 0;

describe('forget (2.1)', () => {
  it('hard-deletes the person, the events they took part in, and claims resting on them', async () => {
    const acme = await createRecord(app, as(AGENT), 'company', { name: 'Acme Forget' });
    const dana = await person({
      name: 'Dana Forgetme',
      emails: { primary: 'dana@forget.test', additional: ['d.f@home.test'] },
      phones: '+972 54 765 4321',
      company: acme.id,
    });
    const ron = await person({ name: 'Ron Stays' });
    const task = await createRecord(app, as(AGENT), 'task', {
      title: 'Call Dana',
      person: dana.id,
    });

    // A call with both of them: Ron's claim and fact from it go, Dana's event goes.
    const call = await log({
      externalId: 'call-forget-1',
      participants: [{ handle: 'DANA@forget.test' }, { recordId: ron.id }],
    });
    await patchRecord(app, as(AGENT), ron.id, { values: { jobTitle: 'CTO' }, source: call.id });
    await remember(app, as(AGENT), ron.id, { text: 'Ron joined the call', source: call.id });
    // A fact about Ron also cited elsewhere survives with its other source.
    const other = await log({ externalId: 'call-forget-2', participants: [{ recordId: ron.id }] });
    const both = await remember(app, as(AGENT), ron.id, { text: 'Ron likes tea', source: call.id });
    await db.owner`
      insert into fact_sources (workspace_id, fact_id, source_record_id)
      values (${workspaceId}, ${both.fact.id}, ${other.id})`;
    // Mentions on other rows become review candidates.
    const mention = await remember(app, as(AGENT), acme.id, {
      text: 'Dana Forgetme is the champion at Acme',
      source: other.id,
    });
    const emailMention = await log({
      externalId: 'call-forget-3',
      summary: 'Forwarded to dana@forget.test for review',
    });
    // A note fact on Dana and a stored idempotent response that names her.
    await remember(app, as(AGENT), dana.id, { text: 'Dana prefers mornings' });
    await createRecord(
      app,
      as(AGENT),
      'task',
      { title: 'Follow up', person: dana.id },
      {
        idempotencyKey: 'task-for-dana',
      },
    );

    const result = await forget(app, as(USER), dana.id);
    expect(result).toMatchObject({
      id: dana.id,
      forgotten: true,
      counts: { records: 1, suppressedHandles: 3, inboundRelations: 2 },
    });
    expect(result.counts.events).toBe(2); // the call and the internal note
    expect(result.recomputedRecordIds).toEqual(expect.arrayContaining([ron.id, task.id]));
    expect(result.reviewCandidates.facts).toContain(mention.fact.id);
    expect(result.reviewCandidates.events).toContain(emailMention.id);
    // The response carries no erased content. Match the whole phone number:
    // shorter digit runs turn up in the random ids the response does carry.
    expect(JSON.stringify(result)).not.toMatch(/dana|forgetme|765 ?4321|547654321/i);

    expect(await count(db.owner`select count(*)::int from records where id = ${dana.id}`)).toBe(0);
    expect(await count(db.owner`select count(*)::int from records where id = ${call.id}`)).toBe(0);
    expect(
      await count(db.owner`select count(*)::int from event_records where record_id = ${call.id}`),
    ).toBe(0);
    expect(
      await count(db.owner`select count(*)::int from event_links where handle like '%forget.test'`),
    ).toBe(0);
    expect(
      await count(db.owner`select count(*)::int from idempotency_keys where key = 'task-for-dana'`),
    ).toBe(0);

    // Ron's value from the erased call is gone.
    expect((await readRecord(app, as(USER), ron.id)).fields.jobTitle ?? null).toBeNull();
    const ronFacts = (await factsOf(app, as(USER), ron.id, 10)).facts;
    expect(ronFacts.map((f) => f.content)).toEqual(['Ron likes tea']);
    expect(ronFacts[0]?.sources).toEqual([{ event: other.id, quote: null }]);
    // Relations to Dana are cleared; the task stays.
    const taskAfter = await readRecord(app, as(USER), task.id);
    expect(taskAfter.fields.person ?? null).toBeNull();
    expect(
      await count(
        db.owner`select count(*)::int from record_links where target_record_id = ${dana.id}`,
      ),
    ).toBe(0);
    await expect(readEvent(app, as(USER), other.id)).resolves.toBeDefined();

    const [audit] = await db.owner<{ actor_type: string; actor_id: string; counts: object }[]>`
      select actor_type, actor_id, counts from deletion_audit_log where workspace_id = ${workspaceId}`;
    expect(audit).toEqual({ actor_type: 'user', actor_id: 'maya', counts: result.counts });
    const suppressed = await db.owner<{ kind: string; hmac: string }[]>`
      select kind, hmac from suppressions where workspace_id = ${workspaceId} order by kind`;
    expect(suppressed.map((s) => s.kind)).toEqual(['email', 'email', 'phone']);
    for (const s of suppressed) expect(s.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps erased emails and phones from coming back', async () => {
    const dana = await person({ emails: 'gone@forget.test', phones: '+1 415 555 0199' });
    await forget(app, as(USER), dana.id);

    await expect(
      createRecord(app, as(AGENT), 'person', { emails: 'GONE@forget.test' }),
    ).rejects.toMatchObject({
      code: 'suppressed',
      details: { field: 'emails', errors: [{ field: 'emails' }] },
    });
    await expect(
      createRecord(app, as(AGENT), 'person', { emails: email(), phones: '+1 (415) 555-0199' }),
    ).rejects.toMatchObject({ code: 'suppressed', details: { field: 'phones' } });
    const someone = await person();
    await expect(
      patchRecord(app, as(USER), someone.id, {
        values: { emails: { primary: email(), additional: ['gone@forget.test'] } },
      }),
    ).rejects.toMatchObject({ code: 'suppressed' });

    const input = {
      externalId: 'after-forget-1',
      participants: [{ handle: 'gone@forget.test', role: 'customer' }, { recordId: someone.id }],
    };
    const logged = await log(input);
    expect(logged.participants.unmatched).toEqual([
      { id: expect.any(String), handle: null, role: 'customer', reason: 'suppressed' },
    ]);
    expect(
      await count(
        db.owner`select count(*)::int from event_links where handle = 'gone@forget.test'`,
      ),
    ).toBe(0);

    // No hash of the input is stored, so nothing can confirm a guessed
    // handle; a retry with the same input matches the erased participant
    // and adds nothing.
    expect(await log(input)).toMatchObject({
      id: logged.id,
      created: false,
      added: { participants: { matched: [], unmatched: [] }, about: [] },
    });

    // Adding the erased handle to an event later stores it erased too.
    await log({ externalId: 'after-forget-3' });
    const appended = await log({
      externalId: 'after-forget-3',
      participants: [{ handle: 'gone@forget.test', role: 'guest' }],
    });
    expect(appended.added?.participants.unmatched).toEqual([
      { id: expect.any(String), handle: null, role: 'guest', reason: 'suppressed' },
    ]);
    expect(
      await count(
        db.owner`select count(*)::int from event_links where handle = 'gone@forget.test'`,
      ),
    ).toBe(0);
  });

  it('forgets every record merged into the person, and soft-deleted records too', async () => {
    const a = await person({ name: 'Merged Twice' });
    const b = await person();
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    const result = await forget(app, as(USER), b.id);
    expect(result.id).toBe(a.id);
    expect(result.counts.records).toBe(2);
    expect(
      await count(db.owner`select count(*)::int from records where id in (${a.id}, ${b.id})`),
    ).toBe(0);

    const c = await person();
    await deleteRecord(app, as(USER), c.id);
    await expect(forget(app, as(USER), c.id)).resolves.toMatchObject({ forgotten: true });
  });

  it('lets a record that shares an erased phone keep it, but no other record add it', async () => {
    const shared = '+972 3 555 0100';
    const dana = await person({ phones: shared });
    const office = await person({ phones: shared });
    await forget(app, as(USER), dana.id);
    const kept = await patchRecord(app, as(USER), office.id, {
      values: { phones: { primary: shared, additional: ['+972 3 555 0101'] } },
    });
    expect(kept.fields).toEqual({ phones: 'applied' });
    await expect(person({ phones: shared })).rejects.toMatchObject({ code: 'suppressed' });
  });

  it('needs a user and a configured suppression key', async () => {
    const dana = await person();
    await expect(forget(app, as(AGENT), dana.id)).rejects.toMatchObject({ status: 403 });
    const key = process.env[SUPPRESSION_KEY_ENV];
    delete process.env[SUPPRESSION_KEY_ENV];
    try {
      await expect(forget(app, as(USER), dana.id)).rejects.toMatchObject({
        status: 503,
        code: 'not_configured',
      });
      // Suppressions exist, so writes that could bring a handle back fail closed.
      await expect(person()).rejects.toMatchObject({ code: 'not_configured' });
    } finally {
      process.env[SUPPRESSION_KEY_ENV] = key;
    }
    expect((await readRecord(app, as(USER), dana.id)).id).toBe(dana.id);
  });

  it("does not touch another workspace's suppressions", async () => {
    const other = (await createWorkspace(db.owner, { name: 'Elsewhere', template: 'sales' })).id;
    const dana = await person({ emails: 'shared@forget.test' });
    await forget(app, as(USER), dana.id);
    await expect(
      createRecord(app, as(AGENT, other), 'person', { emails: 'shared@forget.test' }),
    ).resolves.toMatchObject({ created: true });
  });
});

const tombstones = () =>
  db.owner<Record<string, unknown>[]>`
    select * from event_identity_tombstones where workspace_id = ${workspaceId} order by id`;
const notesAbout = (recordId: string) =>
  db.owner<{ id: string }[]>`
    select l.event_id as id from event_links l
    join records r on r.id = l.event_id
    join object_types o on o.id = r.object_type_id
    where l.record_id = ${recordId} and l.link = 'about'
      and o.universal_id = ${INTERNAL_NOTE_TYPE_ID}`;

describe('forget and events (6.4)', () => {
  it("leaves an erased event's identity as a keyed tombstone that refuses it again", async () => {
    const dana = await person();
    const identity = { channel: 'zoom-tombstone', externalId: 'tombstone-secret-1' };
    const call = await log({
      ...identity,
      title: 'Pricing with Dana',
      participants: [{ recordId: dana.id }],
    });
    const before = await tombstones();
    await forget(app, as(USER), dana.id);
    expect(await count(db.owner`select count(*)::int from records where id = ${call.id}`)).toBe(0);

    // The same identity is refused, whatever the payload: deduplication
    // never brings the erased event back.
    await expect(log({ ...identity, title: 'Pricing with Dana' })).rejects.toMatchObject({
      status: 409,
      code: 'event_retracted',
    });
    await expect(log({ ...identity, type: 'meeting' })).rejects.toMatchObject({
      code: 'event_retracted',
    });
    // Another external ID, or the same one on another channel, still logs.
    await expect(log({ ...identity, externalId: 'tombstone-secret-2' })).resolves.toMatchObject({
      created: true,
    });
    await expect(log({ ...identity, channel: 'zoom-other' })).resolves.toMatchObject({
      created: true,
    });

    // The tombstone keeps only the workspace, the key's ID and an HMAC.
    const rows = await tombstones();
    expect(rows).toHaveLength(before.length + 1);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'created_at',
        'hmac',
        'id',
        'key_id',
        'workspace_id',
      ]);
      expect(row.hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_id).toBe(keyId(process.env[SUPPRESSION_KEY_ENV] as string));
    }
    expect(JSON.stringify(rows)).not.toMatch(/zoom-tombstone|tombstone-secret|Pricing/);
    expect(JSON.stringify(rows)).not.toContain(call.id);
  });

  it('keeps an event only about the record, without the link', async () => {
    const dana = await person();
    const ron = await person();
    const meeting = await log({
      type: 'meeting',
      channel: 'calendar',
      externalId: 'about-only-1',
      title: 'Planning the account',
      participants: [{ recordId: ron.id }],
      about: [dana.id],
    });
    const result = await forget(app, as(USER), dana.id);
    expect(result.counts.events).toBe(0);

    const after = await readEvent(app, as(USER), meeting.id);
    expect(after.event).toMatchObject({
      channel: 'calendar',
      externalId: 'about-only-1',
      title: 'Planning the account',
      about: [],
    });
    expect(after.event?.participants.matched.map((p) => p.recordId)).toEqual([ron.id]);
    expect(
      await count(
        db.owner`select count(*)::int from event_links where event_id = ${meeting.id} and link = 'about'`,
      ),
    ).toBe(0);
    // Its identity is intact, so a retry still finds it.
    await expect(
      log({
        type: 'meeting',
        channel: 'calendar',
        externalId: 'about-only-1',
        title: 'Planning the account',
      }),
    ).resolves.toMatchObject({ id: meeting.id, created: false });
  });

  it('drops the raw identity of a surviving event whose initial values named the record', async () => {
    await requestSchemaChange(app, as(USER), {
      operations: [
        {
          op: 'create_field',
          object: 'meeting',
          field: {
            name: 'contact',
            label: 'Contact',
            type: 'relation',
            settings: { targetObject: 'person', inverseField: 'contactMeetings' },
          },
        },
      ],
    });
    const dana = await person();
    const ron = await person();
    const identity = { type: 'meeting', channel: 'calendar', externalId: 'initial-erased-1' };
    const meeting = await log({
      ...identity,
      fields: { contact: dana.id },
      participants: [{ recordId: ron.id }],
    });
    const before = await tombstones();

    const result = await forget(app, as(USER), dana.id);
    expect(result.counts).toMatchObject({ events: 0, inboundRelations: 1 });
    expect(result.recomputedRecordIds).toContain(meeting.id);

    const after = await readEvent(app, as(USER), meeting.id);
    expect(after.fields.contact ?? null).toBeNull();
    expect(after.event).toMatchObject({ channel: null, externalId: null });
    expect(
      await count(
        db.owner`select count(*)::int from field_assertions
          where record_id = ${meeting.id} and is_initial and value = ${db.owner.json(dana.id)}`,
      ),
    ).toBe(0);
    expect(await tombstones()).toHaveLength(before.length + 1);
    await expect(log(identity)).rejects.toMatchObject({ code: 'event_retracted' });
  });

  it('deletes the internal notes remember wrote about the record, and only those', async () => {
    const dana = await person();
    const ron = await person();
    await remember(app, as(AGENT), dana.id, { text: 'Reads email at night' });
    await remember(app, as(AGENT), ron.id, { text: 'Reads email at dawn' });
    const [danaNote] = await notesAbout(dana.id);
    const [ronNote] = await notesAbout(ron.id);
    expect(danaNote && ronNote).toBeTruthy();
    const before = await tombstones();

    const result = await forget(app, as(USER), dana.id);
    expect(
      await count(db.owner`select count(*)::int from records where id = ${danaNote?.id ?? ''}`),
    ).toBe(0);
    // The fact's text lived on in the note; nothing of it may remain.
    expect(
      await count(
        db.owner`select count(*)::int from records where data::text like '%email at night%'`,
      ),
    ).toBe(0);
    expect(result.counts).toMatchObject({ events: 1, facts: 1 });
    expect(
      await count(db.owner`select count(*)::int from records where id = ${ronNote?.id ?? ''}`),
    ).toBe(1);
    expect((await factsOf(app, as(USER), ron.id, 10)).facts).toMatchObject([
      { content: 'Reads email at dawn', sources: [{ event: null, internal: true, quote: null }] },
    ]);
    // A note has no external ID, so it leaves no tombstone.
    expect(await tombstones()).toHaveLength(before.length);
  });

  it('keeps refusing an erased identity across a key rotation, and fails closed without the old key', async () => {
    // A workspace of its own: once a key is dropped, its logging fails closed.
    const ws = (await createWorkspace(db.owner, { name: 'Rotation', template: 'sales' })).id;
    const logIn = (input: Partial<LogEventInput>) =>
      logEventFor(app, as(AGENT, ws), {
        type: 'call',
        channel: 'rotation',
        occurredAt: '2026-10-29T14:00:00+02:00',
        fields: {},
        participants: [],
        about: [],
        ...input,
      });
    const personIn = () => createRecord(app, as(AGENT, ws), 'person', { emails: email() });
    const keyIds = async () =>
      (
        await db.owner<{ key_id: string }[]>`
          select distinct key_id from event_identity_tombstones where workspace_id = ${ws}`
      )
        .map((r) => r.key_id)
        .sort();

    const oldKey = process.env[SUPPRESSION_KEY_ENV] as string;
    const newKey = 'rotated-suppression-key-fedcba9876543210';
    const previous = process.env[PREVIOUS_KEYS_ENV];
    const dana = await personIn();
    await logIn({ externalId: 'rotate-1', participants: [{ recordId: dana.id }] });
    await forget(app, as(USER, ws), dana.id);
    try {
      process.env[SUPPRESSION_KEY_ENV] = newKey;
      process.env[PREVIOUS_KEYS_ENV] = oldKey;
      await expect(logIn({ externalId: 'rotate-1' })).rejects.toMatchObject({
        code: 'event_retracted',
      });
      // New erasures use the new key; both keep matching.
      const ron = await personIn();
      await logIn({ externalId: 'rotate-2', participants: [{ recordId: ron.id }] });
      await forget(app, as(USER, ws), ron.id);
      expect(await keyIds()).toEqual([keyId(oldKey), keyId(newKey)].sort());
      await expect(logIn({ externalId: 'rotate-2' })).rejects.toMatchObject({
        code: 'event_retracted',
      });
      await expect(logIn({ externalId: 'rotate-3' })).resolves.toMatchObject({ created: true });

      // With the old key gone its tombstones cannot be checked: logging an
      // external ID fails closed instead of letting an erased event back.
      delete process.env[PREVIOUS_KEYS_ENV];
      for (const externalId of ['rotate-1', 'rotate-4']) {
        await expect(logIn({ externalId })).rejects.toMatchObject({
          status: 503,
          code: 'not_configured',
        });
      }
      // Without an external ID there is no identity to check.
      await expect(logIn({})).resolves.toMatchObject({ created: true });
      expect(
        await count(
          db.owner`select count(*)::int from event_records
            where workspace_id = ${ws} and external_id in ('rotate-1', 'rotate-4')`,
        ),
      ).toBe(0);
    } finally {
      process.env[SUPPRESSION_KEY_ENV] = oldKey;
      if (previous === undefined) delete process.env[PREVIOUS_KEYS_ENV];
      else process.env[PREVIOUS_KEYS_ENV] = previous;
    }
  });
});

describe('forget under concurrency (2.1)', () => {
  it('leaves no participant row with the handle, whichever commits first', async () => {
    for (let round = 0; round < 8; round++) {
      const handle = `race${round}@forget.test`;
      const dana = await person({ emails: handle });
      const [, logged] = await Promise.allSettled([
        forget(app, as(USER), dana.id),
        log({ participants: [{ handle }] }),
      ]);
      expect(logged.status).toBe('fulfilled');
      expect(
        await count(db.owner`select count(*)::int from event_links where handle = ${handle}`),
      ).toBe(0);
    }
  });

  it('never lets a concurrent log recreate an erased event', async () => {
    for (let round = 0; round < 8; round++) {
      const dana = await person();
      const ron = await person();
      const identity = { channel: 'race', externalId: `race-event-${round}`, title: 'Race call' };
      const first = await log({ ...identity, participants: [{ recordId: dana.id }] });
      const [forgotten, relogged] = await Promise.allSettled([
        forget(app, as(USER), dana.id),
        log({ ...identity, participants: [{ recordId: ron.id }] }),
      ]);
      expect(forgotten.status).toBe('fulfilled');
      // Before forget the retry finds the event (then erased with it);
      // after it, the identity is retracted.
      if (relogged.status === 'fulfilled') {
        expect(relogged.value).toMatchObject({ id: first.id, created: false });
      } else {
        expect(relogged.reason).toMatchObject({ code: 'event_retracted' });
      }
      expect(
        await count(
          db.owner`select count(*)::int from event_records
            where channel = 'race' and external_id = ${identity.externalId}`,
        ),
      ).toBe(0);
      expect(await count(db.owner`select count(*)::int from records where id = ${first.id}`)).toBe(
        0,
      );
      await expect(log(identity)).rejects.toMatchObject({ code: 'event_retracted' });
    }
  });

  it('never lets a concurrent create keep an erased email', async () => {
    for (let round = 0; round < 8; round++) {
      const handle = `create${round}@forget.test`;
      const dana = await person({ emails: { primary: email(), additional: [handle] } });
      const [forgotten, created] = await Promise.allSettled([
        forget(app, as(USER), dana.id),
        createRecord(app, as(AGENT), 'person', { emails: handle }),
      ]);
      expect(forgotten.status).toBe('fulfilled');
      // Before forget the email is taken; after it, it is suppressed.
      expect(created.status).toBe('rejected');
      expect(
        await count(db.owner`select count(*)::int from record_identifiers where value = ${handle}`),
      ).toBe(0);
    }
  });

  it('leaves no fact behind when remember races forget', async () => {
    for (let round = 0; round < 8; round++) {
      const dana = await person();
      await Promise.allSettled([
        forget(app, as(USER), dana.id),
        remember(app, as(AGENT), dana.id, { text: `Race fact ${round}` }),
      ]);
      expect(
        await count(
          db.owner`select count(*)::int from facts where content = ${`Race fact ${round}`}`,
        ),
      ).toBe(0);
      expect(await count(db.owner`select count(*)::int from records where id = ${dana.id}`)).toBe(
        0,
      );
    }
  });
});
