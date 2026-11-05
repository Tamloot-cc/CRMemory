import type { Actor } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { publicId } from '../../src/db/names.js';
import { factsOf, logEventFor, remember, retractFactFor } from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  dismissSuggestion,
  mergeRecord,
  withRead,
} from '../../src/records/service.js';
import { reviewPage } from '../../src/web/review.js';
import { consolidateWorkspace } from '../../src/worker/consolidate.js';
import { startWorker } from '../../src/worker/index.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const caller = (workspaceId: string, actor: Actor = AGENT): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

const reviewQueue = (on: Backend, caller: Caller, limit: number) =>
  withRead(on, caller, (db, schema) => reviewPage(db, caller.workspaceId, schema, limit, {}));

let n = 0;
const newWorkspace = async () =>
  (await createWorkspace(backend, { name: `Consolidate ${++n}`, template: 'sales' })).id;
const email = () => `consolidate${++n}@acme.test`;

/** Runtime reads of a workspace's database, parameters only. */
const rows = async <T>(ws: string, text: string, vars: Record<string, unknown> = {}) =>
  (await backend.workspace(ws)).rows<T>(text, vars);
/** Setup that bypasses the API, through the administrative session. */
const adminQuery = async (ws: string, text: string, vars: Record<string, unknown> = {}) =>
  backend.adminDb((await backend.route(ws)).database).query(text, vars);

async function call(ws: string, occurredAt = '2026-10-01T10:00:00Z', title?: string) {
  return logEventFor(backend, caller(ws), {
    type: 'call',
    channel: 'zoom',
    occurredAt,
    ...(title !== undefined ? { title } : {}),
    fields: {},
    participants: [],
    about: [],
  });
}

async function suggestions(ws: string) {
  const found = await rows<{ a: string; b: string; reason: string; status: string }>(
    ws,
    'SELECT record_a AS a, record_b AS b, reason, status FROM merge_suggestions ORDER BY reason, a;',
  );
  return found.map(({ a, b, reason, status }) => ({ a, b, reason, status }));
}

const pair = (x: string, y: string) => [x, y].sort() as [string, string];

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

