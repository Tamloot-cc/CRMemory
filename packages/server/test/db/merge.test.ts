import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { factsOf, logInteractionFor, remember } from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  dismissSuggestion,
  mergeRecord,
  patchRecord,
  readRecord,
  reviewQueue,
} from '../../src/records/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';
import { expectDataMatchesAssertions as expectDataCache } from '../helpers/records.js';

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
  workspaceId = (await createWorkspace(db.owner, { name: 'Merges', template: 'sales' })).id;
});

let n = 0;
const email = () => `merge${++n}@acme.test`;
const person = (values: Record<string, unknown> = {}, actor = AGENT) =>
  createRecord(app, as(actor), 'person', { emails: email(), ...values });
const company = (name: string) => createRecord(app, as(AGENT), 'company', { name });
const pair = (x: string, y: string) => [x, y].sort() as [string, string];

const expectDataMatchesAssertions = (id: string) => expectDataCache(app, workspaceId, id);

async function identifiersOf(recordId: string) {
  const rows = await db.owner<{ kind: string; value: string }[]>`
    select kind, value from record_identifiers where record_id = ${recordId} order by kind, value`;
  return rows.map((r) => `${r.kind}:${r.value}`).sort();
}

describe('merging records (4.2)', () => {
  it('moves claims, facts and participants to the survivor and soft-deletes the other', async () => {
    const a = await person({ name: 'Dana Cohen', jobTitle: 'VP Sales' });
    const b = await person({ name: 'Dana Cohen', phones: '+972 54 123 4567' });
    const call = await logInteractionFor(app, as(AGENT), {
      kind: 'call',
      channel: 'zoom',
      occurredAt: '2026-10-01T10:00:00Z',
      participants: [{ recordId: b.id }],
      about: [],
    });
    await remember(app, as(AGENT), b.id, { text: 'Prefers email', source: call.id });

    const result = await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect(result).toMatchObject({ id: a.id, mergedId: b.id, merged: true });
    expect(result.record.fields).toMatchObject({
      jobTitle: 'VP Sales',
      phones: { primary: { number: '+972 54 123 4567' } },
    });

    // Reads of B return A; B is soft-deleted with merged_into_id.
    expect((await readRecord(app, as(USER), b.id)).id).toBe(a.id);
    const [row] = await db.owner<
      { merged_into_id: string; deleted_at: Date | null; data: object }[]
    >`
      select merged_into_id, deleted_at, data from records where id = ${b.id}`;
    expect(row).toMatchObject({ merged_into_id: a.id, data: {} });
    expect(row?.deleted_at).not.toBeNull();
    const [{ count }] = (await db.owner`
      select count(*)::int as count from field_assertions where record_id = ${b.id}`) as [
      { count: number },
    ];
    expect(count).toBe(0);

    expect((await factsOf(app, as(USER), a.id, 10)).facts.map((f) => f.content)).toEqual([
      'Prefers email',
    ]);
    const participants = await db.owner<{ record_id: string }[]>`
      select record_id from interaction_participants where interaction_id = ${call.id}`;
    expect(participants).toEqual([{ record_id: a.id }]);
    await expectDataMatchesAssertions(a.id);
  });

  it('combines emails and phones, keeping the survivor primary, and rebuilds identifiers', async () => {
    const a = await person({ emails: { primary: 'dana@acme.test', additional: [] } });
    const b = await person({
      emails: { primary: 'Dana.Cohen@gmail.test', additional: [] },
      phones: '+1 415 555 0101',
    });
    const result = await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect(result.record.fields.emails).toEqual({
      primary: 'dana@acme.test',
      additional: ['dana.cohen@gmail.test'],
    });
    expect(await identifiersOf(a.id)).toEqual([
      'email:dana.cohen@gmail.test',
      'email:dana@acme.test',
      'phone:+14155550101',
    ]);
    expect(await identifiersOf(b.id)).toEqual([]);
    // The merging user wrote the combined value; the history keeps both.
    const [winner] = await db.owner<{ actor: Actor }[]>`
      select a.actor from field_assertions a join fields f on f.id = a.field_id
      where a.record_id = ${a.id} and f.key = 'emails' and a.status = 'active'`;
    expect(winner?.actor).toEqual(USER);
    await expectDataMatchesAssertions(a.id);
  });

  it("takes B's primary when A has none, and lets the request override any field", async () => {
    const a = await person({ name: 'Ron P' });
    const b = await person({ name: 'Ron Peretz', jobTitle: 'CTO' });
    const result = await mergeRecord(app, as(USER), a.id, {
      recordId: b.id,
      values: { name: 'Ron Peretz', jobTitle: 'Founder' },
    });
    expect(result.record.fields).toMatchObject({
      name: { first: 'Ron', last: 'Peretz' },
      jobTitle: 'Founder',
    });
    await expectDataMatchesAssertions(a.id);
  });

  it('fails instead of truncating when the combined values exceed maxValues', async () => {
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
                { name: 'billing', label: 'Billing', type: 'emails', settings: { maxValues: 2 } },
              ],
            },
          },
        ],
      }),
    );
    const a = await createRecord(app, as(AGENT), 'vendor', {
      billing: { primary: 'x1@acme.test', additional: ['x2@acme.test'] },
    });
    const b = await createRecord(app, as(AGENT), 'vendor', { billing: 'x3@acme.test' });
    await expect(mergeRecord(app, as(USER), a.id, { recordId: b.id })).rejects.toMatchObject({
      code: 'too_many_values',
      details: { field: 'billing', maxValues: 2 },
    });
    // Explicit resolution goes through.
    const done = await mergeRecord(app, as(USER), a.id, {
      recordId: b.id,
      values: { billing: { primary: 'x1@acme.test', additional: ['x3@acme.test'] } },
    });
    expect(done.record.fields.billing).toEqual({
      primary: 'x1@acme.test',
      additional: ['x3@acme.test'],
    });
  });

  it('points inbound relations at the survivor, keeping their provenance', async () => {
    const a = await company('Acme');
    const b = await company('Acme Inc');
    const dana = await person({ company: b.id });
    const result = await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect(result.recomputedRecordIds).toEqual([dana.id]);
    const after = await readRecord(app, as(USER), dana.id);
    expect(after.fields.company).toBe(a.id);
    const [claim] = await db.owner<{ actor: Actor; value: unknown }[]>`
      select a.actor, a.value from field_assertions a join fields f on f.id = a.field_id
      where a.record_id = ${dana.id} and f.key = 'company'`;
    expect(claim).toEqual({ actor: AGENT, value: a.id });
    const links = await db.owner<{ target_record_id: string }[]>`
      select target_record_id from record_links where source_record_id = ${dana.id}`;
    expect(links).toEqual([{ target_record_id: a.id }]);
  });

  it('follows a merge when a later write links to the merged record', async () => {
    const a = await company('Globex');
    const b = await company('Globex Corp');
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    const sam = await person({ company: b.id });
    expect(sam.record.fields.company).toBe(a.id);
  });

  it('is a no-op when B is already merged into A, and refuses the reverse', async () => {
    const a = await person();
    const b = await person();
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    const again = await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect(again).toMatchObject({ id: a.id, mergedId: b.id, merged: false });
    await expect(mergeRecord(app, as(USER), b.id, { recordId: a.id })).rejects.toMatchObject({
      code: 'record_merged',
    });
    await expect(mergeRecord(app, as(USER), a.id, { recordId: a.id })).rejects.toMatchObject({
      code: 'invalid_merge',
    });
  });

  it('rejects agents, other objects and deleted records', async () => {
    const a = await person();
    const b = await person();
    await expect(mergeRecord(app, as(AGENT), a.id, { recordId: b.id })).rejects.toMatchObject({
      status: 403,
    });
    const acme = await company('Initech');
    await expect(mergeRecord(app, as(USER), a.id, { recordId: acme.id })).rejects.toMatchObject({
      code: 'wrong_object',
    });
    await deleteRecord(app, as(USER), b.id);
    await expect(mergeRecord(app, as(USER), a.id, { recordId: b.id })).rejects.toMatchObject({
      code: 'record_deleted',
    });
  });

  it('replays an idempotency key', async () => {
    const a = await person();
    const b = await person();
    const first = await mergeRecord(app, as(USER), a.id, { recordId: b.id }, 'merge-key-1');
    const replay = await mergeRecord(app, as(USER), a.id, { recordId: b.id }, 'merge-key-1');
    expect(replay).toEqual(first);
    expect(replay.merged).toBe(true);
  });

  it('accepts the pending suggestion for the pair and hides suggestions with a merged record', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    for (const [x, y] of [pair(a.id, b.id), pair(b.id, c.id)]) {
      await db.owner`
        insert into merge_suggestions (workspace_id, record_a_id, record_b_id, reason, status)
        values (${workspaceId}, ${x}, ${y}, 'similar names', 'pending')`;
    }
    const before = await reviewQueue(app, as(USER), 100);
    expect(before.mergeSuggestions.map((s) => s.recordIds)).toEqual(
      expect.arrayContaining([pair(a.id, b.id), pair(b.id, c.id)]),
    );
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    const [decided] = await db.owner<{ status: string; decided_by: Actor }[]>`
      select status, decided_by from merge_suggestions
      where record_a_id = ${pair(a.id, b.id)[0]} and record_b_id = ${pair(a.id, b.id)[1]}`;
    expect(decided).toEqual({ status: 'accepted', decided_by: USER });
    const after = await reviewQueue(app, as(USER), 100);
    const ids = after.mergeSuggestions.flatMap((s) => s.recordIds);
    expect(ids).not.toContain(b.id);
    // B's other suggestion is closed when B goes, not filtered on read.
    const [other] = await db.owner<{ status: string }[]>`
      select status from merge_suggestions
      where record_a_id = ${pair(b.id, c.id)[0]} and record_b_id = ${pair(b.id, c.id)[1]}`;
    expect(other?.status).toBe('dismissed');
  });

  it('closes pending suggestions of a deleted record', async () => {
    const a = await person();
    const b = await person();
    const [x, y] = pair(a.id, b.id);
    await db.owner`
      insert into merge_suggestions (workspace_id, record_a_id, record_b_id, reason, status)
      values (${workspaceId}, ${x}, ${y}, 'similar names', 'pending')`;
    await deleteRecord(app, as(USER), b.id);
    const [row] = await db.owner<{ status: string }[]>`
      select status from merge_suggestions where record_a_id = ${x} and record_b_id = ${y}`;
    expect(row?.status).toBe('dismissed');
  });

  it('keeps merge chains one hop long', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    await mergeRecord(app, as(USER), b.id, { recordId: a.id });
    await mergeRecord(app, as(USER), c.id, { recordId: b.id });
    const rows = await db.owner<{ id: string; merged_into_id: string | null }[]>`
      select id, merged_into_id from records where id in (${a.id}, ${b.id})`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.merged_into_id]))).toEqual({
      [a.id]: c.id,
      [b.id]: c.id,
    });
    expect((await readRecord(app, as(USER), a.id)).id).toBe(c.id);
  });

  it('dismisses a suggestion once, as a user only', async () => {
    const a = await person();
    const b = await person();
    const [x, y] = [a.id, b.id].sort();
    const [row] = await db.owner<{ id: string }[]>`
      insert into merge_suggestions (workspace_id, record_a_id, record_b_id, reason, status)
      values (${workspaceId}, ${x as string}, ${y as string}, 'shared phone', 'pending')
      returning id`;
    const id = row?.id as string;
    await expect(dismissSuggestion(app, as(AGENT), id)).rejects.toMatchObject({ status: 403 });
    expect(await dismissSuggestion(app, as(USER), id)).toEqual({ id, status: 'dismissed' });
    await expect(dismissSuggestion(app, as(USER), id)).rejects.toMatchObject({
      code: 'not_pending',
    });
  });
});

