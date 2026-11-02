import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import type { LogInteractionInput } from '../../src/memory/interactions.js';
import {
  factsOf,
  logInteractionFor,
  readInteraction,
  remember,
  retractFactFor,
  retractInteractionFor,
} from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  decideAssertion,
  deleteRecord,
  patchRecord,
  readRecord,
  reviewQueue,
  upsertRecord,
} from '../../src/records/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';
import { expectDataMatchesAssertions as expectDataCache } from '../helpers/records.js';

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;
let otherWorkspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox', name: 'Inbox agent' };
const AGENT2: Actor = { type: 'agent', id: 'calendar' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Acme Sales', template: 'sales' })).id;
  otherWorkspaceId = (await createWorkspace(db.owner, { name: 'Other', template: 'sales' })).id;
});

let n = 0;
const email = () => `memory${++n}@acme.test`;
let externalIds = 0;
const externalId = () => `ext-${++externalIds}`;

const person = (values: Record<string, unknown> = {}, actor = AGENT, source?: string) =>
  createRecord(app, as(actor), 'person', { emails: email(), ...values }, { source });

const log = (input: Partial<LogInteractionInput> = {}, actor = AGENT, ws = workspaceId) =>
  logInteractionFor(app, as(actor, ws), {
    kind: 'call',
    channel: 'zoom',
    occurredAt: '2026-10-29T14:00:00+02:00',
    participants: [],
    ...input,
  });

async function assertions(recordId: string) {
  return db.owner<
    {
      value: unknown;
      status: string;
      observed_at: Date;
      source_interaction_id: string | null;
    }[]
  >`select value, status, observed_at, source_interaction_id from field_assertions
    where record_id = ${recordId} order by created_at`;
}

const expectDataMatchesAssertions = (id: string) => expectDataCache(app, workspaceId, id);

