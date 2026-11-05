import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import type { LogEventInput } from '../../src/memory/events.js';
import {
  addEventLinksFor,
  logEventFor,
  readEvent,
  remember,
  removeEventLinkFor,
  retractEventFor,
} from '../../src/memory/service.js';
import { queryInputSchema } from '../../src/records/query.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  findRecords,
  forget,
  mergeRecord,
  withRead,
} from '../../src/records/service.js';
import { directoryEntries } from '../../src/records/store.js';
import { contextFor, searchFor } from '../../src/retrieval/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

beforeAll(async () => {
  workspaceId = (await createWorkspace(backend, { name: 'Links', template: 'sales' })).id;
});

let n = 0;
const email = () => `links${++n}@acme.test`;
const externalId = () => `links-${++n}`;
async function person(values: Record<string, unknown> = {}) {
  const address = email();
  const record = await createRecord(backend, as(AGENT), 'person', { emails: address, ...values });
  return { ...record, email: address };
}
const company = (name = `Company ${++n}`) => createRecord(backend, as(AGENT), 'company', { name });
const log = (input: Partial<LogEventInput> = {}, on: Backend = backend) =>
  logEventFor(on, as(AGENT), {
    type: 'meeting',
    channel: 'calendar',
    occurredAt: '2026-10-29T14:00:00+02:00',
    title: 'Pilot review',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });
const none = { participants: { matched: [], unmatched: [] }, about: [] };

/** Runtime reads of this workspace's database, parameters only. */
const rows = async <T = Record<string, unknown>>(
  text: string,
  vars: Record<string, unknown> = {},
) => (await backend.workspace(workspaceId)).rows<T>(text, vars);
const count = async (text: string, vars: Record<string, unknown> = {}) =>
  (await rows(text, vars)).length;

/** An event's links as reads present them. */
const linksOf = async (id: string) => {
  const { event } = await readEvent(backend, as(AGENT), id);
  if (!event) throw new Error(`${id} is not an event`);
  return event;
};

/** The internal notes `remember` wrote about a record; callers never see their IDs. */
const internalNotesAbout = (recordId: string) =>
  withRead(backend, as(USER), async (db, schema) => {
    const links = await db.rows<{ event: string }>(
      'SELECT event FROM event_links WHERE record = $r;',
      { r: recordId },
    );
    const entries = await directoryEntries(
      db,
      links.map((l) => l.event),
    );
    return [...entries.values()]
      .filter((e) => e.object_type_id === schema.internalNote?.id)
      .map((e) => ({ id: e.id }));
  });

/** Whether records are stored at all, deleted or not: their directory entries. */
const storedCount = async (ids: string[]) =>
  withRead(backend, as(USER), async (db) => (await directoryEntries(db, ids)).size);

/**
 * A second process whose first commit waits until `between` has committed.
 * The SurrealDB counterpart of a transaction blocked on another's row lock:
 * the waiting write's revision check fails and it replans (spec section 6).
 */
function committingFirst(between: () => Promise<unknown>) {
  const other = backend.another();
  const open = other.workspace.bind(other);
  let pending: (() => Promise<unknown>) | undefined = between;
  let commits = 0;
  other.workspace = async (id, options) => {
    const db = await open(id, options);
    return {
      ...db,
      raw: async (text, vars, opts) => {
        if (text.startsWith('BEGIN;')) {
          commits++;
          const run = pending;
          pending = undefined;
          if (run) await run();
        }
        return db.raw(text, vars, opts);
      },
    };
  };
  return { backend: other, commits: () => commits };
}

