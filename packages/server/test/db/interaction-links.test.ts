import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import type { LogInteractionInput } from '../../src/memory/interactions.js';
import { interactionQuerySchema } from '../../src/memory/query-interactions.js';
import {
  addInteractionLinksFor,
  logInteractionFor,
  queryInteractionsFor,
  readInteraction,
  remember,
  removeLinkFor,
  retractInteractionFor,
} from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  forget,
  mergeRecord,
} from '../../src/records/service.js';
import { contextFor, searchFor } from '../../src/retrieval/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Links', template: 'sales' })).id;
});

let n = 0;
const email = () => `links${++n}@acme.test`;
const externalId = () => `links-${++n}`;
async function person(values: Record<string, unknown> = {}) {
  const address = email();
  const record = await createRecord(app, as(AGENT), 'person', { emails: address, ...values });
  return { ...record, email: address };
}
const company = (name = `Company ${++n}`) => createRecord(app, as(AGENT), 'company', { name });
const log = (input: Partial<LogInteractionInput> = {}) =>
  logInteractionFor(app, as(AGENT), {
    kind: 'meeting',
    channel: 'calendar',
    occurredAt: '2026-10-29T14:00:00+02:00',
    title: 'Pilot review',
    participants: [],
    about: [],
    ...input,
  });
const none = { participants: { matched: [], unmatched: [] }, about: [] };

const count = async (query: Promise<{ count: number }[]>) => (await query)[0]?.count ?? 0;

