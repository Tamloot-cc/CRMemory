import { type Actor, INTERNAL_NOTE_TYPE_ID } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import type { AppError } from '../../src/errors.js';
import type { LogEventInput } from '../../src/memory/events.js';
import { type MoveEventsInput, moveEventsInputSchema } from '../../src/memory/move.js';
import {
  factsOf,
  logEventFor,
  moveEventsFor,
  readEvent,
  remember,
} from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  findRecords,
  patchRecord,
  readRecord,
  upsertRecord,
} from '../../src/records/service.js';
import { timelineFor } from '../../src/retrieval/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';
import { expectDataMatchesAssertions } from '../helpers/records.js';

/**
 * Moving events between event types (ARCHITECTURE.md 1.3; spec 7, question
 * 2): what survives, how fields map, what is refused, and that a move is
 * one atomic step against concurrent writes.
 */

const db = useTestDatabase();
let app: Sql;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const ADMIN: Actor = { type: 'user', id: 'maya' };
const ALL_SCOPES = ['read', 'write', 'schema:write', 'admin'] as const;

beforeAll(() => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
});

/** A workspace with a legacy `meeting` type and a `conversation` able to take its fields. */
async function workspace() {
  const id = (await createWorkspace(db.owner, { name: `Move ${Math.random()}`, template: 'sales' }))
    .id;
  const as = (actor: Actor): Caller => ({ workspaceId: id, actor, scopes: ALL_SCOPES });
  const change = async (operations: SchemaOperation[]) => {
    const result = await inWorkspace(app, id, (tx) =>
      runSchemaChange(tx, { workspaceId: id, actor: ADMIN, scopes: ALL_SCOPES, operations }),
    );
    expect(result.status, result.change?.error ?? '').toBe('applied');
  };
  await change([
    {
      op: 'create_object',
      object: {
        class: 'event',
        nameSingular: 'meeting',
        namePlural: 'meetings',
        labelSingular: 'Meeting',
        labelPlural: 'Meetings',
        fields: [
          { name: 'agenda', label: 'Agenda', type: 'text' },
          { name: 'score', label: 'Score', type: 'number' },
          {
            name: 'stage',
            label: 'Stage',
            type: 'select',
            settings: {
              options: [
                { value: 'early', label: 'Early' },
                { value: 'late', label: 'Late' },
              ],
            },
          },
          {
            name: 'account',
            label: 'Account',
            type: 'relation',
            settings: { targetObject: 'company', inverseField: 'meetings' },
          },
        ],
      },
    },
    {
      op: 'create_field',
      object: 'conversation',
      field: { name: 'topic', label: 'Topic', type: 'text' },
    },
    {
      op: 'create_field',
      object: 'conversation',
      field: { name: 'score', label: 'Score', type: 'text' },
    },
    {
      op: 'create_field',
      object: 'conversation',
      field: {
        name: 'stage',
        label: 'Stage',
        type: 'select',
        settings: { options: [{ value: 'early', label: 'Early' }] },
      },
    },
    {
      op: 'create_field',
      object: 'conversation',
      field: {
        name: 'account',
        label: 'Account',
        type: 'relation',
        settings: { targetObject: 'company', inverseField: 'conversations' },
      },
    },
  ]);

  let n = 0;
  const log = async (input: Partial<LogEventInput> = {}) =>
    logEventFor(app, as(AGENT), {
      type: 'meeting',
      channel: 'tamloot',
      externalId: `rec-${++n}`,
      occurredAt: `2026-10-${String(1 + (n % 27)).padStart(2, '0')}T10:00:00Z`,
      title: `Meeting ${n}`,
      fields: {},
      participants: [],
      about: [],
      ...input,
    });
  const move = (input: Partial<MoveEventsInput>, actor = ADMIN) =>
    moveEventsFor(
      app,
      as(actor),
      moveEventsInputSchema.parse({ from: 'meeting', to: 'conversation', ...input }),
    );
  const typeOf = async (eventId: string) => {
    const [row] = await db.owner<{ name: string }[]>`
      select o.name_singular as name from records r join object_types o on o.id = r.object_type_id
      where r.id = ${eventId}`;
    return row?.name;
  };
  return { id, as, change, log, move, typeOf };
}