describe('logging an event again adds links (1.3)', () => {
  it('adds only the new participants and about records, and a retry adds nothing', async () => {
    const dana = await person();
    const acme = await company();
    const id = externalId();
    const first = await log({ externalId: id, participants: [{ handle: dana.email }] });

    const extra = email();
    const again = await log({
      externalId: id,
      participants: [{ handle: dana.email }, { handle: extra, role: 'guest' }],
      about: [acme.id],
    });
    expect(again).toMatchObject({ id: first.id, created: false, about: [acme.id] });
    expect(again.added).toEqual({
      participants: {
        matched: [],
        unmatched: [{ id: expect.any(String), handle: extra, role: 'guest', reason: 'no_match' }],
      },
      about: [acme.id],
    });
    expect(again.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(again.participants.unmatched.map((p) => p.handle)).toEqual([extra]);

    const retry = await log({
      externalId: id,
      participants: [{ handle: dana.email }, { handle: extra, role: 'guest' }],
      about: [acme.id],
    });
    expect(retry.added).toEqual(none);
    expect(retry.participants).toEqual(again.participants);

    // A sync that logs the original, shorter list again removes nothing.
    const stale = await log({ externalId: id, participants: [{ handle: dana.email }] });
    expect(stale.added).toEqual(none);
    expect(stale.participants).toEqual(again.participants);
    expect(stale.about).toEqual([acme.id]);
  });

  it('still reports a different type, time, title or summary as a conflict', async () => {
    const id = externalId();
    await log({ externalId: id, summary: 'First' });
    for (const change of [
      { type: 'call' },
      { occurredAt: '2026-10-29T15:00:00+02:00' },
      { title: 'Another title' },
      { summary: 'Second' },
    ]) {
      await expect(log({ externalId: id, summary: 'First', ...change })).rejects.toMatchObject({
        status: 409,
        code: 'event_conflict',
      });
    }
    // The same instant written with another offset is the same time.
    await expect(
      log({ externalId: id, summary: 'First', occurredAt: '2026-10-29T12:00:00Z' }),
    ).resolves.toMatchObject({ created: false });
  });

  it('matches a stored participant by record ID through a merge', async () => {
    const a = await person();
    const b = await person();
    const id = externalId();
    await log({ externalId: id, participants: [{ recordId: b.id, role: 'attendee' }] });
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    const again = await log({
      externalId: id,
      participants: [{ recordId: b.id, role: 'attendee' }],
    });
    expect(again.added).toEqual(none);
    expect(again.participants.matched).toEqual([
      { id: expect.any(String), handle: null, role: 'attendee', recordId: a.id },
    ]);
  });

  it('keeps a participant whose record was deleted since, without failing the re-log', async () => {
    const dana = await person();
    const id = externalId();
    await log({ externalId: id, participants: [{ recordId: dana.id }] });
    await deleteRecord(backend, as(USER), dana.id);
    const acme = await company();
    const again = await log({
      externalId: id,
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    expect(again.added).toEqual({ ...none, about: [acme.id] });
  });

  it('lands concurrent additions with different participants, each once and in order', async () => {
    const id = externalId();
    const first = await log({ externalId: id });
    const handles = Array.from({ length: 8 }, () => email());
    // Two processes, so the local queue cannot hide the conflicts.
    const other = backend.another();
    await Promise.all(
      handles.map((handle, i) =>
        log({ externalId: id, participants: [{ handle }] }, i % 2 ? other : backend),
      ),
    );
    const found = await rows<{ handle: string; position: number }>(
      'SELECT handle, position FROM event_links WHERE event = $e ORDER BY position;',
      { e: first.id },
    );
    expect(found.map((r) => r.handle).sort()).toEqual([...handles].sort());
    expect(found.map((r) => r.position)).toEqual(handles.map((_, i) => i));
  });

  it('refuses links on a deleted event', async () => {
    const id = externalId();
    const logged = await log({ externalId: id });
    await retractEventFor(backend, as(USER), logged.id);
    await expect(log({ externalId: id, about: [(await company()).id] })).rejects.toMatchObject({
      code: 'event_retracted',
    });
    await expect(
      addEventLinksFor(backend, as(AGENT), logged.id, {
        participants: [],
        about: [(await company()).id],
      }),
    ).rejects.toMatchObject({ status: 404, code: 'record_deleted' });
  });
});

describe('about records (1.3)', () => {
  // needs retrieval/* (read-side port in progress)
  it.skip('lists the event on each record it is about, never as an attendee', async () => {
    const dana = await person({ name: 'Dana About' });
    const acme = await company('Acme About');
    const pilot = await createRecord(backend, as(AGENT), 'deal', { name: 'Acme pilot' });
    const logged = await log({
      externalId: externalId(),
      title: 'Pilot kickoff',
      participants: [{ handle: dana.email, role: 'customer' }],
      about: [acme.id, pilot.id],
    });
    expect(logged.about).toEqual([acme.id, pilot.id]);
    expect(logged.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);

    const read = await linksOf(logged.id);
    expect(read.about).toEqual([acme.id, pilot.id]);
    expect(read.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);

    const acmeContext = await contextFor(backend as never, as(AGENT), acme.id, {
      tokenBudget: 2000,
    });
    expect(acmeContext.recentEvents).toEqual([
      expect.objectContaining({ id: logged.id, type: 'meeting', via: { kind: 'about' } }),
    ]);
    const danaContext = await contextFor(backend as never, as(AGENT), dana.id, {
      tokenBudget: 2000,
    });
    expect(danaContext.recentEvents).toEqual([
      expect.objectContaining({ id: logged.id, type: 'meeting', via: { kind: 'participant' } }),
    ]);

    const hits = await searchFor(backend as never, as(AGENT), { query: 'kickoff', limit: 10 });
    expect(hits.events.find((h) => h.id === logged.id)?.records).toEqual([
      dana.id,
      acme.id,
      pilot.id,
    ]);
  });

  it('drops repeated about records and records already listed as participants', async () => {
    const dana = await person();
    const acme = await company();
    const logged = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id, dana.id, acme.id],
    });
    expect(logged.about).toEqual([acme.id]);
    expect(await count('SELECT id FROM event_links WHERE event = $e;', { e: logged.id })).toBe(2);
  });

  it('rejects unknown and deleted about records, and follows merges', async () => {
    const gone = await company();
    await deleteRecord(backend, as(USER), gone.id);
    const unknown = '00000000-0000-4000-8000-000000000000';
    await expect(log({ about: [unknown, gone.id] })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_about',
      details: {
        errors: [
          { index: 0, recordId: unknown, message: 'no record with this ID' },
          { index: 1, recordId: gone.id, message: 'the record is deleted' },
        ],
      },
    });
    const a = await company();
    const b = await company();
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    expect((await log({ about: [b.id] })).about).toEqual([a.id]);
  });

  it('may be about another event, but not about itself (6.2)', async () => {
    const earlier = await log({ type: 'call', channel: 'zoom', title: 'Discovery call' });
    const id = externalId();
    const followUp = await log({ externalId: id, title: 'Follow-up', about: [earlier.id] });
    expect(followUp.about).toEqual([earlier.id]);
    const linked = await findRecords(
      backend,
      as(AGENT),
      'meeting',
      queryInputSchema.parse({ linked: { record: earlier.id, link: 'about' } }),
    );
    expect(linked.records.map((r) => r.id)).toEqual([followUp.id]);

    const itself = {
      status: 422,
      code: 'invalid_about',
      details: {
        errors: [{ index: 0, recordId: followUp.id, message: 'an event cannot be about itself' }],
      },
    };
    await expect(
      log({ externalId: id, title: 'Follow-up', about: [followUp.id] }),
    ).rejects.toMatchObject(itself);
    await expect(
      addEventLinksFor(backend, as(AGENT), followUp.id, {
        participants: [],
        about: [followUp.id],
      }),
    ).rejects.toMatchObject(itself);
  });

  it('replaces an about link when the record is added as a participant', async () => {
    const dana = await person();
    const id = externalId();
    const first = await log({ externalId: id, about: [dana.id] });
    const again = await log({ externalId: id, participants: [{ recordId: dana.id }] });
    expect(again.about).toEqual([]);
    expect(again.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(await rows('SELECT link FROM event_links WHERE event = $e;', { e: first.id })).toEqual([
      { link: 'participant' },
    ]);
  });

  it('waits for a merge in progress and links to its survivor', async () => {
    const a = await company();
    const b = await company();
    const id = externalId();
    const logged = await log({ externalId: id });
    // Postgres held a merge of B into A open after it moved B's links; the
    // re-log waited on B's row lock. Here the merge commits while the re-log
    // is planned, and the re-log's revision check makes it replan.
    const relog = committingFirst(() => mergeRecord(backend, as(USER), a.id, { recordId: b.id }));
    expect((await log({ externalId: id, about: [b.id] }, relog.backend)).about).toEqual([a.id]);
    expect(relog.commits()).toBe(2);
    expect(
      await rows('SELECT record FROM event_links WHERE event = $e;', { e: logged.id }),
    ).toEqual([{ record: a.id }]);
  });

  it('removes an about link that a merge in progress is moving', async () => {
    const a = await company();
    const b = await company();
    const logged = await log({ about: [b.id] });
    // As above: the merge of B into A commits while the removal is planned.
    const removal = committingFirst(() => mergeRecord(backend, as(USER), a.id, { recordId: b.id }));
    const removed = await removeEventLinkFor(removal.backend, as(USER), logged.id, {
      about: b.id,
    });
    expect(removal.commits()).toBe(2);
    expect(removed.event?.about).toEqual([]);
    expect(await count('SELECT id FROM event_links WHERE event = $e;', { e: logged.id })).toBe(0);
  });

  it('links to the survivor when a merge runs at the same time', async () => {
    const other = backend.another();
    for (let round = 0; round < 8; round++) {
      const a = await company();
      const b = await company();
      const dana = await person();
      const id = externalId();
      const logged = await log({ externalId: id, participants: [{ recordId: b.id }] });
      const [merged, relogged] = await Promise.allSettled([
        mergeRecord(backend, as(USER), a.id, { recordId: b.id }),
        log(
          {
            externalId: id,
            participants: [{ recordId: b.id }, { recordId: dana.id }],
            about: [b.id],
          },
          other,
        ),
      ]);
      expect(merged.status).toBe('fulfilled');
      expect(relogged.status).toBe('fulfilled');
      // B's participant row moved to A, nothing points at B, and no link repeats.
      const found = await rows<{ record: string; link: string; position: number }>(
        'SELECT record, link, position FROM event_links WHERE event = $e ORDER BY position;',
        { e: logged.id },
      );
      expect(found.map(({ record, link }) => ({ record, link }))).toEqual([
        { record: a.id, link: 'participant' },
        { record: dana.id, link: 'participant' },
      ]);
    }
  });

  it('keeps one link per record when a merge would repeat it', async () => {
    const a = await company();
    const b = await company();
    const dana = await person();
    const both = await log({ externalId: externalId(), about: [a.id, b.id] });
    const attended = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [b.id],
    });
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    expect((await linksOf(both.id)).about).toEqual([a.id]);

    const c = await person();
    const withC = await log({
      externalId: externalId(),
      participants: [{ recordId: c.id }],
      about: [dana.id],
    });
    await mergeRecord(backend, as(USER), c.id, { recordId: dana.id });
    const merged = await linksOf(withC.id);
    expect(merged.about).toEqual([]);
    expect(merged.participants.matched.map((p) => p.recordId)).toEqual([c.id]);
    expect((await linksOf(attended.id)).about).toEqual([a.id]);
  });

  // needs retrieval/* (read-side port in progress)
  it.skip('links a note from remember as about its record', async () => {
    const dana = await person();
    await remember(backend, as(AGENT), dana.id, { text: 'Likes tea' });
    const [note] = await internalNotesAbout(dana.id);
    const links = await rows<{
      record?: string | null;
      link: string;
      handle?: string | null;
      role?: string | null;
    }>('SELECT record, link, handle, role FROM event_links WHERE event = $e;', {
      e: note?.id as string,
    });
    // Absent optional columns read back as absent, not null.
    expect(
      links.map((l) => ({
        record: l.record ?? null,
        link: l.link,
        handle: l.handle ?? null,
        role: l.role ?? null,
      })),
    ).toEqual([{ record: dana.id, link: 'about', handle: null, role: null }]);
    // The note is not an event any caller can list.
    const context = await contextFor(backend as never, as(AGENT), dana.id, {
      tokenBudget: 2000,
    });
    expect(context.recentEvents).toEqual([]);
    expect(context.facts).toEqual([
      expect.objectContaining({ content: 'Likes tea', internal: true }),
    ]);
  });
});

