import { randomUUID } from 'node:crypto';
import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { RecordId } from '../../src/db/cbor.js';
import { relationTable } from '../../src/db/names.js';
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
  withRead,
} from '../../src/records/service.js';
import { directoryEntries } from '../../src/records/store.js';
import type { CompiledSchema } from '../../src/schema-engine/compiled.js';
import { requestSchemaChange } from '../../src/schema-engine/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

beforeAll(async () => {
  workspaceId = (await createWorkspace(backend, { name: 'Privacy', template: 'sales' })).id;
});

let n = 0;
const email = () => `forget${++n}@acme.test`;
const person = (values: Record<string, unknown> = {}, on: Backend = backend) =>
  createRecord(on, as(AGENT), 'person', { emails: email(), ...values });
const log = (input: Partial<LogEventInput> = {}, on: Backend = backend) =>
  logEventFor(on, as(AGENT), {
    type: 'call',
    channel: 'zoom',
    occurredAt: '2026-10-29T14:00:00+02:00',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });

/** Runtime reads of a workspace's database, parameters only. */
const rows = async <T = Record<string, unknown>>(
  text: string,
  vars: Record<string, unknown> = {},
  ws = workspaceId,
) => (await backend.workspace(ws)).rows<T>(text, vars);
const count = async (text: string, vars: Record<string, unknown> = {}, ws = workspaceId) =>
  (await rows(text, vars, ws)).length;
const schemaOf = (ws = workspaceId) =>
  withRead(backend, as(USER, ws), async (_db, schema) => schema);
const tableOf = (schema: CompiledSchema, name: string) => {
  const object = name === 'internalNote' ? schema.internalNote : schema.objectsByName.get(name);
  if (!object) throw new Error(`no object ${name}`);
  return object.table;
};

/**
 * How many of the records are stored at all, deleted or not: their
 * directory entries, which must agree with their object-table rows.
 */
async function storedCount(ids: string[], objectName: string): Promise<number> {
  const schema = await schemaOf();
  const directory = await count('SELECT id FROM $ids;', {
    ids: ids.map((id) => new RecordId('record_directory', id)),
  });
  const native = await count('SELECT id FROM $ids;', {
    ids: ids.map((id) => new RecordId(tableOf(schema, objectName), id)),
  });
  expect(native).toBe(directory);
  return directory;
}

/** Native edges into a record, across every owning relation field of the workspace. */
async function edgesTo(id: string, objectName: string): Promise<number> {
  const schema = await schemaOf();
  const node = new RecordId(tableOf(schema, objectName), id);
  let total = 0;
  for (const object of schema.objectsById.values()) {
    for (const field of object.state.fields) {
      if (field.type !== 'relation' || field.settings.isInverse) continue;
      total += await count('SELECT id FROM type::table($tb) WHERE out = $node;', {
        tb: relationTable(field.universalId),
        node,
      });
    }
  }
  return total;
}

const handlesEndingWith = async (suffix: string) =>
  (await rows<{ handle?: string | null }>('SELECT handle FROM event_links;')).filter((r) =>
    r.handle?.endsWith(suffix),
  ).length;