/** Catches an AppError from `promise`, for its status, code and details. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the call to fail');
}

/** Assertions on events that belong to a field of another object than their record's. */
async function strayAssertions(workspaceId: string): Promise<number> {
  const [row] = await db.owner<{ count: number }[]>`
    select count(*)::int as count from field_assertions a
    join records r on r.id = a.record_id
    join fields f on f.id = a.field_id
    where a.workspace_id = ${workspaceId} and f.object_type_id <> r.object_type_id`;
  return row?.count ?? -1;
}

describe('moving one event', () => {
  it('keeps its ID, identity, links, the claims and facts citing it, and its timeline', async () => {
    const w = await workspace();
    const acme = await createRecord(app, w.as(AGENT), 'company', { name: 'Acme' });
    const dana = await createRecord(app, w.as(AGENT), 'person', {
      name: 'Dana Levi',
      emails: 'dana@acme.test',
    });
    const meeting = await w.log({
      externalId: 'rec-pricing',
      title: 'Pricing review',
      summary: 'Went through the renewal price.',
      fields: { agenda: 'Pricing', stage: 'early', account: acme.id },
      participants: [{ handle: 'dana@acme.test', role: 'customer' }],
      about: [acme.id],
    });
    const other = await w.log();
    await upsertRecord(app, w.as(AGENT), 'person', {
      id: dana.id,
      values: { jobTitle: 'CTO' },
      ifMissing: 'fail',
      source: meeting.id,
    });
    const fact = await remember(app, w.as(AGENT), acme.id, {
      text: 'Acme renews annually.',
      source: meeting.id,
    });
    // A later correction is an ordinary assertion, and moves with the rest.
    await patchRecord(app, w.as(ADMIN), meeting.id, { values: { agenda: 'Pricing and SSO' } });

    const result = await w.move({
      events: [meeting.id],
      fields: { agenda: 'topic' },
      defaults: { medium: 'meeting' },
    });
    expect(result).toMatchObject({
      id: expect.any(String),
      dryRun: false,
      from: 'meeting',
      to: 'conversation',
      eventIds: [meeting.id],
      dropped: [],
      defaults: [{ field: 'medium', events: 1 }],
    });
    expect(result.fields).toEqual(
      expect.arrayContaining([
        { from: 'title', to: 'title', events: 1 },
        { from: 'agenda', to: 'topic', events: 1 },
        { from: 'stage', to: 'stage', events: 1 },
        { from: 'account', to: 'account', events: 1 },
      ]),
    );

    // The same record, now a conversation, with its built-in columns and links.
    const read = await readEvent(app, w.as(AGENT), meeting.id);
    expect(read).toMatchObject({
      id: meeting.id,
      object: 'conversation',
      label: 'Pricing review',
      fields: {
        title: 'Pricing review',
        summary: 'Went through the renewal price.',
        topic: 'Pricing and SSO',
        stage: 'early',
        account: acme.id,
        medium: 'meeting',
      },
      updatedBy: ADMIN,
      event: {
        channel: 'tamloot',
        externalId: 'rec-pricing',
        about: [acme.id],
        participants: { matched: [{ recordId: dana.id, role: 'customer' }] },
      },
    });
    await expectDataMatchesAssertions(app, w.id, meeting.id);
    expect(await strayAssertions(w.id)).toBe(0);
    // Assertions keep their actors and history; the old topic is superseded.
    const history = await db.owner<{ status: string; actor: Actor; is_initial: boolean }[]>`
      select a.status, a.actor, a.is_initial from field_assertions a
      join fields f on f.id = a.field_id
      where a.record_id = ${meeting.id} and f.name = 'topic' order by a.created_at`;
    expect(history).toEqual([
      { status: 'superseded', actor: AGENT, is_initial: true },
      { status: 'active', actor: ADMIN, is_initial: false },
    ]);

    // The claims and facts citing it stand.
    expect((await readRecord(app, w.as(AGENT), dana.id)).fields.jobTitle).toBe('CTO');
    const facts = await factsOf(app, w.as(AGENT), acme.id, 10);
    expect(facts.facts.map((f) => f.id)).toContain(fact.fact.id);
    expect(facts.facts[0]?.sources).toEqual([expect.objectContaining({ event: meeting.id })]);

    // It lists, searches and attaches as a conversation; the other meeting stays.
    const conversations = await findRecords(app, w.as(AGENT), 'conversation', {
      linked: { record: acme.id },
      limit: 50,
    });
    expect(conversations.records.map((r) => r.id)).toEqual([meeting.id]);
    const byAccount = await findRecords(app, w.as(AGENT), 'conversation', {
      filter: { account: acme.id },
      limit: 50,
    });
    expect(byAccount.records.map((r) => r.id)).toEqual([meeting.id]);
    const found = await findRecords(app, w.as(AGENT), 'conversation', {
      search: 'pricing',
      limit: 50,
    });
    expect(found.records.map((r) => r.id)).toEqual([meeting.id]);
    const meetings = await findRecords(app, w.as(AGENT), 'meeting', { limit: 50 });
    expect(meetings.records.map((r) => r.id)).toEqual([other.id]);
    const timeline = await timelineFor(app, w.as(AGENT), acme.id, {
      types: ['event'],
      limit: 50,
    });
    expect(timeline.items).toEqual([
      expect.objectContaining({ kind: 'event', id: meeting.id, type: 'conversation' }),
    ]);

    // The source is deduplicated against it as a conversation: a re-log with
    // the moved values and the default matches; the old type conflicts.
    const relog = await logEventFor(app, w.as(AGENT), {
      type: 'conversation',
      channel: 'tamloot',
      externalId: 'rec-pricing',
      occurredAt: '2026-10-02T10:00:00Z',
      title: 'Pricing review',
      summary: 'Went through the renewal price.',
      fields: { topic: 'Pricing', stage: 'early', account: acme.id, medium: 'meeting' },
      participants: [],
      about: [],
    });
    expect(relog).toMatchObject({ id: meeting.id, created: false });
    const asMeeting = await failure(
      logEventFor(app, w.as(AGENT), {
        type: 'meeting',
        channel: 'tamloot',
        externalId: 'rec-pricing',
        occurredAt: '2026-10-02T10:00:00Z',
        title: 'Pricing review',
        fields: {},
        participants: [],
        about: [],
      }),
    );
    expect(asMeeting.code).toBe('event_conflict');

    // The log records who moved what, with names and IDs only.
    const [entry] = await db.owner<{ actor: Actor; event_ids: string[]; fields: unknown }[]>`
      select actor, event_ids, fields from event_moves where id = ${result.id as string}`;
    expect(entry).toMatchObject({ actor: ADMIN, event_ids: [meeting.id] });
  });

  it('reports a dry run exactly and changes nothing', async () => {
    const w = await workspace();
    const meeting = await w.log({ fields: { agenda: 'Roadmap' } });
    const before = await readEvent(app, w.as(AGENT), meeting.id);

    const plan = await w.move(
      { drop: ['agenda'], defaults: { medium: 'meeting' }, dryRun: true },
      AGENT,
    );
    expect(plan).toMatchObject({
      id: null,
      dryRun: true,
      eventIds: [meeting.id],
      dropped: [{ field: 'agenda', events: 1, assertions: 1 }],
      defaults: [{ field: 'medium', events: 1 }],
    });
    expect(await w.typeOf(meeting.id)).toBe('meeting');
    expect(await readEvent(app, w.as(AGENT), meeting.id)).toEqual(before);
    const [log] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from event_moves where workspace_id = ${w.id}`;
    expect(log?.count).toBe(0);
  });
});

describe('moving every event of a type', () => {
  it('moves them all at once, and the emptied type can then be deleted without retracting anything', async () => {
    const w = await workspace();
    const acme = await createRecord(app, w.as(AGENT), 'company', { name: 'Acme' });
    const events = [await w.log(), await w.log(), await w.log()];
    await upsertRecord(app, w.as(AGENT), 'company', {
      id: acme.id,
      values: { industry: 'Software' },
      ifMissing: 'fail',
      source: events[0]?.id,
    });
    const gone = await w.log();
    await deleteRecord(app, w.as(ADMIN), gone.id);
    await w.change([
      {
        op: 'create_object',
        object: {
          class: 'event',
          nameSingular: 'call',
          namePlural: 'calls',
          labelSingular: 'Call',
          labelPlural: 'Calls',
          fields: [],
        },
      },
    ]);
    const call = await w.log({ type: 'call' });

    const result = await w.move({ defaults: { medium: 'meeting' } });
    expect(result.eventIds).toEqual(events.map((e) => e.id).sort());
    expect(result.defaults).toEqual([{ field: 'medium', events: 3 }]);
    expect((await findRecords(app, w.as(AGENT), 'meeting', { limit: 50 })).records).toEqual([]);
    for (const event of events) {
      expect(await w.typeOf(event.id)).toBe('conversation');
      await expectDataMatchesAssertions(app, w.id, event.id);
    }
    // A deleted event stays deleted, where it was; another type is untouched.
    expect(await w.typeOf(gone.id)).toBe('meeting');
    expect(await w.typeOf(call.id)).toBe('call');

    // Deleting the empty type deletes no event, so nothing that cites one is retracted.
    await w.change([{ op: 'delete_object', object: 'meeting' }]);
    expect((await readRecord(app, w.as(AGENT), acme.id)).fields.industry).toBe('Software');
    const moved = await findRecords(app, w.as(AGENT), 'conversation', {
      filter: { medium: 'meeting' },
      limit: 50,
    });
    expect(moved.records.map((r) => r.id).sort()).toEqual(result.eventIds);
    // The deleted event's identity is still suppressed.
    const relog = await failure(
      logEventFor(app, w.as(AGENT), {
        type: 'conversation',
        channel: 'tamloot',
        externalId: await readExternalId(gone.id),
        occurredAt: '2026-10-05T10:00:00Z',
        fields: {},
        participants: [],
        about: [],
      }),
    );
    expect(relog.code).toBe('event_retracted');
  });

  it('moves nothing, and says so, when the type has no live events', async () => {
    const w = await workspace();
    const result = await w.move({});
    expect(result).toMatchObject({ id: null, eventIds: [], fields: [], dropped: [] });
  });
});

/** An event's external ID, read as the owner (deleted events are not readable). */
async function readExternalId(id: string): Promise<string> {
  const [row] = await db.owner<{ external_id: string }[]>`
    select external_id from event_records where record_id = ${id}`;
  return row?.external_id as string;
}

describe('fields the target cannot hold', () => {
  it('refuses values it has no field for with the list, unless the caller drops them', async () => {
    const w = await workspace();
    const meeting = await w.log({ fields: { agenda: 'Roadmap' } });
    await patchRecord(app, w.as(AGENT), meeting.id, { values: { agenda: 'Roadmap v2' } });

    const refused = await failure(w.move({}));
    expect(refused).toMatchObject({
      status: 422,
      code: 'unmapped_fields',
      details: {
        fields: [
          {
            field: 'agenda',
            events: 1,
            assertions: 2,
            reason: expect.stringContaining('no field named agenda'),
          },
        ],
      },
    });
    expect(await w.typeOf(meeting.id)).toBe('meeting');

    const moved = await w.move({ drop: ['agenda'] });
    expect(moved.dropped).toEqual([{ field: 'agenda', events: 1, assertions: 2 }]);
    const [left] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from field_assertions a join fields f on f.id = a.field_id
      where a.record_id = ${meeting.id} and f.name = 'agenda'`;
    expect(left?.count).toBe(0);
    await expectDataMatchesAssertions(app, w.id, meeting.id);
  });

  it('moves a field with no values without asking', async () => {
    const w = await workspace();
    const meeting = await w.log();
    expect((await w.move({})).eventIds).toEqual([meeting.id]);
  });

  it('refuses values that do not fit the mapped field, and moves no event of the batch', async () => {
    const w = await workspace();
    const fits = await w.log({ fields: { stage: 'early' } });
    const late = await w.log({ fields: { stage: 'late' } });
    const scored = await w.log({ fields: { score: 7 } });
    const before = await readEvent(app, w.as(AGENT), fits.id);

    const refused = await failure(w.move({}));
    expect(refused.code).toBe('unmapped_fields');
    const fields = (refused.details?.fields ?? []) as {
      field: string;
      reason: string;
      events: number;
    }[];
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'stage',
          events: 1,
          reason: expect.stringContaining('late'),
        }),
        expect.objectContaining({
          field: 'score',
          events: 1,
          reason: expect.stringContaining('text field'),
        }),
      ]),
    );
    for (const event of [fits, late, scored]) expect(await w.typeOf(event.id)).toBe('meeting');
    expect(await readEvent(app, w.as(AGENT), fits.id)).toEqual(before);
  });

  it('checks the mapping it is given', async () => {
    const w = await workspace();
    await w.log();
    const cases: [Partial<MoveEventsInput>, string][] = [
      [{ fields: { nope: 'topic' } }, 'invalid_move'],
      [{ fields: { agenda: 'nope' } }, 'invalid_move'],
      [{ fields: { agenda: 'title' } }, 'invalid_move'],
      [{ fields: { title: 'topic' } }, 'invalid_move'],
      [{ drop: ['title'] }, 'invalid_move'],
      [{ fields: { agenda: 'topic' }, drop: ['agenda'] }, 'invalid_move'],
      [{ defaults: { medium: 'fax' } }, 'invalid_values'],
      [{ defaults: { medium: null } }, 'invalid_values'],
      [{ to: 'meeting' }, 'invalid_move'],
    ];
    for (const [input, code] of cases) {
      const error = await failure(w.move(input));
      expect(error.code, JSON.stringify(input)).toBe(code);
    }
  });

  it("requires the target's required fields, which defaults can fill", async () => {
    const w = await workspace();
    await w.change([
      {
        op: 'create_object',
        object: {
          class: 'event',
          nameSingular: 'visit',
          namePlural: 'visits',
          labelSingular: 'Visit',
          labelPlural: 'Visits',
          fields: [
            {
              name: 'outcome',
              label: 'Outcome',
              type: 'select',
              isNullable: false,
              settings: { options: [{ value: 'done', label: 'Done' }] },
            },
          ],
        },
      },
    ]);
    const meeting = await w.log();
    const missing = await failure(w.move({ to: 'visit' }));
    expect(missing).toMatchObject({
      code: 'invalid_values',
      details: { errors: [{ field: 'outcome' }] },
    });
    expect(await w.typeOf(meeting.id)).toBe('meeting');
    const moved = await w.move({ to: 'visit', defaults: { outcome: 'done' } });
    expect(moved.defaults).toEqual([{ field: 'outcome', events: 1 }]);
    expect((await readEvent(app, w.as(AGENT), meeting.id)).fields.outcome).toBe('done');
  });

  it('refuses while other records point at the events through a relation that cannot point at the target', async () => {
    const w = await workspace();
    await w.change([
      {
        op: 'create_field',
        object: 'task',
        field: {
          name: 'meeting',
          label: 'Meeting',
          type: 'relation',
          settings: { targetObject: 'meeting', inverseField: 'tasks' },
        },
      },
    ]);
    const meeting = await w.log();
    const task = await createRecord(app, w.as(AGENT), 'task', {
      title: 'Send the deck',
      meeting: meeting.id,
    });
    const refused = await failure(w.move({}));
    expect(refused).toMatchObject({
      status: 409,
      code: 'referenced_by_relations',
      details: { relations: [{ object: 'task', field: 'meeting', records: 1 }] },
    });
    await patchRecord(app, w.as(AGENT), task.id, { values: { meeting: null } });
    expect((await w.move({})).eventIds).toEqual([meeting.id]);
  });
});

