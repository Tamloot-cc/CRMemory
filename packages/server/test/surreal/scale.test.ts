import type { Actor } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/backend.js';
import { percentiles } from '../../src/db/queue.js';
import { logEventFor } from '../../src/memory/service.js';
import { queryRecords } from '../../src/records/query.js';
import {
  type Caller,
  createRecord,
  findRecords,
  patchRecord,
  withRead,
} from '../../src/records/service.js';
import {
  attachedEventPage,
  countEventHistory,
  explainHistoryStreams,
} from '../../src/retrieval/history.js';
import { contextFor, timelineFor } from '../../src/retrieval/service.js';
import { timelinePage } from '../../src/retrieval/timeline.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * Scale gate (spec section 11): on 1,000 and 10,000 synthetic events, the
 * history, timeline, context and list pages stay correct, read through
 * indexes, and read about the same number of rows at both sizes: nothing
 * is materialized before the page limit. Half the events roll up to one
 * company from its deals (5,000 source records at 10,000 events); the
 * other half are a person's own. One deal then moves to another company.
 *
 * Seeding takes minutes, so the suite runs only when asked:
 * `RETAINER_SCALE=1000,10000 npx vitest run --project integration test/surreal/scale.test.ts`.
 * It prints a SCALE line per size and asserts correctness and row counts,
 * never a timing.
 */
const SIZES = (process.env.RETAINER_SCALE ?? '')
  .split(',')
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => n > 0);

const app = useTestBackend();
const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const PAGE = 50;
const REPEAT = 10;

type Reads = { rows: number; statements: number };

/** A Db that counts the statements it runs and the rows they return. */
function counting(db: Db, reads: Reads): Db {
  const rowsOf = (result: unknown) => (Array.isArray(result) ? result.length : result ? 1 : 0);
  return {
    target: db.target,
    async query(text, vars, options) {
      const results = await db.query(text, vars, options);
      reads.statements += results.length;
      for (const r of results) reads.rows += rowsOf(r);
      return results;
    },
    async rows<T>(text: string, vars?: Record<string, unknown>) {
      const rows = await db.rows<T>(text, vars);
      reads.statements += 1;
      reads.rows += rows.length;
      return rows;
    },
    async raw(text, vars, options) {
      const results = await db.raw(text, vars, options);
      reads.statements += results.length;
      for (const r of results) reads.rows += rowsOf(r.result);
      return results;
    },
  };
}

/** Runs `read` REPEAT times; returns the last result, its reads and latency percentiles. */
async function measure<T>(read: (wrap: (db: Db) => Db) => Promise<T>) {
  const latencies: number[] = [];
  let reads: Reads = { rows: 0, statements: 0 };
  let result: T | undefined;
  for (let i = 0; i < REPEAT; i++) {
    const current: Reads = { rows: 0, statements: 0 };
    const t0 = performance.now();
    result = await read((db) => counting(db, current));
    latencies.push(performance.now() - t0);
    reads = current;
  }
  return { result: result as T, reads, latencyMs: percentiles(latencies) };
}

/** Runs `tasks` with at most `width` in flight. */
async function inBatches<T>(count: number, width: number, task: (i: number) => Promise<T>) {
  const out: T[] = [];
  for (let start = 0; start < count; start += width) {
    const chunk = Array.from({ length: Math.min(width, count - start) }, (_, k) => start + k);
    out.push(...(await Promise.all(chunk.map(task))));
  }
  return out;
}

const measured = new Map<number, Record<string, Reads>>();