describe('fact dedupe (4.2)', () => {
  it('supersedes exact duplicates with the oldest, which gains every source', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(backend, caller(ws), 'person', { emails: email() });
    const first = await call(ws);
    const second = await call(ws);
    const original = await remember(backend, caller(ws), dana.id, {
      text: 'Renewal is due in March',
      source: first.id,
    });
    const duplicate = await remember(backend, caller(ws), dana.id, {
      text: '  renewal is  due in March ',
      source: second.id,
      quote: 'March renewal',
    });

    const stats = await consolidateWorkspace(backend, ws);
    expect(stats).toEqual({ supersededFacts: 1, mergeSuggestions: 0 });

    const facts = (await factsOf(backend, caller(ws), dana.id, 10)).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.id).toBe(original.fact.id);
    expect(facts[0]?.sources).toEqual(
      expect.arrayContaining([
        { event: first.id, quote: null },
        { event: second.id, quote: 'March renewal' },
      ]),
    );
    const [kept] = await rows<{ superseded_by?: string; deleted_at?: Date | null }>(
      ws,
      'SELECT superseded_by, deleted_at FROM type::record("facts", $id);',
      { id: duplicate.fact.id },
    );
    expect({ superseded_by: kept?.superseded_by, deleted_at: kept?.deleted_at ?? null }).toEqual({
      superseded_by: original.fact.id,
      deleted_at: null,
    });

    // Running again changes nothing.
    expect(await consolidateWorkspace(backend, ws)).toEqual({
      supersededFacts: 0,
      mergeSuggestions: 0,
    });
  });

  it('finds duplicates a later merge brings together, comparing only changed records', async () => {
    const ws = await newWorkspace();
    // Records with facts but no field values: a merge moves facts only.
    const a = await createRecord(backend, caller(ws), 'person', {});
    const b = await createRecord(backend, caller(ws), 'person', {});
    const source = await call(ws);
    await remember(backend, caller(ws), a.id, { text: 'Owns the budget', source: source.id });
    await remember(backend, caller(ws), b.id, { text: 'Owns the budget', source: source.id });
    expect(await consolidateWorkspace(backend, ws)).toMatchObject({ supersededFacts: 0 });

    // Old facts, new neighbours: the merge touched A, so the next run looks at it.
    await adminQuery(ws, 'UPDATE consolidator_runs:current SET compared_until = time::now();');
    await mergeRecord(backend, caller(ws, USER), a.id, { recordId: b.id });
    expect(await consolidateWorkspace(backend, ws)).toMatchObject({ supersededFacts: 1 });
    expect((await factsOf(backend, caller(ws), a.id, 10)).facts).toHaveLength(1);
  });

  it('keeps the same text at different times, near-duplicates and other records apart', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(backend, caller(ws), 'person', { emails: email() });
    const ron = await createRecord(backend, caller(ws), 'person', { emails: email() });
    const october = await call(ws, '2026-10-01T10:00:00Z');
    const september = await call(ws, '2026-09-01T10:00:00Z');
    await remember(backend, caller(ws), dana.id, {
      text: 'Asked for a discount',
      source: october.id,
    });
    await remember(backend, caller(ws), dana.id, {
      text: 'Asked for a discount',
      source: september.id,
    });
    await remember(backend, caller(ws), dana.id, {
      text: 'Asked for a discount.',
      source: october.id,
    });
    await remember(backend, caller(ws), ron.id, {
      text: 'Asked for a discount',
      source: october.id,
    });

    expect(await consolidateWorkspace(backend, ws)).toMatchObject({ supersededFacts: 0 });
    expect((await factsOf(backend, caller(ws), dana.id, 10)).facts).toHaveLength(3);
  });

  it('never supersedes a duplicate with a fact retracted while it ran', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(backend, caller(ws), 'person', { emails: email() });
    const source = await call(ws);
    const original = await remember(backend, caller(ws), dana.id, {
      text: 'Likes golf',
      source: source.id,
    });
    const duplicate = await remember(backend, caller(ws), dana.id, {
      text: 'Likes golf',
      source: source.id,
    });

    // Postgres held the canonical fact's row lock while the consolidator
    // waited. Here the retraction commits after the consolidator planned
    // the pair and before it commits; its revision check makes it replan.
    const run = committingFirst(() => retractFactFor(backend, caller(ws, USER), original.fact.id));
    expect(await consolidateWorkspace(run.backend, ws)).toMatchObject({ supersededFacts: 0 });
    expect(run.commits()).toBe(2);

    const live = (await factsOf(backend, caller(ws), dana.id, 10)).facts;
    expect(live.map((f) => f.id)).toEqual([duplicate.fact.id]);
  });

  it('runs alongside a fact retraction without failing', async () => {
    const other = backend.another();
    for (let round = 0; round < 5; round++) {
      const ws = await newWorkspace();
      const dana = await createRecord(backend, caller(ws), 'person', { emails: email() });
      const source = await call(ws);
      const original = await remember(backend, caller(ws), dana.id, {
        text: 'Plays tennis',
        source: source.id,
      });
      await remember(backend, caller(ws), dana.id, { text: 'Plays tennis', source: source.id });
      const results = await Promise.allSettled([
        consolidateWorkspace(backend, ws),
        retractFactFor(other, caller(ws, USER), original.fact.id),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await factsOf(backend, caller(ws), dana.id, 10)).facts.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('merge suggestions (4.2)', () => {
  it('suggests records sharing a phone or a domain, and similar names, once per pair', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(backend, caller(ws), 'person', {
      name: 'Dana Cohen',
      emails: email(),
      phones: '+972 54 111 2233',
    });
    const danaHome = await createRecord(backend, caller(ws), 'person', {
      name: 'D. C.',
      emails: email(),
      phones: '+972-54-111-2233',
    });
    const danaTypo = await createRecord(backend, caller(ws), 'person', {
      name: 'Dana Coheen',
      emails: email(),
    });
    await createRecord(backend, caller(ws), 'person', { name: 'Ron Peretz', emails: email() });
    const acme = await createRecord(backend, caller(ws), 'company', {
      name: 'Acme',
      domain: 'https://acme.example',
    });
    const acme2 = await createRecord(backend, caller(ws), 'company', {
      name: 'ACME Industries',
      domain: 'www.acme.example/about',
    });
    // Same name, different object: never suggested.
    await createRecord(backend, caller(ws), 'task', { title: 'Dana Cohen' });

    const stats = await consolidateWorkspace(backend, ws);
    expect(stats?.mergeSuggestions).toBe(3);
    const found = await suggestions(ws);
    expect(found).toEqual(
      expect.arrayContaining([
        {
          a: pair(acme.id, acme2.id)[0],
          b: pair(acme.id, acme2.id)[1],
          reason: 'shared domain',
          status: 'pending',
        },
        {
          a: pair(dana.id, danaHome.id)[0],
          b: pair(dana.id, danaHome.id)[1],
          reason: 'shared phone',
          status: 'pending',
        },
        {
          a: pair(dana.id, danaTypo.id)[0],
          b: pair(dana.id, danaTypo.id)[1],
          reason: 'similar names',
          status: 'pending',
        },
      ]),
    );
    expect(found).toHaveLength(3);
    // The reason never copies personal data.
    for (const row of found)
      expect(row.reason).toMatch(/^(shared (email|phone|domain)|similar names)$/);

    const queue = await reviewQueue(backend, caller(ws, USER), 100);
    expect(queue.mergeSuggestions).toHaveLength(3);
  });

  it('never suggests two events, however alike (6.2)', async () => {
    const ws = await newWorkspace();
    // Same type, same title, same time: still two things that happened.
    await call(ws, '2026-10-01T10:00:00Z', 'Weekly pipeline review');
    await call(ws, '2026-10-01T10:00:00Z', 'Weekly pipeline review');
    await call(ws, '2026-10-08T10:00:00Z', 'Weekly pipeline revue');
    // Entities with the same labels in the same run are still suggested.
    const a = await createRecord(backend, caller(ws), 'company', { name: 'Weekly Pipeline Co' });
    const b = await createRecord(backend, caller(ws), 'company', { name: 'Weekly Pipeline Co.' });

    const stats = await consolidateWorkspace(backend, ws);
    expect(stats?.mergeSuggestions).toBe(1);
    expect(await suggestions(ws)).toEqual([
      {
        a: pair(a.id, b.id)[0],
        b: pair(a.id, b.id)[1],
        reason: 'similar names',
        status: 'pending',
      },
    ]);
  });

  it('does not suggest a dismissed pair again, and compares only changed records later', async () => {
    const ws = await newWorkspace();
    const a = await createRecord(backend, caller(ws), 'person', {
      name: 'Noa Levi',
      emails: email(),
    });
    const b = await createRecord(backend, caller(ws), 'person', {
      name: 'Noa Levy',
      emails: email(),
    });
    await consolidateWorkspace(backend, ws);
    const [suggestion] = await rows<{ id: unknown }>(ws, 'SELECT id FROM merge_suggestions;');
    await dismissSuggestion(backend, caller(ws, USER), publicId(suggestion?.id));
    await consolidateWorkspace(backend, ws);
    expect((await suggestions(ws)).map((s) => s.status)).toEqual(['dismissed']);
    expect([a.id, b.id]).toHaveLength(2);

    // A record created after the last run is compared on the next one.
    const c = await createRecord(backend, caller(ws), 'person', {
      name: 'Noa Levi',
      emails: email(),
    });
    expect((await consolidateWorkspace(backend, ws))?.mergeSuggestions).toBe(2);
    const fresh = (await suggestions(ws)).filter((s) => s.status === 'pending');
    expect(fresh.flatMap((s) => [s.a, s.b])).toContain(c.id);
  });

  it('counts only new pairs toward the cap and picks up the rest on the next run', async () => {
    const ws = await newWorkspace();
    const names = [
      ['Granite', 'Pelican'],
      ['Saffron', 'Quokka'],
      ['Tundra', 'Marble'],
      ['Violet', 'Harbor'],
    ];
    for (const [i, [x, y]] of names.entries()) {
      for (const name of [x, y]) {
        await createRecord(backend, caller(ws), 'company', { name, domain: `d${i}-${n}.example` });
      }
    }
    const comparedUntil = async () =>
      (
        await rows<{ compared_until: Date }>(
          ws,
          'SELECT compared_until FROM consolidator_runs:current;',
        )
      )[0]?.compared_until;
    const run = async () =>
      (await consolidateWorkspace(backend, ws, { maxNewSuggestions: 2 }))?.mergeSuggestions;

    expect(await run()).toBe(2);
    expect(await comparedUntil()).toEqual(new Date(0));
    // A decided pair and a pending one do not use the next run's budget.
    const [first] = await suggestions(ws);
    await adminQuery(
      ws,
      "UPDATE merge_suggestions SET status = 'dismissed' WHERE record_a = $a AND record_b = $b;",
      { a: first?.a, b: first?.b },
    );
    expect(await run()).toBe(2);
    expect(await run()).toBe(0);
    expect((await comparedUntil())?.getTime()).toBeGreaterThan(0);

    const found = await suggestions(ws);
    expect(found).toHaveLength(4);
    expect(found.every((s) => s.reason === 'shared domain')).toBe(true);
    expect(found.filter((s) => s.status === 'dismissed')).toHaveLength(1);
  });
});

describe('scheduling (4.2)', () => {
  it('runs a workspace once at a time and skips it until the interval passes', async () => {
    const ws = await newWorkspace();
    const hour = 60 * 60 * 1000;
    // Separate processes, so the local queue cannot be what serializes them.
    const results = await Promise.all([
      consolidateWorkspace(backend, ws, { minIntervalMs: hour }),
      consolidateWorkspace(backend.another(), ws, { minIntervalMs: hour }),
      consolidateWorkspace(backend.another(), ws, { minIntervalMs: hour }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await consolidateWorkspace(backend, ws, { minIntervalMs: hour })).toBeNull();
    await adminQuery(ws, 'UPDATE consolidator_runs:current SET started_at = time::now() - 2h;');
    expect(await consolidateWorkspace(backend, ws, { minIntervalMs: hour })).not.toBeNull();
  });

  it('the worker finds due workspaces through the runtime role and consolidates them', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(backend, caller(ws), 'person', { emails: email() });
    const source = await call(ws);
    await remember(backend, caller(ws), dana.id, { text: 'Uses Slack', source: source.id });
    await remember(backend, caller(ws), dana.id, { text: 'Uses Slack', source: source.id });

    const lines: string[] = [];
    const worker = await startWorker({
      backend,
      intervalMinutes: 60,
      tickMs: 60_000,
      log: { info: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
    });
    await worker.tick();
    await worker.stop();
    expect((await factsOf(backend, caller(ws), dana.id, 10)).facts).toHaveLength(1);
    const [run] = await rows<{ stats: object }>(ws, 'SELECT stats FROM consolidator_runs:current;');
    expect(run?.stats).toEqual({ supersededFacts: 1, mergeSuggestions: 0 });
    expect(lines.some((l) => l.includes(ws))).toBe(true);
  });
});