describe('what can move', () => {
  it('never moves into or out of the hidden internal-note type, or between entities', async () => {
    const w = await workspace();
    const acme = await createRecord(app, w.as(AGENT), 'company', { name: 'Acme' });
    const fact = await remember(app, w.as(AGENT), acme.id, { text: 'Prefers email.' });
    const [note] = await db.owner<{ id: string; name: string }[]>`
      select s.source_record_id as id, o.name_singular as name from fact_sources s
      join records r on r.id = s.source_record_id join object_types o on o.id = r.object_type_id
      where s.fact_id = ${fact.fact.id} and o.universal_id = ${INTERNAL_NOTE_TYPE_ID}`;
    expect(note).toBeDefined();
    const meeting = await w.log();

    const cases: [Partial<MoveEventsInput>, string][] = [
      [{ from: note?.name as string }, 'not_found'],
      [{ to: note?.name as string }, 'not_found'],
      [{ from: 'note', events: [note?.id as string] }, 'not_found'],
      [{ from: 'person' }, 'not_an_event_type'],
      [{ to: 'company' }, 'not_an_event_type'],
      [{ from: 'note', events: [meeting.id] }, 'wrong_event_type'],
      [{ events: [acme.id] }, 'not_found'],
    ];
    for (const [input, code] of cases) {
      const error = await failure(w.move(input));
      expect(error.code, JSON.stringify(input)).toBe(code);
    }
    expect(await w.typeOf(note?.id as string)).toBe(note?.name);

    await deleteRecord(app, w.as(ADMIN), meeting.id);
    expect((await failure(w.move({ events: [meeting.id] }))).code).toBe('event_deleted');
  });

  it('needs a user with the admin scope to move, and schema:write for a dry run', async () => {
    const w = await workspace();
    const meeting = await w.log();
    const call = (actor: Actor, scopes: Caller['scopes'], dryRun: boolean) =>
      moveEventsFor(
        app,
        { workspaceId: w.id, actor, scopes },
        moveEventsInputSchema.parse({ from: 'meeting', to: 'conversation', dryRun }),
      );
    // An agent's key, even with admin, is not a person's approval.
    expect((await failure(call(AGENT, ALL_SCOPES, false))).status).toBe(403);
    expect((await failure(call(ADMIN, ['read', 'write', 'schema:write'], false))).status).toBe(403);
    expect((await call(AGENT, ['read', 'schema:write'], true)).eventIds).toEqual([meeting.id]);
    expect(await w.typeOf(meeting.id)).toBe('meeting');
    expect((await call(ADMIN, ['admin'], false)).eventIds).toEqual([meeting.id]);
  });
});