describe('logging an interaction again adds links (1.3)', () => {
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

  it('still reports a different kind, time, title or summary as a conflict', async () => {
    const id = externalId();
    await log({ externalId: id, summary: 'First' });
    for (const change of [
      { kind: 'call' as const },
      { occurredAt: '2026-10-29T15:00:00+02:00' },
      { title: 'Another title' },
      { summary: 'Second' },
    ]) {
      await expect(log({ externalId: id, summary: 'First', ...change })).rejects.toMatchObject({
        status: 409,
        code: 'interaction_conflict',
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
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
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
    await deleteRecord(app, as(USER), dana.id);
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
    await Promise.all(handles.map((handle) => log({ externalId: id, participants: [{ handle }] })));
    const rows = await db.owner<{ handle: string; position: number }[]>`
      select handle, position from interaction_participants
      where interaction_id = ${first.id} order by position`;
    expect(rows.map((r) => r.handle).sort()).toEqual([...handles].sort());
    expect(rows.map((r) => r.position)).toEqual(handles.map((_, i) => i));
  });

  it('refuses links on a retracted interaction', async () => {
    const id = externalId();
    const logged = await log({ externalId: id });
    await retractInteractionFor(app, as(USER), logged.id);
    await expect(log({ externalId: id, about: [(await company()).id] })).rejects.toMatchObject({
      code: 'interaction_retracted',
    });
    await expect(
      addInteractionLinksFor(app, as(AGENT), logged.id, {
        participants: [],
        about: [(await company()).id],
      }),
    ).rejects.toMatchObject({ status: 404, code: 'interaction_deleted' });
  });
});

describe('about records (1.3)', () => {
  it('lists the interaction on each record it is about, never as an attendee', async () => {
    const dana = await person({ name: 'Dana About' });
    const acme = await company('Acme About');
    const pilot = await createRecord(app, as(AGENT), 'deal', { name: 'Acme pilot' });
    const logged = await log({
      externalId: externalId(),
      title: 'Pilot kickoff',
      participants: [{ handle: dana.email, role: 'customer' }],
      about: [acme.id, pilot.id],
    });
    expect(logged.about).toEqual([acme.id, pilot.id]);
    expect(logged.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);

    const read = await readInteraction(app, as(AGENT), logged.id);
    expect(read.about).toEqual([acme.id, pilot.id]);
    expect(read.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);

    const acmeContext = await contextFor(app, as(AGENT), acme.id, { tokenBudget: 2000 });
    expect(acmeContext.recentInteractions).toEqual([
      expect.objectContaining({ id: logged.id, via: 'about' }),
    ]);
    const danaContext = await contextFor(app, as(AGENT), dana.id, { tokenBudget: 2000 });
    expect(danaContext.recentInteractions).toEqual([
      expect.objectContaining({ id: logged.id, via: 'participant' }),
    ]);

    const hits = await searchFor(app, as(AGENT), { query: 'kickoff', limit: 10 });
    expect(hits.interactions.find((h) => h.id === logged.id)?.records).toEqual([
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
    expect(
      await count(db.owner`
        select count(*)::int from interaction_participants where interaction_id = ${logged.id}`),
    ).toBe(2);
  });

  it('rejects unknown and deleted about records, and follows merges', async () => {
    const gone = await company();
    await deleteRecord(app, as(USER), gone.id);
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
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect((await log({ about: [b.id] })).about).toEqual([a.id]);
  });

  it('replaces an about link when the record is added as a participant', async () => {
    const dana = await person();
    const id = externalId();
    const first = await log({ externalId: id, about: [dana.id] });
    const again = await log({ externalId: id, participants: [{ recordId: dana.id }] });
    expect(again.about).toEqual([]);
    expect(again.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(
      await db.owner`
        select link from interaction_participants where interaction_id = ${first.id}`,
    ).toEqual([{ link: 'participant' }]);
  });

  it('waits for a merge in progress and links to its survivor', async () => {
    const a = await company();
    const b = await company();
    const id = externalId();
    const logged = await log({ externalId: id });
    // A merge of B into A, held open after it has moved B's links and before it commits.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let moved = () => {};
    const holding = new Promise<void>((resolve) => {
      moved = resolve;
    });
    const merge = db.owner.begin(async (t) => {
      await t`select id from records where id = ${b.id} for update`;
      await t`update interaction_participants set record_id = ${a.id} where record_id = ${b.id}`;
      await t`update records set merged_into_id = ${a.id}, deleted_at = now() where id = ${b.id}`;
      moved();
      await gate;
    });
    await holding;
    const relog = log({ externalId: id, about: [b.id] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await merge;
    expect((await relog).about).toEqual([a.id]);
    expect(
      await db.owner`
        select record_id from interaction_participants where interaction_id = ${logged.id}`,
    ).toEqual([{ record_id: a.id }]);
  });

  it('links to the survivor when a merge runs at the same time', async () => {
    for (let round = 0; round < 8; round++) {
      const a = await company();
      const b = await company();
      const dana = await person();
      const id = externalId();
      const logged = await log({ externalId: id, participants: [{ recordId: b.id }] });
      const [merged, relogged] = await Promise.allSettled([
        mergeRecord(app, as(USER), a.id, { recordId: b.id }),
        log({
          externalId: id,
          participants: [{ recordId: b.id }, { recordId: dana.id }],
          about: [b.id],
        }),
      ]);
      expect(merged.status).toBe('fulfilled');
      expect(relogged.status).toBe('fulfilled');
      // B's participant row moved to A, nothing points at B, and no link repeats.
      const rows = await db.owner<{ record_id: string; link: string }[]>`
        select record_id, link from interaction_participants
        where interaction_id = ${logged.id} order by position`;
      expect(rows).toEqual([
        { record_id: a.id, link: 'participant' },
        { record_id: dana.id, link: 'participant' },
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
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect((await readInteraction(app, as(AGENT), both.id)).about).toEqual([a.id]);

    const c = await person();
    const withC = await log({
      externalId: externalId(),
      participants: [{ recordId: c.id }],
      about: [dana.id],
    });
    await mergeRecord(app, as(USER), c.id, { recordId: dana.id });
    const merged = await readInteraction(app, as(AGENT), withC.id);
    expect(merged.about).toEqual([]);
    expect(merged.participants.matched.map((p) => p.recordId)).toEqual([c.id]);
    expect((await readInteraction(app, as(AGENT), attended.id)).about).toEqual([a.id]);
  });

  it('links a note from remember as about its record', async () => {
    const dana = await person();
    const { noteInteraction } = await remember(app, as(AGENT), dana.id, { text: 'Likes tea' });
    const note = await readInteraction(app, as(AGENT), noteInteraction as string);
    expect(note.about).toEqual([dana.id]);
    expect(note.participants).toEqual({ matched: [], unmatched: [] });
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
    const result = await forget(app, as(USER), acme.id);
    expect(result.counts.interactions).toBe(0);
    const read = await readInteraction(app, as(AGENT), meeting.id);
    expect(read.about).toEqual([]);
    expect(read.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(
      await count(db.owner`
        select count(*)::int from interaction_participants where interaction_id = ${meeting.id}`),
    ).toBe(1);
  });

  it('deletes the interactions the person took part in and the notes about them', async () => {
    const dana = await person();
    const acme = await company();
    const meeting = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const { noteInteraction } = await remember(app, as(AGENT), dana.id, { text: 'Prefers calls' });
    const result = await forget(app, as(USER), dana.id);
    expect(result.counts.interactions).toBe(2);
    expect(
      await count(db.owner`
        select count(*)::int from interactions
        where id in (${meeting.id}, ${noteInteraction as string})`),
    ).toBe(0);
  });
});

describe('adding and removing links by route (1.3)', () => {
  it('adds participants and about records idempotently', async () => {
    const logged = await log({ externalId: externalId() });
    const dana = await person();
    const acme = await company();
    const input = { participants: [{ recordId: dana.id, role: 'attendee' }], about: [acme.id] };
    const added = await addInteractionLinksFor(app, as(AGENT), logged.id, input);
    expect(added.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(added.about).toEqual([acme.id]);
    expect(added.added.about).toEqual([acme.id]);
    const again = await addInteractionLinksFor(app, as(AGENT), logged.id, input);
    expect(again.added).toEqual(none);
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
      removeLinkFor(app, as(AGENT), logged.id, { participant: participantId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      removeLinkFor(app, as(AGENT), logged.id, { about: acme.id }),
    ).rejects.toMatchObject({
      status: 403,
    });

    const withoutDana = await removeLinkFor(app, as(USER), logged.id, {
      participant: participantId,
    });
    expect(withoutDana.participants.matched).toEqual([]);
    const withoutAcme = await removeLinkFor(app, as(USER), logged.id, { about: acme.id });
    expect(withoutAcme.about).toEqual([]);
    await expect(removeLinkFor(app, as(USER), logged.id, { about: acme.id })).rejects.toMatchObject(
      {
        status: 404,
      },
    );
    await expect(
      removeLinkFor(app, as(USER), logged.id, { participant: participantId }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('querying interactions (5)', () => {
  const query = (input: Record<string, unknown>) =>
    queryInteractionsFor(app, as(AGENT), interactionQuerySchema.parse(input));

  it('filters by kind, channel, time and linked record, newest or oldest first', async () => {
    const channel = `query-${++n}`;
    const dana = await person();
    const acme = await company();
    const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`;
    const call1 = await log({ channel, kind: 'call', occurredAt: at(2), about: [acme.id] });
    const meeting = await log({
      channel,
      kind: 'meeting',
      occurredAt: at(10),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const call2 = await log({ channel, kind: 'call', occurredAt: at(20) });
    const retracted = await log({ channel, kind: 'call', occurredAt: at(21) });
    await retractInteractionFor(app, as(USER), retracted.id);
    await remember(app, as(AGENT), acme.id, { text: 'A note, not an interaction' });

    const all = await query({ filter: { channel } });
    expect(all.items.map((i) => i.id)).toEqual([call2.id, meeting.id, call1.id]);
    expect(all.total).toBe(3);

    const calls = await query({ filter: { channel, kind: 'call' }, order: 'oldest' });
    expect(calls.items.map((i) => i.id)).toEqual([call1.id, call2.id]);

    const october = await query({
      filter: { channel, occurredAt: { gte: at(5), lt: at(20) } },
    });
    expect(october.items.map((i) => i.id)).toEqual([meeting.id]);

    const aboutAcme = await query({ filter: { record: acme.id } });
    expect(aboutAcme.items.map((i) => i.id)).toEqual([meeting.id, call1.id]);
    expect(aboutAcme.items[0]?.about).toEqual([acme.id]);
    const withDana = await query({ filter: { record: dana.id, link: 'participant' } });
    expect(withDana.items.map((i) => i.id)).toEqual([meeting.id]);
    expect((await query({ filter: { record: dana.id, link: 'about' } })).total).toBe(0);

    await expect(query({ filter: { link: 'about' } })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_query',
    });
  });

  it('pages with a cursor, and counts by kind or channel without items', async () => {
    const channel = `query-${++n}`;
    for (let day = 1; day <= 5; day++) {
      await log({
        channel,
        kind: day % 2 ? 'call' : 'email',
        occurredAt: `2026-09-0${day}T10:00:00Z`,
      });
    }
    const first = await query({ filter: { channel }, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
    const second = await query({ filter: { channel }, limit: 2, cursor: first.nextCursor });
    const third = await query({ filter: { channel }, limit: 2, cursor: second.nextCursor });
    expect(third.nextCursor).toBeNull();
    const seen = [...first.items, ...second.items, ...third.items].map((i) => i.occurredAt);
    expect(seen).toEqual([...seen].sort().reverse());
    expect(new Set(seen).size).toBe(5);

    const counted = await query({ filter: { channel }, countBy: 'kind', limit: 0 });
    expect(counted).toEqual({
      items: [],
      nextCursor: null,
      total: 5,
      counts: { call: 3, email: 2 },
    });
  });
});
