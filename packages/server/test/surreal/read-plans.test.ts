import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { type StreamSpec, streamStatement } from '../../src/db/pagination.js';
import { parseSearch, searchCondition } from '../../src/records/search-sql.js';
import { type Caller, createRecord, withRead } from '../../src/records/service.js';
import { searchFor } from '../../src/retrieval/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * Plans of the read side's paginated streams (spec section 8): each is a
 * top-level statement on parameters that the planner turns into an index
 * scan with its limit pushed down, never a table scan. A planner change or
 * a rewritten query fails here instead of silently scanning.
 */

const app = useTestBackend();
let workspaceId: string;
const AGENT: Actor = { type: 'agent', id: 'inbox' };
const as = (actor: Actor): Caller => ({ workspaceId, actor, scopes: ['read', 'write'] });

beforeAll(async () => {
  workspaceId = (await createWorkspace(app, { name: 'Plans', template: 'sales' })).id;
});

const id = '10000000-0000-4000-8000-000000000001';

/** Stream shapes as the read side issues them: table, condition, vars, time column, index. */
const STREAMS: [string, string, Record<string, unknown>, string, string][] = [
  [
    'field_assertions',
    'record = $record',
    { record: id },
    'observed_at',
    'field_assertions_record_observed_idx',
  ],
  [
    'field_assertions',
    'record = $record',
    { record: id },
    'created_at',
    'field_assertions_record_time_idx',
  ],
  [
    'field_assertions',
    'source = $source',
    { source: id },
    'created_at',
    'field_assertions_source_time_idx',
  ],
  [
    'field_assertions',
    "status = 'pending_review'",
    {},
    'created_at',
    'field_assertions_review_idx',
  ],
  ['merge_suggestions', "status = 'pending'", {}, 'created_at', 'merge_suggestions_status_idx'],
  ['facts', 'record = $record', { record: id }, 'valid_from', 'facts_record_idx'],
];

describe('read stream plans', () => {
  for (const [table, where, vars, time, index] of STREAMS) {
    for (const descending of [true, false]) {
      it(`${table} by ${where} ordered by ${time} ${descending ? 'desc' : 'asc'}`, async () => {
        const spec: StreamSpec<unknown> = {
          table,
          where,
          vars,
          time,
          fields: '*',
          timeOf: () => new Date(),
          keyOf: () => '',
          descending,
          batch: 21,
        };
        for (const bounded of [false, true]) {
          const plan = await withRead(app, as(AGENT), (db) =>
            db.query(`${streamStatement(spec, bounded)} EXPLAIN;`, { ...vars, __at: new Date() }),
          );
          const text = JSON.stringify(plan);
          expect(text).toContain('"operator":"IndexScan"');
          expect(text).toContain(`"index":"${index}"`);
          expect(text).toContain('"limit":"21"');
          expect(text).not.toContain('TableScan');
        }
      });
    }
  }

  it('searches through the full-text index, never a scan', async () => {
    await createRecord(app, as(AGENT), 'company', { name: 'Plan Search Co' });
    const condition = searchCondition(parseSearch('plan "search co" OR zz -nope'), 'all_text');
    const plan = await withRead(app, as(AGENT), (db) =>
      db.query(
        `SELECT id FROM search_documents WHERE ${condition.where} AND kind = 'record' EXPLAIN;`,
        condition.vars,
      ),
    );
    const text = JSON.stringify(plan);
    expect(text).toContain('FullTextScan');
    expect(text).not.toContain('TableScan');
    const found = await searchFor(app, as(AGENT), { query: 'plan "search co"', limit: 10 });
    expect(found.records.map((r) => r.label)).toEqual(['Plan Search Co']);
    const phrase = await searchFor(app, as(AGENT), { query: '"co search"', limit: 10 });
    // No text match; the label may still come back as a similar label.
    expect(phrase.records.filter((r) => r.match === 'text')).toEqual([]);
    const negated = await searchFor(app, as(AGENT), { query: 'plan -search', limit: 10 });
    expect(negated.records.filter((r) => r.match === 'text')).toEqual([]);
    const either = await searchFor(app, as(AGENT), { query: 'zzz OR plan', limit: 10 });
    expect(either.records.map((r) => r.label)).toEqual(['Plan Search Co']);
  });
});