describe('concurrency', () => {
  it('is atomic against logs, edits and deletes running at the same time', async () => {
    const w = await workspace();
    const existing = await Promise.all(
      Array.from({ length: 12 }, (_, i) => w.log({ fields: { agenda: `Item ${i}` } })),
    );
    const results = await Promise.allSettled([
      w.move({ fields: { agenda: 'topic' }, defaults: { medium: 'meeting' } }),
      ...Array.from({ length: 6 }, () => w.log({ fields: { agenda: 'New' } })),
      ...existing
        .slice(0, 6)
        .map((e, i) => patchRecord(app, w.as(AGENT), e.id, { values: { title: `Edited ${i}` } })),
      ...existing.slice(6, 9).map((e) => deleteRecord(app, w.as(ADMIN), e.id)),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([]);
    const move = (results[0] as PromiseFulfilledResult<{ eventIds: string[] }>).value;

    // No event ends up half moved, and every value is what its assertions say.
    expect(await strayAssertions(w.id)).toBe(0);
    const rows = await db.owner<{ id: string; type: string; deleted: boolean }[]>`
      select r.id, o.name_singular as type, r.deleted_at is not null as deleted
      from records r join object_types o on o.id = r.object_type_id
      join event_records e on e.record_id = r.id
      where r.workspace_id = ${w.id} and o.class = 'event'`;
    for (const row of rows) await expectDataMatchesAssertions(app, w.id, row.id);
    // Every event the move reports is a conversation, and every live meeting
    // left was logged after it committed.
    const moved = new Set(move.eventIds);
    for (const row of rows) {
      if (moved.has(row.id)) expect(row.type).toBe('conversation');
      else if (row.type === 'meeting' && !row.deleted) {
        expect(existing.map((e) => e.id)).not.toContain(row.id);
      }
    }
    // Edits landed whichever way they were ordered against the move.
    for (const [i, event] of existing.slice(0, 6).entries()) {
      const read = await readEvent(app, w.as(AGENT), event.id);
      expect(read.fields.title).toBe(`Edited ${i}`);
      expect(read.object).toBe('conversation');
    }
  });

  it('moves each event once when two moves of a type run at the same time', async () => {
    const w = await workspace();
    const events = await Promise.all(Array.from({ length: 5 }, () => w.log()));
    const [a, b] = await Promise.all([
      w.move({ defaults: { medium: 'meeting' } }),
      w.move({ defaults: { medium: 'call' } }),
    ]);
    const all = [...(a?.eventIds ?? []), ...(b?.eventIds ?? [])].sort();
    expect(all).toEqual(events.map((e) => e.id).sort());
    expect([a?.eventIds.length, b?.eventIds.length].sort()).toEqual([0, 5]);
    // One default won, consistently: each event got exactly one medium claim.
    const [claims] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from field_assertions a join fields f on f.id = a.field_id
      where a.workspace_id = ${w.id} and f.name = 'medium'`;
    expect(claims?.count).toBe(5);
  });
});