describe('forget (2.1)', () => {
  it('hard-deletes the person, the events they took part in, and claims resting on them', async () => {
    const acme = await createRecord(backend, as(AGENT), 'company', { name: 'Acme Forget' });
    const dana = await person({
      name: 'Dana Forgetme',
      emails: { primary: 'dana@forget.test', additional: ['d.f@home.test'] },
      phones: '+972 54 765 4321',
      company: acme.id,
    });
    const ron = await person({ name: 'Ron Stays' });
    const task = await createRecord(backend, as(AGENT), 'task', {
      title: 'Call Dana',
      person: dana.id,
    });

    // A call with both of them: Ron's claim and fact from it go, Dana's event goes.
    const call = await log({
      externalId: 'call-forget-1',
      participants: [{ handle: 'DANA@forget.test' }, { recordId: ron.id }],
    });
    await patchRecord(backend, as(AGENT), ron.id, {
      values: { jobTitle: 'CTO' },
      source: call.id,
    });
    await remember(backend, as(AGENT), ron.id, { text: 'Ron joined the call', source: call.id });
    // A fact about Ron also cited elsewhere survives with its other source.
    const other = await log({ externalId: 'call-forget-2', participants: [{ recordId: ron.id }] });
    const both = await remember(backend, as(AGENT), ron.id, {
      text: 'Ron likes tea',
      source: call.id,
    });
    await backend
      .adminDb((await backend.route(workspaceId)).database)
      .query("CREATE type::record('fact_sources', $id) CONTENT $content;", {
        id: randomUUID(),
        content: { fact: both.fact.id, source: other.id, quote: null },
      });
    // Mentions on other rows become review candidates.
    const mention = await remember(backend, as(AGENT), acme.id, {
      text: 'Dana Forgetme is the champion at Acme',
      source: other.id,
    });
    const emailMention = await log({
      externalId: 'call-forget-3',
      summary: 'Forwarded to dana@forget.test for review',
    });
    // A note fact on Dana and a stored idempotent response that names her.
    await remember(backend, as(AGENT), dana.id, { text: 'Dana prefers mornings' });
    await createRecord(
      backend,
      as(AGENT),
      'task',
      { title: 'Follow up', person: dana.id },
      {
        idempotencyKey: 'task-for-dana',
      },
    );

    const result = await forget(backend, as(USER), dana.id);
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

    expect(await storedCount([dana.id], 'person')).toBe(0);
    expect(await storedCount([call.id], 'call')).toBe(0);
    expect(
      await count('SELECT id FROM $id;', { id: new RecordId('event_identity', call.id) }),
    ).toBe(0);
    expect(await handlesEndingWith('forget.test')).toBe(0);
    // Receipts of record writes keep only `{ id, created, fields }` (spec
    // section 13), so none may name her: neither her ID nor her handles.
    const receipts = await rows(
      "SELECT * FROM operations WHERE idempotency_key = 'task-for-dana';",
    );
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toContain(dana.id);
    expect(JSON.stringify(receipts)).not.toMatch(/forget\.test|forgetme/i);

    // Ron's value from the erased call is gone.
    expect((await readRecord(backend, as(USER), ron.id)).fields.jobTitle ?? null).toBeNull();
    const ronFacts = (await factsOf(backend, as(USER), ron.id, 10)).facts;
    expect(ronFacts.map((f) => f.content)).toEqual(['Ron likes tea']);
    expect(ronFacts[0]?.sources).toEqual([{ event: other.id, quote: null }]);
    // Relations to Dana are cleared; the task stays.
    const taskAfter = await readRecord(backend, as(USER), task.id);
    expect(taskAfter.fields.person ?? null).toBeNull();
    expect(await edgesTo(dana.id, 'person')).toBe(0);
    await expect(readEvent(backend, as(USER), other.id)).resolves.toBeDefined();

    // The workspace is its own database, so the audit row needs no workspace column.
    const [audit] = await rows<{ actor_type: string; actor_id: string; counts: object }>(
      'SELECT actor_type, actor_id, counts FROM deletion_audit_log;',
    );
    expect(audit).toEqual({ actor_type: 'user', actor_id: 'maya', counts: result.counts });
    const suppressed = await rows<{ kind: string; hmac: string }>(
      'SELECT kind, hmac FROM suppressions ORDER BY kind;',
    );
    expect(suppressed.map((s) => s.kind)).toEqual(['email', 'email', 'phone']);
    for (const s of suppressed) expect(s.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps erased emails and phones from coming back', async () => {
    const dana = await person({ emails: 'gone@forget.test', phones: '+1 415 555 0199' });
    await forget(backend, as(USER), dana.id);

    await expect(
      createRecord(backend, as(AGENT), 'person', { emails: 'GONE@forget.test' }),
    ).rejects.toMatchObject({
      code: 'suppressed',
      details: { field: 'emails', errors: [{ field: 'emails' }] },
    });
    await expect(
      createRecord(backend, as(AGENT), 'person', { emails: email(), phones: '+1 (415) 555-0199' }),
    ).rejects.toMatchObject({ code: 'suppressed', details: { field: 'phones' } });
    const someone = await person();
    await expect(
      patchRecord(backend, as(USER), someone.id, {
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
      await count('SELECT id FROM event_links WHERE handle = $h;', { h: 'gone@forget.test' }),
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
      await count('SELECT id FROM event_links WHERE handle = $h;', { h: 'gone@forget.test' }),
    ).toBe(0);
  });

  it('forgets every record merged into the person, and soft-deleted records too', async () => {
    const a = await person({ name: 'Merged Twice' });
    const b = await person();
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    const result = await forget(backend, as(USER), b.id);
    expect(result.id).toBe(a.id);
    expect(result.counts.records).toBe(2);
    expect(await storedCount([a.id, b.id], 'person')).toBe(0);

    const c = await person();
    await deleteRecord(backend, as(USER), c.id);
    await expect(forget(backend, as(USER), c.id)).resolves.toMatchObject({ forgotten: true });
  });

  it('lets a record that shares an erased phone keep it, but no other record add it', async () => {
    const shared = '+972 3 555 0100';
    const dana = await person({ phones: shared });
    const office = await person({ phones: shared });
    await forget(backend, as(USER), dana.id);
    const kept = await patchRecord(backend, as(USER), office.id, {
      values: { phones: { primary: shared, additional: ['+972 3 555 0101'] } },
    });
    expect(kept.fields).toEqual({ phones: 'applied' });
    await expect(person({ phones: shared })).rejects.toMatchObject({ code: 'suppressed' });
  });

  it('needs a user and a configured suppression key', async () => {
    const dana = await person();
    await expect(forget(backend, as(AGENT), dana.id)).rejects.toMatchObject({ status: 403 });
    const key = process.env[SUPPRESSION_KEY_ENV];
    delete process.env[SUPPRESSION_KEY_ENV];
    try {
      await expect(forget(backend, as(USER), dana.id)).rejects.toMatchObject({
        status: 503,
        code: 'not_configured',
      });
      // Suppressions exist, so writes that could bring a handle back fail closed.
      await expect(person()).rejects.toMatchObject({ code: 'not_configured' });
    } finally {
      process.env[SUPPRESSION_KEY_ENV] = key;
    }
    expect((await readRecord(backend, as(USER), dana.id)).id).toBe(dana.id);
  });

  it("does not touch another workspace's suppressions", async () => {
    const other = (await createWorkspace(backend, { name: 'Elsewhere', template: 'sales' })).id;
    const dana = await person({ emails: 'shared@forget.test' });
    await forget(backend, as(USER), dana.id);
    await expect(
      createRecord(backend, as(AGENT, other), 'person', { emails: 'shared@forget.test' }),
    ).resolves.toMatchObject({ created: true });
  });
});

const tombstones = () =>
  rows<Record<string, unknown>>('SELECT * FROM event_identity_tombstones ORDER BY id;');
/** The internal notes `remember` wrote about a record. */
const notesAbout = async (recordId: string) => {
  const schema = await schemaOf();
  const links = await rows<{ event: string }>(
    "SELECT event FROM event_links WHERE record = $r AND link = 'about';",
    { r: recordId },
  );
  const entries = await withRead(backend, as(USER), (db) =>
    directoryEntries(
      db,
      links.map((l) => l.event),
    ),
  );
  return [...entries.values()]
    .filter((e) => e.object_type_id === schema.internalNote?.id)
    .map((e) => ({ id: e.id }));
};

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
    await forget(backend, as(USER), dana.id);
    expect(await storedCount([call.id], 'call')).toBe(0);

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

    // The tombstone keeps only the key's ID and an HMAC (the workspace is
    // the database it lives in, so it has no workspace column).
    const rows = await tombstones();
    expect(rows).toHaveLength(before.length + 1);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['created_at', 'hmac', 'id', 'key_id']);
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
    const result = await forget(backend, as(USER), dana.id);
    expect(result.counts.events).toBe(0);

    const after = await readEvent(backend, as(USER), meeting.id);
    expect(after.event).toMatchObject({
      channel: 'calendar',
      externalId: 'about-only-1',
      title: 'Planning the account',
      about: [],
    });
    expect(after.event?.participants.matched.map((p) => p.recordId)).toEqual([ron.id]);
    expect(
      await count("SELECT id FROM event_links WHERE event = $e AND link = 'about';", {
        e: meeting.id,
      }),
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
    await requestSchemaChange(backend, as(USER), {
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

    const result = await forget(backend, as(USER), dana.id);
    expect(result.counts).toMatchObject({ events: 0, inboundRelations: 1 });
    expect(result.recomputedRecordIds).toContain(meeting.id);

    const after = await readEvent(backend, as(USER), meeting.id);
    expect(after.fields.contact ?? null).toBeNull();
    expect(after.event).toMatchObject({ channel: null, externalId: null });
    expect(
      await count(
        'SELECT id FROM field_assertions WHERE record = $m AND is_initial = true AND value = $d;',
        { m: meeting.id, d: dana.id },
      ),
    ).toBe(0);
    expect(await tombstones()).toHaveLength(before.length + 1);
    await expect(log(identity)).rejects.toMatchObject({ code: 'event_retracted' });
  });

  it('deletes the internal notes remember wrote about the record, and only those', async () => {
    const dana = await person();
    const ron = await person();
    await remember(backend, as(AGENT), dana.id, { text: 'Reads email at night' });
    await remember(backend, as(AGENT), ron.id, { text: 'Reads email at dawn' });
    const [danaNote] = await notesAbout(dana.id);
    const [ronNote] = await notesAbout(ron.id);
    expect(danaNote && ronNote).toBeTruthy();
    const before = await tombstones();

    const result = await forget(backend, as(USER), dana.id);
    expect(await storedCount([danaNote?.id ?? ''], 'internalNote')).toBe(0);
    // The fact's text lived on in the note; nothing of it may remain in any
    // object table or the search projection.
    const schema = await schemaOf();
    const tables = [...schema.objectsById.values()].map((o) => o.table);
    for (const tb of [...tables, 'search_documents']) {
      const all = await rows('SELECT * FROM type::table($tb);', { tb });
      expect(JSON.stringify(all)).not.toContain('email at night');
    }
    expect(result.counts).toMatchObject({ events: 1, facts: 1 });
    expect(await storedCount([ronNote?.id ?? ''], 'internalNote')).toBe(1);
    expect((await factsOf(backend, as(USER), ron.id, 10)).facts).toMatchObject([
      { content: 'Reads email at dawn', sources: [{ event: null, internal: true, quote: null }] },
    ]);
    // A note has no external ID, so it leaves no tombstone.
    expect(await tombstones()).toHaveLength(before.length);
  });

  it('keeps refusing an erased identity across a key rotation, and fails closed without the old key', async () => {
    // A workspace of its own: once a key is dropped, its logging fails closed.
    const ws = (await createWorkspace(backend, { name: 'Rotation', template: 'sales' })).id;
    const logIn = (input: Partial<LogEventInput>) =>
      logEventFor(backend, as(AGENT, ws), {
        type: 'call',
        channel: 'rotation',
        occurredAt: '2026-10-29T14:00:00+02:00',
        fields: {},
        participants: [],
        about: [],
        ...input,
      });
    const personIn = () => createRecord(backend, as(AGENT, ws), 'person', { emails: email() });
    const keyIds = async () =>
      [
        ...new Set(
          await rows<string>('SELECT VALUE key_id FROM event_identity_tombstones;', {}, ws),
        ),
      ].sort();

    const oldKey = process.env[SUPPRESSION_KEY_ENV] as string;
    const newKey = 'rotated-suppression-key-fedcba9876543210';
    const previous = process.env[PREVIOUS_KEYS_ENV];
    const dana = await personIn();
    await logIn({ externalId: 'rotate-1', participants: [{ recordId: dana.id }] });
    await forget(backend, as(USER, ws), dana.id);
    try {
      process.env[SUPPRESSION_KEY_ENV] = newKey;
      process.env[PREVIOUS_KEYS_ENV] = oldKey;
      await expect(logIn({ externalId: 'rotate-1' })).rejects.toMatchObject({
        code: 'event_retracted',
      });
      // New erasures use the new key; both keep matching.
      const ron = await personIn();
      await logIn({ externalId: 'rotate-2', participants: [{ recordId: ron.id }] });
      await forget(backend, as(USER, ws), ron.id);
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
          'SELECT id FROM event_identity WHERE external_id IN $ids;',
          { ids: ['rotate-1', 'rotate-4'] },
          ws,
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
    const other = backend.another();
    for (let round = 0; round < 8; round++) {
      const handle = `race${round}@forget.test`;
      const dana = await person({ emails: handle });
      const [, logged] = await Promise.allSettled([
        forget(backend, as(USER), dana.id),
        log({ participants: [{ handle }] }, other),
      ]);
      expect(logged.status).toBe('fulfilled');
      expect(await count('SELECT id FROM event_links WHERE handle = $h;', { h: handle })).toBe(0);
    }
  });

  it('never lets a concurrent log recreate an erased event', async () => {
    const other = backend.another();
    for (let round = 0; round < 8; round++) {
      const dana = await person();
      const ron = await person();
      const identity = { channel: 'race', externalId: `race-event-${round}`, title: 'Race call' };
      const first = await log({ ...identity, participants: [{ recordId: dana.id }] });
      const [forgotten, relogged] = await Promise.allSettled([
        forget(backend, as(USER), dana.id),
        log({ ...identity, participants: [{ recordId: ron.id }] }, other),
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
        await count('SELECT id FROM event_identity WHERE channel = $c AND external_id = $x;', {
          c: 'race',
          x: identity.externalId,
        }),
      ).toBe(0);
      expect(await storedCount([first.id], 'call')).toBe(0);
      await expect(log(identity)).rejects.toMatchObject({ code: 'event_retracted' });
    }
  });

  it('never lets a concurrent create keep an erased email', async () => {
    const other = backend.another();
    for (let round = 0; round < 8; round++) {
      const handle = `create${round}@forget.test`;
      const dana = await person({ emails: { primary: email(), additional: [handle] } });
      const [forgotten, created] = await Promise.allSettled([
        forget(backend, as(USER), dana.id),
        createRecord(other, as(AGENT), 'person', { emails: handle }),
      ]);
      expect(forgotten.status).toBe('fulfilled');
      // Before forget the email is taken; after it, it is suppressed.
      expect(created.status).toBe('rejected');
      expect(
        await count('SELECT id FROM record_identifiers WHERE value = $h;', { h: handle }),
      ).toBe(0);
    }
  });

  it('leaves no fact behind when remember races forget', async () => {
    const other = backend.another();
    for (let round = 0; round < 8; round++) {
      const dana = await person();
      await Promise.allSettled([
        forget(backend, as(USER), dana.id),
        remember(other, as(AGENT), dana.id, { text: `Race fact ${round}` }),
      ]);
      expect(
        await count('SELECT id FROM facts WHERE content = $c;', { c: `Race fact ${round}` }),
      ).toBe(0);
      expect(await storedCount([dana.id], 'person')).toBe(0);
    }
  });
});