describe('merges under concurrency (rule 2.5)', () => {
  it('serializes two opposite merges of one pair: one merges, the other is refused', async () => {
    const a = await person();
    const b = await person();
    const results = await Promise.allSettled([
      mergeRecord(app, as(USER), a.id, { recordId: b.id }),
      mergeRecord(app, as(USER), b.id, { recordId: a.id }),
    ]);
    const merged = results.filter((r) => r.status === 'fulfilled');
    expect(merged).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'record_merged' });
    const live = await db.owner<{ id: string }[]>`
      select id from records where id in (${a.id}, ${b.id}) and deleted_at is null`;
    expect(live).toHaveLength(1);
  });

  it('merges a chain of three concurrently into one survivor without a cycle', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    await Promise.allSettled([
      mergeRecord(app, as(USER), a.id, { recordId: b.id }),
      mergeRecord(app, as(USER), b.id, { recordId: c.id }),
      mergeRecord(app, as(USER), c.id, { recordId: a.id }),
    ]);
    const rows = await db.owner<{ id: string; merged_into_id: string | null }[]>`
      select id, merged_into_id from records where id in (${a.id}, ${b.id}, ${c.id})`;
    const survivors = rows.filter((r) => r.merged_into_id === null);
    expect(survivors.length).toBeGreaterThanOrEqual(1);
    for (const id of [a.id, b.id, c.id]) {
      // Every ID still resolves, so there is no cycle.
      await expect(readRecord(app, as(USER), id)).resolves.toBeDefined();
    }
  });

  it('keeps a relation written to B while B is being merged pointing at the survivor', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await company(`Hooli ${round}`);
      const b = await company(`Hooli ${round} Ltd`);
      const [, linked] = await Promise.all([
        mergeRecord(app, as(USER), a.id, { recordId: b.id }),
        person({ company: b.id }),
      ]);
      const after = await readRecord(app, as(USER), linked.id);
      expect(after.fields.company).toBe(a.id);
      const links = await db.owner<{ target_record_id: string }[]>`
        select target_record_id from record_links where source_record_id = ${linked.id}`;
      expect(links).toEqual([{ target_record_id: a.id }]);
    }
  });

  it('keeps a value written to B during the merge on the survivor', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await person();
      const b = await person();
      await Promise.allSettled([
        mergeRecord(app, as(USER), a.id, { recordId: b.id }),
        patchRecord(app, as(USER), b.id, { values: { jobTitle: `Title ${round}` } }),
      ]);
      const after = await readRecord(app, as(USER), a.id);
      expect(after.fields.jobTitle).toBe(`Title ${round}`);
      await expectDataMatchesAssertions(a.id);
    }
  });

  it('retries a relation write that deadlocks with a merge of its target', async () => {
    // The merge locks the target before the source; a relation write locks
    // the source, then the target. Force that interleaving deterministically.
    const x = await company('Deadlock Co');
    const y = await company('Deadlock Co Ltd');
    // The merged record must sort first, so the merge holds it while it
    // waits for the survivor.
    const [merged, survivor] = [x.id, y.id].sort() as [string, string];
    const dana = await person({ company: merged });

    const waiters = async (count: number) => {
      for (let i = 0; i < 200; i++) {
        const [row] = await db.owner<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where datname = ${db.name} and wait_event_type = 'Lock'`;
        if ((row?.count ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`fewer than ${count} transactions are waiting on a lock`);
    };

    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.owner.begin(async (tx) => {
      await tx`select id from records where id = ${survivor} for update`;
      locked();
      await released;
    });
    await isLocked;
    const merging = mergeRecord(app, as(USER), survivor, { recordId: merged });
    await waiters(1); // the merge holds the merged record, waiting for the survivor
    const patching = patchRecord(app, as(USER), dana.id, { values: { company: merged } });
    await waiters(2); // the patch holds Dana, waiting for the merged record
    release();
    await holder;

    const [mergeResult, patchResult] = await Promise.allSettled([merging, patching]);
    expect(mergeResult.status).toBe('fulfilled');
    expect(patchResult.status).toBe('fulfilled');
    expect((await readRecord(app, as(USER), dana.id)).fields.company).toBe(survivor);
  });
});