describe('log_interaction: participant matching (4.1)', () => {
  it('matches a unique email whatever its case, and lists the rest with a reason', async () => {
    const dana = await person({ name: 'Dana Levi' });
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const result = await log({
      externalId: externalId(),
      participants: [
        { handle: danaEmail.toUpperCase(), role: 'customer' },
        { handle: 'ron.peretz@acme.test', role: 'customer' },
        { handle: '+972 54-123-4567' },
      ],
    });
    expect(result).toEqual({
      id: expect.any(String),
      created: true,
      participants: {
        matched: [{ handle: danaEmail, role: 'customer', recordId: dana.id }],
        unmatched: [
          { handle: 'ron.peretz@acme.test', role: 'customer', reason: 'no_match' },
          { handle: '+972541234567', role: null, reason: 'phone_only' },
        ],
      },
    });
  });

  it('never matches a phone on its own, even one held by exactly one record', async () => {
    const holder = await person({ phones: { primary: { number: '+14155550199' } } });
    const result = await log({ participants: [{ handle: '+1 415 555 0199' }] });
    expect(result.participants.unmatched).toEqual([
      { handle: '+14155550199', role: null, reason: 'phone_only' },
    ]);
    // The agent can link it by passing the record ID.
    const linked = await log({ participants: [{ handle: '+14155550199', recordId: holder.id }] });
    expect(linked.participants.matched).toEqual([
      { handle: '+14155550199', role: null, recordId: holder.id },
    ]);
  });

  it('leaves a handle of a deleted record unresolved and lists it for review (1.2)', async () => {
    const gone = await person();
    const goneEmail = (gone.record.fields.emails as { primary: string }).primary;
    await deleteRecord(app, as(AGENT), gone.id);
    const result = await log({
      title: 'Call with a deleted person',
      participants: [{ handle: goneEmail }],
    });
    expect(result.participants).toEqual({
      matched: [],
      unmatched: [{ handle: goneEmail, role: null, reason: 'deleted_record' }],
    });
    const review = await reviewQueue(app, as(USER), 100);
    expect(review.unresolvedParticipants).toContainEqual({
      interactionId: result.id,
      handle: goneEmail,
      role: null,
      occurredAt: '2026-10-29T12:00:00.000Z',
      title: 'Call with a deleted person',
      deletedRecordIds: [gone.id],
    });

    // A retracted interaction leaves the review queue.
    await retractInteractionFor(app, as(AGENT), result.id);
    const after = await reviewQueue(app, as(USER), 100);
    expect(after.unresolvedParticipants.map((p) => p.interactionId)).not.toContain(result.id);
  });

  it('follows a merge from a handle or a record ID to the surviving record', async () => {
    const survivor = await person();
    const merged = await person();
    const mergedEmail = (merged.record.fields.emails as { primary: string }).primary;
    // Merging is build step 5; set the outcome directly to test resolution.
    await db.owner`update records set merged_into_id = ${survivor.id}, deleted_at = now()
      where id = ${merged.id}`;
    const result = await log({
      participants: [{ handle: mergedEmail }, { recordId: merged.id, role: 'attendee' }],
    });
    expect(result.participants.matched).toEqual([
      { handle: mergedEmail, role: null, recordId: survivor.id },
      { handle: null, role: 'attendee', recordId: survivor.id },
    ]);
  });

  it('reports a handle claimed by several live records as ambiguous, with candidates', async () => {
    await inWorkspace(app, workspaceId, (tx) =>
      runSchemaChange(tx, {
        workspaceId,
        actor: USER,
        scopes: ['schema:write', 'admin'],
        operations: [
          {
            op: 'create_object',
            object: {
              nameSingular: 'vendor',
              namePlural: 'vendors',
              labelSingular: 'Vendor',
              labelPlural: 'Vendors',
              labelField: 'title',
              fields: [
                { name: 'title', label: 'Title', type: 'text' },
                { name: 'billingEmails', label: 'Billing emails', type: 'emails', isUnique: true },
              ],
            },
          },
        ],
      }),
    );
    const shared = email();
    const someone = await createRecord(app, as(AGENT), 'person', { emails: shared });
    const vendor = await createRecord(app, as(AGENT), 'vendor', {
      title: 'Acme billing',
      billingEmails: shared,
    });
    const result = await log({ externalId: externalId(), participants: [{ handle: shared }] });
    expect(result.participants.unmatched).toEqual([
      {
        handle: shared,
        role: null,
        reason: 'ambiguous',
        candidates: [someone.id, vendor.id].sort(),
      },
    ]);
  });

  it('rejects invalid handles and unusable record IDs, listing every one', async () => {
    const deleted = await person();
    await deleteRecord(app, as(AGENT), deleted.id);
    await expect(
      log({ participants: [{ handle: 'Dana Levi' }, { role: 'customer' }] }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'invalid_participants',
      details: {
        errors: [
          { index: 0, handle: 'Dana Levi', message: expect.any(String) },
          { index: 1, message: expect.any(String) },
        ],
      },
    });
    await expect(
      log({
        participants: [
          { recordId: '00000000-0000-4000-8000-000000000000' },
          { recordId: deleted.id },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_participants',
      details: {
        errors: [
          { index: 0, message: 'no record with this ID' },
          { index: 1, message: 'the record is deleted' },
        ],
      },
    });
  });

  it("does not match another workspace's records", async () => {
    const theirs = await createRecord(app, as(AGENT, otherWorkspaceId), 'person', {
      emails: email(),
    });
    const theirEmail = (theirs.record.fields.emails as { primary: string }).primary;
    const result = await log({ participants: [{ handle: theirEmail }] });
    expect(result.participants.unmatched).toEqual([
      { handle: theirEmail, role: null, reason: 'no_match' },
    ]);
    await expect(log({ participants: [{ recordId: theirs.id }] })).rejects.toMatchObject({
      code: 'invalid_participants',
    });
  });

  it('rejects an occurredAt in the future', async () => {
    await expect(log({ occurredAt: '2099-01-01T00:00:00Z' })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_occurred_at',
    });
  });
});

describe('log_interaction: external IDs (1.3)', () => {
  it('returns the existing interaction for the same input, however it is written', async () => {
    const dana = await person();
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const id = externalId();
    const first = await log({
      externalId: id,
      title: 'Renewal',
      participants: [{ handle: danaEmail, role: 'customer' }, { handle: 'x@nowhere.test' }],
    });
    const again = await log({
      externalId: id,
      title: 'Renewal',
      occurredAt: '2026-10-29T12:00:00Z',
      participants: [
        { handle: ` ${danaEmail.toUpperCase()}`, role: 'customer' },
        { handle: 'X@nowhere.test' },
      ],
    });
    expect(again).toEqual({ ...first, created: false });
    const [{ count }] = (await db.owner`
      select count(*)::int as count from interactions where external_id = ${id}`) as [
      { count: number },
    ];
    expect(count).toBe(1);
  });

  it('treats the same externalId on another channel as another interaction', async () => {
    const id = externalId();
    const zoom = await log({ externalId: id, channel: 'zoom' });
    const meet = await log({ externalId: id, channel: 'meet' });
    expect(meet.created).toBe(true);
    expect(meet.id).not.toBe(zoom.id);
  });

  it('reports a different payload for the same externalId as a conflict', async () => {
    const id = externalId();
    const first = await log({ externalId: id, summary: 'Agreed on pricing' });
    await expect(log({ externalId: id, summary: 'Agreed on a pilot' })).rejects.toMatchObject({
      status: 409,
      code: 'interaction_conflict',
      details: { id: first.id },
    });
  });

  it('reports a retracted externalId instead of logging it again', async () => {
    const id = externalId();
    const first = await log({ externalId: id });
    await retractInteractionFor(app, as(AGENT), first.id);
    await expect(log({ externalId: id })).rejects.toMatchObject({
      status: 409,
      code: 'interaction_retracted',
      details: { id: first.id },
    });
  });

  it('logs one interaction when the same externalId arrives concurrently', async () => {
    const dana = await person();
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const id = externalId();
    const input = {
      externalId: id,
      title: 'Concurrent',
      participants: [{ handle: danaEmail, role: 'customer' }],
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => log(input)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    for (const result of results) {
      expect(result.participants.matched).toEqual([
        { handle: danaEmail, role: 'customer', recordId: dana.id },
      ]);
    }
    const participants = await db.owner`
      select p.id from interaction_participants p join interactions i on i.id = p.interaction_id
      where i.external_id = ${id}`;
    expect(participants).toHaveLength(1);
  });

  it('logs interactions without an externalId every time', async () => {
    const a = await log({ title: 'No ID' });
    const b = await log({ title: 'No ID' });
    expect(a.id).not.toBe(b.id);
    expect(b.created).toBe(true);
  });
});

describe('reading and retracting interactions', () => {
  it('reads an interaction with its participants, and hides it once retracted', async () => {
    const dana = await person();
    const logged = await log({
      kind: 'meeting',
      channel: 'calendar',
      externalId: externalId(),
      title: 'Demo',
      summary: 'Showed the data platform',
      participants: [{ recordId: dana.id, role: 'attendee' }],
    });
    const read = await readInteraction(app, as(AGENT2), logged.id);
    expect(read).toEqual({
      id: logged.id,
      kind: 'meeting',
      channel: 'calendar',
      externalId: expect.any(String),
      occurredAt: '2026-10-29T12:00:00.000Z',
      title: 'Demo',
      summary: 'Showed the data platform',
      participants: {
        matched: [{ handle: null, role: 'attendee', recordId: dana.id }],
        unmatched: [],
      },
      createdBy: AGENT,
      createdAt: expect.any(String),
    });
    const [row] = await db.owner<{ search: string }[]>`
      select search::text from interactions where id = ${logged.id}`;
    expect(row?.search).toContain("'demo':1A");
    expect(row?.search).toContain("'platform'");

    const retracted = await retractInteractionFor(app, as(AGENT), logged.id);
    expect(retracted).toMatchObject({ id: logged.id, deleted: true });
    await expect(readInteraction(app, as(AGENT), logged.id)).rejects.toMatchObject({
      status: 404,
      code: 'interaction_deleted',
    });
    await expect(retractInteractionFor(app, as(AGENT), logged.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("cannot read or retract another workspace's interaction", async () => {
    const theirs = await log({}, AGENT, otherWorkspaceId);
    await expect(readInteraction(app, as(AGENT), theirs.id)).rejects.toMatchObject({ status: 404 });
    await expect(retractInteractionFor(app, as(AGENT), theirs.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('source on record writes (rules 2.1, 2.2)', () => {
  it("stores the source and takes observed_at from the interaction's occurred_at", async () => {
    const call = await log({ occurredAt: '2026-10-20T09:30:00+03:00' });
    const created = await createRecord(
      app,
      as(AGENT),
      'person',
      { emails: email(), jobTitle: 'CTO' },
      { source: call.id },
    );
    const rows = await assertions(created.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source_interaction_id).toBe(call.id);
      expect(row.observed_at.toISOString()).toBe('2026-10-20T06:30:00.000Z');
    }
  });

  it('supersedes an older cited email against a newer cited call (rule 2.2)', async () => {
    const dana = await person();
    // The call is newer but logged first; the email arrives later and is older.
    const call = await log({ kind: 'call', occurredAt: '2026-10-28T10:00:00Z' });
    const mail = await log({ kind: 'email', channel: 'gmail', occurredAt: '2026-09-01T10:00:00Z' });

    const fromCall = await upsertRecord(app, as(AGENT), 'person', {
      id: dana.id,
      values: { jobTitle: 'VP Sales' },
      ifMissing: 'fail',
      source: call.id,
    });
    expect(fromCall.fields).toEqual({ jobTitle: 'applied' });

    const fromMail = await upsertRecord(app, as(AGENT2), 'person', {
      id: dana.id,
      values: { jobTitle: 'Sales Director' },
      ifMissing: 'fail',
      source: mail.id,
    });
    expect(fromMail.fields).toEqual({ jobTitle: 'superseded' });
    expect(fromMail.record.fields.jobTitle).toBe('VP Sales');
    await expectDataMatchesAssertions(dana.id);
  });

  it('cites through PATCH and upsert by match too', async () => {
    const dana = await person();
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const call = await log({ occurredAt: '2026-10-01T08:00:00Z' });
    await patchRecord(app, as(AGENT), dana.id, { values: { jobTitle: 'A' }, source: call.id });
    await upsertRecord(app, as(AGENT), 'person', {
      match: { emails: danaEmail },
      values: { jobTitle: 'B' },
      ifMissing: 'fail',
      source: call.id,
    });
    const rows = (await assertions(dana.id)).filter((r) => r.value === 'A' || r.value === 'B');
    expect(rows.map((r) => r.source_interaction_id)).toEqual([call.id, call.id]);
  });

  it('rejects an unknown, foreign or retracted source and writes nothing', async () => {
    const dana = await person();
    const foreign = await log({}, AGENT, otherWorkspaceId);
    for (const source of ['00000000-0000-4000-8000-000000000000', foreign.id]) {
      await expect(
        patchRecord(app, as(AGENT), dana.id, { values: { jobTitle: 'X' }, source }),
      ).rejects.toMatchObject({ status: 422, code: 'invalid_source' });
    }
    const retracted = await log();
    await retractInteractionFor(app, as(AGENT), retracted.id);
    await expect(
      patchRecord(app, as(AGENT), dana.id, { values: { jobTitle: 'X' }, source: retracted.id }),
    ).rejects.toMatchObject({ status: 409, code: 'source_retracted' });
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBeUndefined();
  });
});

describe('retracting an interaction (2.1, rule 2.4)', () => {
  it('recomputes field winners so the next eligible claim takes over', async () => {
    const dana = await person({ name: 'Dana Levi' });
    const mail = await log({ kind: 'email', channel: 'gmail', occurredAt: '2026-09-01T10:00:00Z' });
    const call = await log({ kind: 'call', occurredAt: '2026-10-28T10:00:00Z' });
    await patchRecord(app, as(AGENT), dana.id, {
      values: { jobTitle: 'Sales Director' },
      source: mail.id,
    });
    await patchRecord(app, as(AGENT), dana.id, {
      values: { jobTitle: 'VP Sales' },
      source: call.id,
    });
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBe('VP Sales');

    const retracted = await retractInteractionFor(app, as(AGENT), call.id);
    expect(retracted).toEqual({
      id: call.id,
      deleted: true,
      retractedAssertions: 1,
      recomputedRecordIds: [dana.id],
      hiddenFactIds: [],
    });
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBe('Sales Director');
    await expectDataMatchesAssertions(dana.id);

    // Retracting the last source of a field removes the value.
    await retractInteractionFor(app, as(AGENT), mail.id);
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBeUndefined();
    await expectDataMatchesAssertions(dana.id);
    const statuses = (await assertions(dana.id))
      .filter((a) => a.source_interaction_id !== null)
      .map((a) => a.status);
    expect(new Set(statuses)).toEqual(new Set(['retracted']));
  });

  it('never lets an older superseded claim from the source win again', async () => {
    const dana = await person();
    const old = await log({ occurredAt: '2026-08-01T10:00:00Z' });
    const mid = await log({ occurredAt: '2026-09-01T10:00:00Z' });
    const recent = await log({ occurredAt: '2026-10-01T10:00:00Z' });
    await patchRecord(app, as(AGENT), dana.id, { values: { jobTitle: 'Old' }, source: old.id });
    await patchRecord(app, as(AGENT), dana.id, { values: { jobTitle: 'Mid' }, source: mid.id });
    await patchRecord(app, as(AGENT), dana.id, { values: { jobTitle: 'New' }, source: recent.id });
    // Mid is superseded; retracting it changes nothing visible.
    const midResult = await retractInteractionFor(app, as(AGENT), mid.id);
    expect(midResult.recomputedRecordIds).toEqual([]);
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBe('New');
    // Retracting the winner falls back past the retracted claim to the oldest.
    await retractInteractionFor(app, as(AGENT), recent.id);
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBe('Old');
    await expectDataMatchesAssertions(dana.id);
  });

  it('restores the previous identifiers, so matching follows the recomputed email', async () => {
    const oldEmail = email();
    const newEmail = email();
    const earlier = await log({ occurredAt: '2026-09-01T10:00:00Z' });
    const dana = await person({ emails: oldEmail }, AGENT, earlier.id);
    const call = await log();
    await patchRecord(app, as(AGENT), dana.id, { values: { emails: newEmail }, source: call.id });
    expect((await log({ participants: [{ handle: newEmail }] })).participants.matched).toHaveLength(
      1,
    );

    await retractInteractionFor(app, as(AGENT), call.id);
    expect((await log({ participants: [{ handle: newEmail }] })).participants.unmatched).toEqual([
      { handle: newEmail, role: null, reason: 'no_match' },
    ]);
    expect((await log({ participants: [{ handle: oldEmail }] })).participants.matched).toEqual([
      { handle: oldEmail, role: null, recordId: dana.id },
    ]);
  });

  it('restores a value another record took through the same interaction', async () => {
    const earlier = await log({ occurredAt: '2026-09-01T10:00:00Z' });
    const [first, second] = [
      await person({}, AGENT, earlier.id),
      await person({}, AGENT, earlier.id),
    ];
    // Alice sorts first: she is recomputed while Bob still holds her old address.
    const [alice, bob] = first.id < second.id ? [first, second] : [second, first];
    const aliceOld = (alice.record.fields.emails as { primary: string }).primary;
    const bobOld = (bob.record.fields.emails as { primary: string }).primary;
    const call = await log({ occurredAt: '2026-10-01T10:00:00Z' });
    await patchRecord(app, as(AGENT), alice.id, { values: { emails: email() }, source: call.id });
    await patchRecord(app, as(AGENT), bob.id, { values: { emails: aliceOld }, source: call.id });

    const result = await retractInteractionFor(app, as(AGENT), call.id);
    expect(result.recomputedRecordIds).toEqual([alice.id, bob.id]);
    expect((await readRecord(app, as(AGENT), alice.id)).fields.emails).toMatchObject({
      primary: aliceOld,
    });
    expect((await readRecord(app, as(AGENT), bob.id)).fields.emails).toMatchObject({
      primary: bobOld,
    });
    const review = await reviewQueue(app, as(USER), 500);
    expect(review.pendingAssertions.filter((a) => [alice.id, bob.id].includes(a.recordId))).toEqual(
      [],
    );
    expect((await log({ participants: [{ handle: aliceOld }] })).participants.matched).toEqual([
      { handle: aliceOld, role: null, recordId: alice.id },
    ]);
  });

  it('restores the previous relation link', async () => {
    const acme = await createRecord(app, as(AGENT), 'company', { name: 'Acme' });
    const globex = await createRecord(app, as(AGENT), 'company', { name: 'Globex' });
    const earlier = await log({ occurredAt: '2026-09-01T10:00:00Z' });
    const dana = await person({ company: acme.id }, AGENT, earlier.id);
    const call = await log();
    await patchRecord(app, as(AGENT), dana.id, { values: { company: globex.id }, source: call.id });
    expect((await readRecord(app, as(AGENT), dana.id)).fields.company).toBe(globex.id);
    await retractInteractionFor(app, as(AGENT), call.id);
    expect((await readRecord(app, as(AGENT), dana.id)).fields.company).toBe(acme.id);
    expect((await readRecord(app, as(AGENT), acme.id)).fields.people).toContain(dana.id);
  });

  it('removes pending assertions from the source from the review queue', async () => {
    // The person's value comes from an older meeting; the agent cites a newer call.
    const meeting = await log({ kind: 'meeting', occurredAt: '2026-09-01T10:00:00Z' }, USER);
    const dana = await person({ jobTitle: 'Set by a person' }, USER, meeting.id);
    const call = await log({ occurredAt: '2026-10-30T10:00:00Z' });
    const pending = await patchRecord(app, as(AGENT), dana.id, {
      values: { jobTitle: 'From the call' },
      source: call.id,
    });
    expect(pending.fields).toEqual({ jobTitle: 'pending_review' });
    const before = await reviewQueue(app, as(USER), 100);
    const item = before.pendingAssertions.find((a) => a.recordId === dana.id);
    expect(item?.sourceInteractionId).toBe(call.id);

    await retractInteractionFor(app, as(AGENT), call.id);
    const after = await reviewQueue(app, as(USER), 100);
    expect(after.pendingAssertions.find((a) => a.recordId === dana.id)).toBeUndefined();
    await expect(
      decideAssertion(app, as(USER), item?.id as string, 'accept'),
    ).rejects.toMatchObject({ code: 'not_pending' });
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBe('Set by a person');
  });

  it('still retracts when another record has since claimed the older value', async () => {
    const oldEmail = email();
    const earlier = await log({ occurredAt: '2026-09-01T10:00:00Z' });
    const dana = await person({ emails: oldEmail }, AGENT, earlier.id);
    const call = await log({ occurredAt: '2026-10-01T10:00:00Z' });
    await patchRecord(app, as(AGENT), dana.id, { values: { emails: email() }, source: call.id });
    // Dana's old address is free again, and another person takes it.
    const ron = await person({ emails: oldEmail });

    const result = await retractInteractionFor(app, as(AGENT), call.id);
    expect(result.recomputedRecordIds).toEqual([dana.id]);
    // The old value cannot come back while Ron holds it: it waits for review.
    expect((await readRecord(app, as(AGENT), dana.id)).fields.emails).toBeUndefined();
    await expectDataMatchesAssertions(dana.id);
    const review = await reviewQueue(app, as(USER), 100);
    const item = review.pendingAssertions.find((a) => a.recordId === dana.id);
    expect(item).toMatchObject({ field: 'emails', reason: 'unique_conflict' });
    await expect(
      decideAssertion(app, as(USER), item?.id as string, 'accept'),
    ).rejects.toMatchObject({ code: 'unique_conflict', details: { recordId: ron.id } });
  });

  it('still retracts when another record claims the older value at the same time', async () => {
    for (let round = 0; round < 8; round++) {
      const oldEmail = email();
      const earlier = await log({ occurredAt: '2026-09-01T10:00:00Z' });
      const dana = await person({ emails: oldEmail }, AGENT, earlier.id);
      const call = await log({ occurredAt: '2026-10-01T10:00:00Z' });
      await patchRecord(app, as(AGENT), dana.id, { values: { emails: email() }, source: call.id });

      const [retract, create] = await Promise.allSettled([
        retractInteractionFor(app, as(AGENT), call.id),
        createRecord(app, as(AGENT2), 'person', { emails: oldEmail }),
      ]);
      expect(retract.status).toBe('fulfilled');
      const danaEmails = (await readRecord(app, as(AGENT), dana.id)).fields.emails;
      if (create.status === 'fulfilled') {
        // The other record took the address: Dana's old value waits for review.
        expect(danaEmails).toBeUndefined();
      } else {
        // Dana got the address back first, so the create lost.
        expect(create.reason).toMatchObject({
          code: 'unique_conflict',
          details: { recordId: dana.id },
        });
        expect(danaEmails).toMatchObject({ primary: oldEmail });
      }
      await expectDataMatchesAssertions(dana.id);
      const holders = await db.owner`
        select record_id from record_identifiers where value = ${oldEmail} and is_claim`;
      expect(holders).toHaveLength(1);
    }
  });

  it('accepts a pending claim keeping its observed_at, so a later edit by a person stands', async () => {
    const meeting = await log({ kind: 'meeting', occurredAt: '2026-09-01T10:00:00Z' }, USER);
    const dana = await person({ jobTitle: 'From the meeting' }, USER, meeting.id);
    const call = await log({ occurredAt: '2026-10-30T10:00:00Z' });
    await patchRecord(app, as(AGENT), dana.id, {
      values: { jobTitle: 'From the call' },
      source: call.id,
    });
    // A person edits the field directly after the call.
    await patchRecord(app, as(USER), dana.id, { values: { jobTitle: 'Edited today' } });
    const review = await reviewQueue(app, as(USER), 100);
    const item = review.pendingAssertions.find((a) => a.recordId === dana.id);

    const accepted = await decideAssertion(app, as(USER), item?.id as string, 'accept');
    expect(accepted.fields).toEqual({ jobTitle: 'superseded' });
    expect(accepted.record.fields.jobTitle).toBe('Edited today');
    const [reasserted] = await db.owner<{ observed_at: Date; source_interaction_id: string }[]>`
      select observed_at, source_interaction_id from field_assertions
      where record_id = ${dana.id} and value = '"From the call"' and actor->>'type' = 'user'`;
    expect(reasserted?.observed_at.toISOString()).toBe('2026-10-30T10:00:00.000Z');
    expect(reasserted?.source_interaction_id).toBe(call.id);
  });

  it('does not deadlock when a pending claim is accepted while its source is retracted', async () => {
    for (let round = 0; round < 5; round++) {
      const meeting = await log({ kind: 'meeting', occurredAt: '2026-09-01T10:00:00Z' }, USER);
      const dana = await person({ jobTitle: 'Person value' }, USER, meeting.id);
      const call = await log({ occurredAt: '2026-10-30T10:00:00Z' });
      await patchRecord(app, as(AGENT), dana.id, {
        values: { jobTitle: 'Agent value' },
        source: call.id,
      });
      const review = await reviewQueue(app, as(USER), 500);
      const item = review.pendingAssertions.find((a) => a.recordId === dana.id);

      const [accept, retract] = await Promise.allSettled([
        decideAssertion(app, as(USER), item?.id as string, 'accept'),
        retractInteractionFor(app, as(AGENT), call.id),
      ]);
      expect(retract.status).toBe('fulfilled');
      if (accept.status === 'rejected') {
        expect(['not_pending', 'source_retracted']).toContain(accept.reason.code);
      }
      // Either way the call's claims no longer count.
      expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBe('Person value');
      await expectDataMatchesAssertions(dana.id);
    }
  });

  it('serializes with writes citing it: every claim from it ends up retracted', async () => {
    const dana = await person();
    const call = await log();
    const writes = Array.from({ length: 10 }, (_, i) =>
      patchRecord(app, as(AGENT), dana.id, { values: { jobTitle: `T${i}` }, source: call.id }),
    );
    const [, ...settled] = await Promise.allSettled([
      retractInteractionFor(app, as(AGENT), call.id),
      ...writes,
    ]);
    for (const result of settled) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'source_retracted' });
      }
    }
    const cited = (await assertions(dana.id)).filter((a) => a.source_interaction_id === call.id);
    expect(cited.every((a) => a.status === 'retracted')).toBe(true);
    expect((await readRecord(app, as(AGENT), dana.id)).fields.jobTitle).toBeUndefined();
    await expectDataMatchesAssertions(dana.id);
  });
});

describe('remember (6.2, rule 2.6)', () => {
  it('writes a stated fact citing the source, valid from its occurred_at', async () => {
    const dana = await person();
    const call = await log({ occurredAt: '2026-10-29T14:00:00+02:00' });
    const result = await remember(app, as(AGENT), dana.id, {
      text: 'Legal review at Acme usually takes two weeks.',
      source: call.id,
      quote: 'legal usually needs two weeks with these',
    });
    expect(result).toEqual({
      fact: {
        id: expect.any(String),
        record: dana.id,
        content: 'Legal review at Acme usually takes two weeks.',
        kind: 'stated',
        validFrom: '2026-10-29T12:00:00.000Z',
        validTo: null,
        writtenBy: AGENT,
        sources: [{ interaction: call.id, quote: 'legal usually needs two weeks with these' }],
      },
      noteInteraction: null,
    });
    const [row] = await db.owner<{ search: string }[]>`
      select search::text from facts where id = ${result.fact.id}`;
    expect(row?.search).toContain("'legal'");
  });

  it('creates a note interaction for a fact without a source, valid from the write time', async () => {
    const dana = await person();
    const before = Date.now();
    const result = await remember(app, as(AGENT), dana.id, { text: 'Prefers WhatsApp.' });
    expect(result.noteInteraction).toEqual(expect.any(String));
    expect(result.fact.sources).toEqual([{ interaction: result.noteInteraction, quote: null }]);
    expect(new Date(result.fact.validFrom).getTime()).toBeGreaterThanOrEqual(before - 5_000);
    const note = await readInteraction(app, as(AGENT), result.noteInteraction as string);
    expect(note).toMatchObject({
      kind: 'note',
      channel: 'retainer',
      summary: 'Prefers WhatsApp.',
      occurredAt: result.fact.validFrom,
      participants: { matched: [{ handle: null, role: 'subject', recordId: dana.id }] },
    });
  });

  it('rejects a quote without a source, a deleted record and a retracted source', async () => {
    const dana = await person();
    await expect(
      remember(app, as(AGENT), dana.id, { text: 'x', quote: 'y' }),
    ).rejects.toMatchObject({ status: 400 });

    const call = await log();
    await retractInteractionFor(app, as(AGENT), call.id);
    await expect(
      remember(app, as(AGENT), dana.id, { text: 'x', source: call.id }),
    ).rejects.toMatchObject({ code: 'source_retracted' });

    await deleteRecord(app, as(AGENT), dana.id);
    await expect(remember(app, as(AGENT), dana.id, { text: 'x' })).rejects.toMatchObject({
      code: 'record_deleted',
    });
  });

  it('writes to the surviving record when given a merged ID', async () => {
    const survivor = await person();
    const merged = await person();
    await db.owner`update records set merged_into_id = ${survivor.id}, deleted_at = now()
      where id = ${merged.id}`;
    const result = await remember(app, as(AGENT), merged.id, { text: 'Merged fact.' });
    expect(result.fact.record).toBe(survivor.id);
  });

  it('replays the same idempotency key, even concurrently, and rejects a reused one', async () => {
    const dana = await person();
    const call = await log();
    const input = { text: 'Budget is approved for Q1.', source: call.id };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => remember(app, as(AGENT), dana.id, input, 'fact-key-1')),
    );
    expect(new Set(results.map((r) => r.fact.id)).size).toBe(1);
    for (const result of results) expect(result).toEqual(results[0]);
    const facts = await db.owner`select id from facts where record_id = ${dana.id}`;
    expect(facts).toHaveLength(1);

    await expect(
      remember(app, as(AGENT), dana.id, { text: 'Something else.' }, 'fact-key-1'),
    ).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
  });

  it('replays a note fact without creating a second note', async () => {
    const dana = await person();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        remember(app, as(AGENT), dana.id, { text: 'Note once.' }, 'note-key-1'),
      ),
    );
    expect(new Set(results.map((r) => r.noteInteraction)).size).toBe(1);
    const notes = await db.owner`
      select i.id from interactions i join interaction_participants p on p.interaction_id = i.id
      where p.record_id = ${dana.id} and i.kind = 'note'`;
    expect(notes).toHaveLength(1);
  });
});

describe('listing and retracting facts', () => {
  it('lists current facts newest first, hiding retracted facts and facts without a live source', async () => {
    const dana = await person();
    const older = await log({ occurredAt: '2026-09-01T10:00:00Z' });
    const newer = await log({ occurredAt: '2026-10-01T10:00:00Z' });
    const a = await remember(app, as(AGENT), dana.id, { text: 'Older fact.', source: older.id });
    const b = await remember(app, as(AGENT), dana.id, { text: 'Newer fact.', source: newer.id });
    const c = await remember(app, as(AGENT), dana.id, {
      text: 'Retracted fact.',
      source: newer.id,
    });
    // A second live source keeps a fact visible after one source is retracted.
    await db.owner`insert into fact_sources (workspace_id, fact_id, interaction_id)
      values (${workspaceId}, ${b.fact.id}, ${older.id})`;

    const listed = await factsOf(app, as(AGENT2), dana.id, 100);
    // Same validFrom: the one recorded later comes first.
    expect(listed.facts.map((f) => f.content)).toEqual([
      'Retracted fact.',
      'Newer fact.',
      'Older fact.',
    ]);

    expect(await retractFactFor(app, as(USER), c.fact.id)).toEqual({
      id: c.fact.id,
      deleted: true,
    });
    await expect(retractFactFor(app, as(USER), c.fact.id)).rejects.toMatchObject({
      code: 'fact_deleted',
    });

    const retracted = await retractInteractionFor(app, as(AGENT), older.id);
    expect(retracted.hiddenFactIds).toEqual([a.fact.id]);
    const after = await factsOf(app, as(AGENT), dana.id, 100);
    expect(after.facts).toEqual([{ ...b.fact, sources: [{ interaction: newer.id, quote: null }] }]);
  });

  it("hides a deleted record's facts and cannot read another workspace's", async () => {
    const dana = await person();
    await remember(app, as(AGENT), dana.id, { text: 'Visible until deleted.' });
    await deleteRecord(app, as(AGENT), dana.id);
    await expect(factsOf(app, as(AGENT), dana.id, 100)).rejects.toMatchObject({ status: 404 });

    const theirs = await createRecord(app, as(AGENT, otherWorkspaceId), 'person', {
      emails: email(),
    });
    await expect(factsOf(app, as(AGENT), theirs.id, 100)).rejects.toMatchObject({ status: 404 });
    await expect(
      remember(app, as(AGENT), theirs.id, { text: 'Cross-workspace' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