describe('forget and about records (2.1)', () => {
  it('keeps a meeting only about the forgotten record, and drops the link', async () => {
    const dana = await person();
    const acme = await company();
    const meeting = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const result = await forget(backend, as(USER), acme.id);
    expect(result.counts.events).toBe(0);
    const read = await linksOf(meeting.id);
    expect(read.about).toEqual([]);
    expect(read.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(await count('SELECT id FROM event_links WHERE event = $e;', { e: meeting.id })).toBe(1);
  });

  it('deletes the events the person took part in and the notes about them', async () => {
    const dana = await person();
    const acme = await company();
    const meeting = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    await remember(backend, as(AGENT), dana.id, { text: 'Prefers calls' });
    const [note] = await internalNotesAbout(dana.id);
    expect(note).toBeDefined();
    const result = await forget(backend, as(USER), dana.id);
    expect(result.counts.events).toBe(2);
    expect(await storedCount([meeting.id, note?.id as string])).toBe(0);
  });
});

describe('adding and removing links by route (1.3)', () => {
  it('adds participants and about records idempotently', async () => {
    const logged = await log({ externalId: externalId() });
    const dana = await person();
    const acme = await company();
    const input = { participants: [{ recordId: dana.id, role: 'attendee' }], about: [acme.id] };
    const added = await addEventLinksFor(backend, as(AGENT), logged.id, input);
    expect(added.event?.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(added.event?.about).toEqual([acme.id]);
    expect(added.added.about).toEqual([acme.id]);
    const again = await addEventLinksFor(backend, as(AGENT), logged.id, input);
    expect(again.added).toEqual(none);
  });

  it('adds links only to an event', async () => {
    const dana = await person();
    const acme = await company();
    await expect(
      addEventLinksFor(backend, as(AGENT), acme.id, { participants: [], about: [dana.id] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('lets only a person remove a participant or an about record', async () => {
    const dana = await person();
    const acme = await company();
    const logged = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const participantId = logged.participants.matched[0]?.id as string;
    await expect(
      removeEventLinkFor(backend, as(AGENT), logged.id, { participant: participantId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      removeEventLinkFor(backend, as(AGENT), logged.id, { about: acme.id }),
    ).rejects.toMatchObject({
      status: 403,
    });

    const withoutDana = await removeEventLinkFor(backend, as(USER), logged.id, {
      participant: participantId,
    });
    expect(withoutDana.event?.participants.matched).toEqual([]);
    const withoutAcme = await removeEventLinkFor(backend, as(USER), logged.id, { about: acme.id });
    expect(withoutAcme.event?.about).toEqual([]);
    await expect(
      removeEventLinkFor(backend, as(USER), logged.id, { about: acme.id }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      removeEventLinkFor(backend, as(USER), logged.id, { participant: participantId }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('querying events (7.1)', () => {
  const query = (type: string, input: Record<string, unknown>) =>
    findRecords(backend, as(AGENT), type, queryInputSchema.parse(input));
  const ids = (page: { records: { id: string }[] }) => page.records.map((r) => r.id);
  const newest = [{ field: 'occurredAt', direction: 'desc' }];

  it('filters by type, channel, time and linked record, newest or oldest first', async () => {
    const channel = `query-${++n}`;
    const dana = await person();
    const acme = await company();
    const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`;
    const call1 = await log({ channel, type: 'call', occurredAt: at(2), about: [acme.id] });
    const meeting = await log({
      channel,
      type: 'meeting',
      occurredAt: at(10),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const call2 = await log({ channel, type: 'call', occurredAt: at(20) });
    const retracted = await log({ channel, type: 'call', occurredAt: at(21) });
    await retractEventFor(backend, as(USER), retracted.id);
    await remember(backend, as(AGENT), acme.id, { text: 'A note, not an event' });

    const calls = await query('call', { filter: { channel }, sort: newest });
    expect(ids(calls)).toEqual([call2.id, call1.id]);
    expect(calls.records[0]?.event).toMatchObject({
      channel,
      occurredAt: new Date(at(20)).toISOString(),
    });
    const oldest = await query('calls', {
      filter: { channel },
      sort: [{ field: 'occurredAt', direction: 'asc' }],
    });
    expect(ids(oldest)).toEqual([call1.id, call2.id]);
    expect(ids(await query('meeting', { filter: { channel } }))).toEqual([meeting.id]);

    const october = await query('call', {
      filter: { channel, occurredAt: { gte: at(1), lt: at(20) } },
    });
    expect(ids(october)).toEqual([call1.id]);

    const aboutAcme = await query('call', { linked: { record: acme.id }, sort: newest });
    expect(ids(aboutAcme)).toEqual([call1.id]);
    expect(aboutAcme.records[0]?.event?.about).toEqual([acme.id]);
    expect(ids(await query('meeting', { linked: { record: acme.id } }))).toEqual([meeting.id]);
    // The note remember wrote about Acme is never listed.
    expect(ids(await query('note', { linked: { record: acme.id } }))).toEqual([]);
    await expect(query('internalNote', {})).rejects.toMatchObject({ status: 404 });

    const withDana = await query('meeting', { linked: { record: dana.id, link: 'participant' } });
    expect(ids(withDana)).toEqual([meeting.id]);
    expect(ids(await query('meeting', { linked: { record: dana.id, link: 'about' } }))).toEqual([]);

    // `linked` needs a record, and applies to event types only.
    expect(queryInputSchema.safeParse({ linked: { link: 'about' } }).success).toBe(false);
    await expect(query('person', { linked: { record: acme.id } })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_filter',
    });
  });

  // needs retrieval/* (read-side port in progress)
  it.skip('attaches an event through its own relation field, after participant and about (6.3)', async () => {
    await runSchemaChange(backend, {
      workspaceId,
      actor: USER,
      scopes: ['schema:write', 'admin'],
      operations: [
        {
          op: 'create_field',
          object: 'call',
          field: {
            name: 'deal',
            label: 'Deal',
            type: 'relation',
            settings: { targetObject: 'deal', inverseField: 'calls' },
          },
        },
      ],
    });
    const pilot = await createRecord(backend, as(AGENT), 'deal', { name: 'Field pilot' });
    const byField = await log({ type: 'call', fields: { deal: pilot.id } });
    const both = await log({ type: 'call', fields: { deal: pilot.id }, about: [pilot.id] });

    const viaField = await query('call', { linked: { record: pilot.id, link: 'field' } });
    expect(ids(viaField).sort()).toEqual([byField.id, both.id].sort());
    const viaAbout = await query('call', { linked: { record: pilot.id, link: 'about' } });
    expect(ids(viaAbout)).toEqual([both.id]);

    const context = await contextFor(backend as never, as(AGENT), pilot.id, {
      tokenBudget: 2000,
    });
    expect(context.recentEvents.map((e) => [e.id, e.via]).sort()).toEqual(
      [
        [byField.id, { kind: 'field', field: 'deal' }],
        [both.id, { kind: 'about' }],
      ].sort(),
    );
  });

  it('pages with a cursor', async () => {
    const channel = `query-${++n}`;
    for (let day = 1; day <= 5; day++) {
      await log({ channel, type: 'call', occurredAt: `2026-09-0${day}T10:00:00Z` });
    }
    const first = await query('call', { filter: { channel }, sort: newest, limit: 2 });
    expect(first.records).toHaveLength(2);
    const second = await query('call', {
      filter: { channel },
      sort: newest,
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await query('call', {
      filter: { channel },
      sort: newest,
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.nextCursor).toBeNull();
    const seen = [...first.records, ...second.records, ...third.records].map(
      (r) => r.event?.occurredAt as string,
    );
    expect(seen).toEqual([...seen].sort().reverse());
    expect(new Set(seen).size).toBe(5);
  });
});
