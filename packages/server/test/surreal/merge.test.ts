import { randomUUID } from 'node:crypto';
import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { RecordId } from '../../src/db/cbor.js';
import { publicId, relationTable } from '../../src/db/names.js';
import { factsOf, logEventFor, remember } from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  dismissSuggestion,
  mergeRecord,
  patchRecord,
  readRecord,
  withRead,
} from '../../src/records/service.js';
import { directoryEntries, rowsByIds } from '../../src/records/store.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import { reviewPage } from '../../src/web/review.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';
import { expectDataMatchesAssertions as expectDataCache } from '../helpers/records.js';

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
  workspaceId = (await createWorkspace(backend, { name: 'Merges', template: 'sales' })).id;
});

let n = 0;
const email = () => `merge${++n}@acme.test`;
const person = (values: Record<string, unknown> = {}, actor = AGENT, on: Backend = backend) =>
  createRecord(on, as(actor), 'person', { emails: email(), ...values });
const company = (name: string) => createRecord(backend, as(AGENT), 'company', { name });
const pair = (x: string, y: string) => [x, y].sort() as [string, string];

const expectDataMatchesAssertions = (id: string) => expectDataCache(backend, workspaceId, id);
const reviewQueue = (on: Backend, caller: Caller, limit: number) =>
  withRead(on, caller, (db, schema) => reviewPage(db, caller.workspaceId, schema, limit, {}));
const logCall = (title: string, participants: { recordId: string }[] = []) =>
  logEventFor(backend, as(AGENT), {
    type: 'call',
    channel: 'zoom',
    occurredAt: '2026-10-01T10:00:00Z',
    title,
    fields: {},
    participants,
    about: [],
  });

/** Runtime reads of this workspace's database, parameters only. */
const rows = async <T>(text: string, vars: Record<string, unknown> = {}) =>
  (await backend.workspace(workspaceId)).rows<T>(text, vars);
/** Setup that bypasses the API, through the administrative session. */
const admin = async () => backend.adminDb((await backend.route(workspaceId)).database);

/** A record's directory entry and object-table row, deleted or not. */
const stored = (id: string) =>
  withRead(backend, as(USER), async (db, schema) => ({
    entry: (await directoryEntries(db, [id])).get(id),
    row: (await rowsByIds(db, workspaceId, schema, [id])).get(id),
  }));

const fieldOf = (objectName: string, key: string) =>
  withRead(backend, as(USER), async (_db, schema) => {
    const field = schema.objectsByName.get(objectName)?.state.fields.find((f) => f.key === key);
    if (!field?.id) throw new Error(`no field ${objectName}.${key}`);
    return field;
  });

/** The native edges leaving a record, across every owning relation field of its object. */
const edgesFrom = (id: string, objectName: string) =>
  withRead(backend, as(USER), async (db, schema) => {
    const object = schema.objectsByName.get(objectName);
    if (!object) throw new Error(`no object ${objectName}`);
    const targets: string[] = [];
    for (const field of object.state.fields) {
      if (field.type !== 'relation' || field.settings.isInverse) continue;
      const out = await db.rows<RecordId>(
        'SELECT VALUE out FROM type::table($tb) WHERE in = $node;',
        {
          tb: relationTable(field.universalId),
          node: new RecordId(object.table, id),
        },
      );
      targets.push(...out.map(publicId));
    }
    return targets;
  });

async function identifiersOf(recordId: string) {
  const found = await rows<{ kind: string; value: string }>(
    'SELECT kind, value FROM record_identifiers WHERE record = $r;',
    { r: recordId },
  );
  return found.map((r) => `${r.kind}:${r.value}`).sort();
}

async function insertSuggestion(a: string, b: string, reason: string): Promise<string> {
  const id = randomUUID();
  await (await admin()).query("CREATE type::record('merge_suggestions', $id) CONTENT $content;", {
    id,
    content: { record_a: a, record_b: b, reason, status: 'pending', created_at: new Date() },
  });
  return id;
}

const suggestionOf = async ([a, b]: [string, string]) =>
  (
    await rows<{ status: string; decided_by?: Actor }>(
      'SELECT status, decided_by FROM merge_suggestions WHERE record_a = $a AND record_b = $b;',
      { a, b },
    )
  )[0];

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