describe.skipIf(SIZES.length === 0)('scale', () => {
  for (const size of SIZES) {
    it(`stays correct and page-bounded at ${size} events`, async () => {
      const { id: workspaceId } = await createWorkspace(app, {
        name: `Scale ${size}`,
        template: 'sales',
      });
      const caller: Caller = {
        workspaceId,
        actor: AGENT,
        scopes: ['read', 'write', 'schema:write', 'admin'],
      };
      const change = await runSchemaChange(app, {
        workspaceId,
        actor: USER,
        scopes: ['schema:write', 'admin'],
        operations: [{ op: 'update_field', object: 'deal', field: 'company', rollUpEvents: true }],
      });
      expect(change.status).toBe('applied');

      const company = await createRecord(app, caller, 'company', { name: 'Initech' });
      const other = await createRecord(app, caller, 'company', { name: 'Globex' });
      const person = await createRecord(app, caller, 'person', { emails: 'dana@initech.test' });
      const sources = size / 2;
      const base = Date.UTC(2025, 0, 1);
      const at = (i: number) => new Date(base + i * 60_000).toISOString();

      // Seeding through the write path, so every derived row is real.
      const queueBefore = app.queues.stats.waitMs.length;
      const conflictsBefore = app.queues.stats.conflicts;
      const seedStarted = performance.now();
      const deals = await inBatches(sources, 200, (i) =>
        createRecord(app, caller, 'deal', { name: `Deal ${i}`, company: company.id }),
      );
      const rolled = await inBatches(sources, 200, (i) =>
        logEventFor(app, caller, {
          type: 'call',
          channel: 'zoom',
          externalId: `deal-${i}`,
          occurredAt: at(2 * i),
          title: `Deal call ${i}`,
          fields: {},
          participants: [],
          about: [(deals[i] as { id: string }).id],
        }),
      );
      const direct = await inBatches(sources, 200, (i) =>
        logEventFor(app, caller, {
          type: 'call',
          channel: 'zoom',
          externalId: `own-${i}`,
          occurredAt: at(2 * i + 1),
          title: `Own call ${i}`,
          fields: {},
          participants: [{ recordId: person.id }],
          about: [],
        }),
      );
      const seedMs = performance.now() - seedStarted;
      const queue = {
        writes: app.queues.stats.waitMs.length - queueBefore,
        waitMs: percentiles(app.queues.stats.waitMs.slice(queueBefore)),
        holdMs: percentiles(app.queues.stats.holdMs.slice(queueBefore)),
        conflicts: app.queues.stats.conflicts - conflictsBefore,
      };

      const historyPage = (wrap: (db: Db) => Db, recordId: string, cursor?: string) =>
        withRead(app, caller, (db, schema) =>
          attachedEventPage(wrap(db), schema, workspaceId, recordId, PAGE, cursor),
        );

      // Correctness: every rolled-up event exactly once, newest first.
      const count = await withRead(app, caller, (db, schema) =>
        countEventHistory(db, schema, workspaceId, company.id),
      );
      expect(count).toBe(sources);
      // The deep page: the sixth, or the last but one on small sizes.
      const deepAfter = Math.max(0, Math.min(4, Math.ceil(sources / PAGE) - 2));
      const seen: string[] = [];
      let cursor: string | undefined;
      let deepCursor: string | undefined;
      for (let page = 0; ; page++) {
        const result = await historyPage((db) => db, company.id, cursor);
        seen.push(...result.items.map((item) => item.id));
        if (page === deepAfter) deepCursor = result.nextCursor ?? undefined;
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(new Set(seen).size).toBe(sources);
      expect(seen).toEqual(rolled.map((e) => e.id).reverse());

      // Pages, measured.
      const reads = {
        companyHistoryFirst: await measure((wrap) => historyPage(wrap, company.id)),
        companyHistoryDeep: await measure((wrap) => historyPage(wrap, company.id, deepCursor)),
        personHistoryFirst: await measure((wrap) => historyPage(wrap, person.id)),
        personTimeline: await measure((wrap) =>
          withRead(app, caller, (db, schema) =>
            timelinePage(wrap(db), workspaceId, schema, person.id, { limit: PAGE }),
          ),
        ),
        dealList: await measure((wrap) =>
          withRead(app, caller, (db, schema) => {
            const object = schema.objectsByName.get('deal');
            if (!object) throw new Error('no deal object');
            return queryRecords(wrap(db), workspaceId, schema, object, {
              sort: [{ field: 'name', direction: 'asc' }],
              limit: PAGE,
            });
          }),
        ),
      };
      expect(reads.companyHistoryFirst.result.items).toHaveLength(PAGE);
      expect(reads.companyHistoryDeep.result.items.map((i) => i.id)).toEqual(
        seen.slice((deepAfter + 1) * PAGE, (deepAfter + 2) * PAGE),
      );
      expect(reads.personHistoryFirst.result.items.map((i) => i.id)).toEqual(
        direct
          .map((e) => e.id)
          .reverse()
          .slice(0, PAGE),
      );
      expect(reads.personTimeline.result.items).toHaveLength(PAGE);
      expect(reads.dealList.result.records).toHaveLength(PAGE);

      // The context pack: reported, not page-bounded (spec section 13).
      const context = await measure(() =>
        contextFor(app, caller, company.id, { tokenBudget: 4000 }),
      );
      const timeline = await timelineFor(app, caller, company.id, { limit: PAGE });
      expect(timeline.items.length).toBeGreaterThan(0);

      // Plans: index scans, never a table scan.
      const plans = await withRead(app, caller, (db) => explainHistoryStreams(db, company.id));
      expect(JSON.stringify(plans)).not.toMatch(/TableScan|Iterate Table/);

      // A source moved between rollup targets.
      const moved = deals[0] as { id: string };
      await patchRecord(app, { ...caller, actor: USER }, moved.id, {
        values: { company: other.id },
      });
      const otherHistory = await historyPage((db) => db, other.id);
      expect(otherHistory.items.map((i) => i.id)).toEqual([(rolled[0] as { id: string }).id]);
      expect(
        await withRead(app, caller, (db, schema) =>
          countEventHistory(db, schema, workspaceId, company.id),
        ),
      ).toBe(sources - 1);
      const listed = await findRecords(app, caller, 'deal', {
        filter: { company: other.id },
        limit: PAGE,
      });
      expect(listed.records.map((r) => r.id)).toEqual([moved.id]);

      const summary = {
        events: size,
        rollupSources: sources,
        seedSeconds: +(seedMs / 1000).toFixed(1),
        queue,
        pages: Object.fromEntries(
          Object.entries(reads).map(([name, m]) => [name, { ...m.reads, latencyMs: m.latencyMs }]),
        ),
        context: { ...context.reads, latencyMs: context.latencyMs },
      };
      console.log(`SCALE ${JSON.stringify(summary)}`);
      measured.set(
        size,
        Object.fromEntries(Object.entries(reads).map(([name, m]) => [name, m.reads])),
      );
    }, 3_600_000);
  }

  it.skipIf(SIZES.length < 2)('reads about the same rows per page at every size', () => {
    const [small, large] = [Math.min(...SIZES), Math.max(...SIZES)];
    const a = measured.get(small);
    const b = measured.get(large);
    expect(a && b).toBeTruthy();
    for (const [name, reads] of Object.entries(a ?? {})) {
      const at = b?.[name] as Reads;
      // Ten times the data, at most a quarter more rows per page.
      expect(at.rows, name).toBeLessThanOrEqual(Math.ceil(reads.rows * 1.25) + 10);
      expect(at.statements, name).toBeLessThanOrEqual(Math.ceil(reads.statements * 1.25) + 2);
    }
  });
});