describe('merging records (4.2)', () => {
  it('moves claims, facts and event links to the survivor and soft-deletes the other', async () => {
    const a = await person({ name: 'Dana Cohen', jobTitle: 'VP Sales' });
    const b = await person({ name: 'Dana Cohen', phones: '+972 54 123 4567' });
    const call = await logEventFor(backend, as(AGENT), {
      type: 'call',
      channel: 'zoom',
      occurredAt: '2026-10-01T10:00:00Z',
      fields: {},
      participants: [{ recordId: b.id }],
      about: [],
    });
    await remember(backend, as(AGENT), b.id, { text: 'Prefers email', source: call.id });

    const result = await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    expect(result).toMatchObject({ id: a.id, mergedId: b.id, merged: true });
    expect(result.record.fields).toMatchObject({
      jobTitle: 'VP Sales',
      phones: { primary: { number: '+972 54 123 4567' } },
    });

    // Reads of B return A; B is soft-deleted with merged_into, in the
    // directory and in its object-table row.
    expect((await readRecord(backend, as(USER), b.id)).id).toBe(a.id);
    const { entry, row } = await stored(b.id);
    expect(entry).toMatchObject({ merged_into: a.id });
    expect(entry?.deleted_at).not.toBeNull();
    expect(row).toMatchObject({ merged_into_id: a.id, data: {} });
    expect(row?.deleted_at).not.toBeNull();
    expect(
      await rows('SELECT id FROM field_assertions WHERE record = $r;', { r: b.id }),
    ).toHaveLength(0);

    expect((await factsOf(backend, as(USER), a.id, 10)).facts.map((f) => f.content)).toEqual([
      'Prefers email',
    ]);
    const participants = await rows<{ record: string }>(
      'SELECT record FROM event_links WHERE event = $e;',
      { e: call.id },
    );
    expect(participants).toEqual([{ record: a.id }]);
    await expectDataMatchesAssertions(a.id);
  });

  it('moves about links to the survivor, once per event', async () => {
    const a = await company('Umbrella');
    const b = await company('Umbrella Corp');
    const dana = await person();
    const meeting = await logEventFor(backend, as(AGENT), {
      type: 'meeting',
      channel: 'calendar',
      occurredAt: '2026-10-02T10:00:00Z',
      fields: {},
      participants: [{ recordId: dana.id }],
      about: [a.id, b.id],
    });
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    const links = await rows<{ record: string; link: string; position: number }>(
      'SELECT record, link, position FROM event_links WHERE event = $e ORDER BY position;',
      { e: meeting.id },
    );
    expect(links.map(({ record, link }) => ({ record, link }))).toEqual([
      { record: dana.id, link: 'participant' },
      { record: a.id, link: 'about' },
    ]);
  });

  it('refuses to merge events: each is something that happened (6.2)', async () => {
    const first = await logCall('Kickoff');
    const second = await logCall('Kickoff');
    await expect(
      mergeRecord(backend, as(USER), first.id, { recordId: second.id }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_merge' });
    const dana = await person();
    await expect(
      mergeRecord(backend, as(USER), dana.id, { recordId: first.id }),
    ).rejects.toMatchObject({ status: 422 });
    for (const id of [first.id, second.id]) {
      const { entry, row } = await stored(id);
      expect({ deleted_at: entry?.deleted_at, merged_into: entry?.merged_into }).toEqual({
        deleted_at: null,
        merged_into: null,
      });
      expect({ deleted_at: row?.deleted_at, merged_into_id: row?.merged_into_id }).toEqual({
        deleted_at: null,
        merged_into_id: null,
      });
    }
  });

  it('combines emails and phones, keeping the survivor primary, and rebuilds identifiers', async () => {
    const a = await person({ emails: { primary: 'dana@acme.test', additional: [] } });
    const b = await person({
      emails: { primary: 'Dana.Cohen@gmail.test', additional: [] },
      phones: '+1 415 555 0101',
    });
    const result = await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
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
    const emails = await fieldOf('person', 'emails');
    const [winner] = await rows<{ actor: Actor }>(
      "SELECT actor FROM field_assertions WHERE record = $r AND field_id = $f AND status = 'active';",
      { r: a.id, f: emails.id },
    );
    expect(winner?.actor).toEqual(USER);
    await expectDataMatchesAssertions(a.id);
  });

  it("takes B's primary when A has none, and lets the request override any field", async () => {
    const a = await person({ name: 'Ron P' });
    const b = await person({ name: 'Ron Peretz', jobTitle: 'CTO' });
    const result = await mergeRecord(backend, as(USER), a.id, {
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
    await runSchemaChange(backend, {
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
    });
    const a = await createRecord(backend, as(AGENT), 'vendor', {
      billing: { primary: 'x1@acme.test', additional: ['x2@acme.test'] },
    });
    const b = await createRecord(backend, as(AGENT), 'vendor', { billing: 'x3@acme.test' });
    await expect(mergeRecord(backend, as(USER), a.id, { recordId: b.id })).rejects.toMatchObject({
      code: 'too_many_values',
      details: { field: 'billing', maxValues: 2 },
    });
    // Explicit resolution goes through.
    const done = await mergeRecord(backend, as(USER), a.id, {
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
    const result = await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    expect(result.recomputedRecordIds).toEqual([dana.id]);
    const after = await readRecord(backend, as(USER), dana.id);
    expect(after.fields.company).toBe(a.id);
    const field = await fieldOf('person', 'company');
    const [claim] = await rows<{ actor: Actor; value: unknown }>(
      'SELECT actor, value FROM field_assertions WHERE record = $r AND field_id = $f;',
      { r: dana.id, f: field.id },
    );
    expect(claim).toEqual({ actor: AGENT, value: a.id });
    expect(await edgesFrom(dana.id, 'person')).toEqual([a.id]);
  });

  it('follows a merge when a later write links to the merged record', async () => {
    const a = await company('Globex');
    const b = await company('Globex Corp');
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    const sam = await person({ company: b.id });
    expect(sam.record.fields.company).toBe(a.id);
  });

  it('is a no-op when B is already merged into A, and refuses the reverse', async () => {
    const a = await person();
    const b = await person();
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    const again = await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    expect(again).toMatchObject({ id: a.id, mergedId: b.id, merged: false });
    await expect(mergeRecord(backend, as(USER), b.id, { recordId: a.id })).rejects.toMatchObject({
      code: 'record_merged',
    });
    await expect(mergeRecord(backend, as(USER), a.id, { recordId: a.id })).rejects.toMatchObject({
      code: 'invalid_merge',
    });
  });

  it('rejects agents, other objects and deleted records', async () => {
    const a = await person();
    const b = await person();
    await expect(mergeRecord(backend, as(AGENT), a.id, { recordId: b.id })).rejects.toMatchObject({
      status: 403,
    });
    const acme = await company('Initech');
    await expect(mergeRecord(backend, as(USER), a.id, { recordId: acme.id })).rejects.toMatchObject(
      { code: 'wrong_object' },
    );
    await deleteRecord(backend, as(USER), b.id);
    await expect(mergeRecord(backend, as(USER), a.id, { recordId: b.id })).rejects.toMatchObject({
      code: 'record_deleted',
    });
  });

  it('replays an idempotency key', async () => {
    const a = await person();
    const b = await person();
    const first = await mergeRecord(backend, as(USER), a.id, { recordId: b.id }, 'merge-key-1');
    const replay = await mergeRecord(backend, as(USER), a.id, { recordId: b.id }, 'merge-key-1');
    expect(replay).toEqual(first);
    expect(replay.merged).toBe(true);
  });

  it('accepts the pending suggestion for the pair and hides suggestions with a merged record', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    for (const [x, y] of [pair(a.id, b.id), pair(b.id, c.id)]) {
      await insertSuggestion(x, y, 'similar names');
    }
    const before = await reviewQueue(backend, as(USER), 100);
    expect(before.mergeSuggestions.map((s) => s.recordIds)).toEqual(
      expect.arrayContaining([pair(a.id, b.id), pair(b.id, c.id)]),
    );
    await mergeRecord(backend, as(USER), a.id, { recordId: b.id });
    const decided = await suggestionOf(pair(a.id, b.id));
    expect(decided).toEqual({ status: 'accepted', decided_by: USER });
    const after = await reviewQueue(backend, as(USER), 100);
    const ids = after.mergeSuggestions.flatMap((s) => s.recordIds);
    expect(ids).not.toContain(b.id);
    // B's other suggestion is closed when B goes, not filtered on read.
    const other = await suggestionOf(pair(b.id, c.id));
    expect(other?.status).toBe('dismissed');
  });

  it('closes pending suggestions of a deleted record', async () => {
    const a = await person();
    const b = await person();
    const [x, y] = pair(a.id, b.id);
    await insertSuggestion(x, y, 'similar names');
    await deleteRecord(backend, as(USER), b.id);
    const row = await suggestionOf([x, y]);
    expect(row?.status).toBe('dismissed');
  });

  it('keeps merge chains one hop long', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    await mergeRecord(backend, as(USER), b.id, { recordId: a.id });
    await mergeRecord(backend, as(USER), c.id, { recordId: b.id });
    const survivors: Record<string, unknown> = {};
    for (const id of [a.id, b.id]) {
      const { entry, row } = await stored(id);
      expect(row?.merged_into_id).toBe(entry?.merged_into);
      survivors[id] = entry?.merged_into;
    }
    expect(survivors).toEqual({ [a.id]: c.id, [b.id]: c.id });
    expect((await readRecord(backend, as(USER), a.id)).id).toBe(c.id);
  });

  it('dismisses a suggestion once, as a user only', async () => {
    const a = await person();
    const b = await person();
    const [x, y] = [a.id, b.id].sort() as [string, string];
    const id = await insertSuggestion(x, y, 'shared phone');
    await expect(dismissSuggestion(backend, as(AGENT), id)).rejects.toMatchObject({ status: 403 });
    expect(await dismissSuggestion(backend, as(USER), id)).toEqual({ id, status: 'dismissed' });
    await expect(dismissSuggestion(backend, as(USER), id)).rejects.toMatchObject({
      code: 'not_pending',
    });
  });
});

describe('merges under concurrency (rule 2.5)', () => {
  it('serializes two opposite merges of one pair: one merges, the other is refused', async () => {
    const a = await person();
    const b = await person();
    const results = await Promise.allSettled([
      mergeRecord(backend, as(USER), a.id, { recordId: b.id }),
      mergeRecord(backend.another(), as(USER), b.id, { recordId: a.id }),
    ]);
    const merged = results.filter((r) => r.status === 'fulfilled');
    expect(merged).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'record_merged' });
    const live = await withRead(backend, as(USER), async (db) =>
      [...(await directoryEntries(db, [a.id, b.id])).values()].filter((e) => !e.deleted_at),
    );
    expect(live).toHaveLength(1);
  });

  it('merges a chain of three concurrently into one survivor without a cycle', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    await Promise.allSettled([
      mergeRecord(backend, as(USER), a.id, { recordId: b.id }),
      mergeRecord(backend.another(), as(USER), b.id, { recordId: c.id }),
      mergeRecord(backend.another(), as(USER), c.id, { recordId: a.id }),
    ]);
    const entries = await withRead(backend, as(USER), (db) =>
      directoryEntries(db, [a.id, b.id, c.id]),
    );
    const survivors = [...entries.values()].filter((e) => e.merged_into === null);
    expect(survivors.length).toBeGreaterThanOrEqual(1);
    for (const id of [a.id, b.id, c.id]) {
      // Every ID still resolves, so there is no cycle.
      await expect(readRecord(backend, as(USER), id)).resolves.toBeDefined();
    }
  });

  it('keeps a relation written to B while B is being merged pointing at the survivor', async () => {
    const other = backend.another();
    for (let round = 0; round < 5; round++) {
      const a = await company(`Hooli ${round}`);
      const b = await company(`Hooli ${round} Ltd`);
      const [, linked] = await Promise.all([
        mergeRecord(backend, as(USER), a.id, { recordId: b.id }),
        person({ company: b.id }, AGENT, other),
      ]);
      const after = await readRecord(backend, as(USER), linked.id);
      expect(after.fields.company).toBe(a.id);
      expect(await edgesFrom(linked.id, 'person')).toEqual([a.id]);
    }
  });

  it('keeps a value written to B during the merge on the survivor', async () => {
    const other = backend.another();
    for (let round = 0; round < 5; round++) {
      const a = await person();
      const b = await person();
      await Promise.allSettled([
        mergeRecord(backend, as(USER), a.id, { recordId: b.id }),
        patchRecord(other, as(USER), b.id, { values: { jobTitle: `Title ${round}` } }),
      ]);
      const after = await readRecord(backend, as(USER), a.id);
      expect(after.fields.jobTitle).toBe(`Title ${round}`);
      await expectDataMatchesAssertions(a.id);
    }
  });

  it('replans a relation write to a record merged while it was planned, in either order', async () => {
    // Postgres could deadlock the merge (target, then source) against a
    // relation write (source, then target) and retried it. Here the
    // equivalent guarantee is the revision check: whichever commits second
    // replans against the first, deterministically interleaved below.
    const x = await company('Deadlock Co');
    const y = await company('Deadlock Co Ltd');
    const [merged, survivor] = [x.id, y.id].sort() as [string, string];
    const dana = await person({ company: merged });

    // The merge commits while the relation write is being planned.
    const patchSide = committingFirst(() =>
      mergeRecord(backend, as(USER), survivor, { recordId: merged }),
    );
    const patched = await patchRecord(patchSide.backend, as(USER), dana.id, {
      values: { company: merged },
    });
    expect(patchSide.commits()).toBe(2);
    expect(patched.fields).toBeDefined();
    expect((await readRecord(backend, as(USER), dana.id)).fields.company).toBe(survivor);
    expect(await edgesFrom(dana.id, 'person')).toEqual([survivor]);

    // The relation write commits while the merge is being planned.
    const p = await company('Deadlock Two');
    const q = await company('Deadlock Two Ltd');
    const ron = await person({ company: p.id });
    const mergeSide = committingFirst(() =>
      patchRecord(backend, as(USER), ron.id, { values: { company: q.id } }),
    );
    await expect(
      mergeRecord(mergeSide.backend, as(USER), p.id, { recordId: q.id }),
    ).resolves.toMatchObject({ merged: true });
    expect(mergeSide.commits()).toBe(2);
    expect((await readRecord(backend, as(USER), ron.id)).fields.company).toBe(p.id);
    expect(await edgesFrom(ron.id, 'person')).toEqual([p.id]);
  });
});
