import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Database, PostgresReference, writeReport } from './database.mjs';
import { seed, seedFanout } from './model.mjs';
import { events, introductions, normalizeEvents, queryFile } from './reads.mjs';
import { compileSchema, quote } from './schema.mjs';

const count = Number(process.env.EXPERIMENT_ROWS || 250);
if (!Number.isInteger(count) || count < 1 || count > 5000)
  throw new Error('EXPERIMENT_ROWS must be 1..5000');
const database = new Database();
const reference = new PostgresReference();
const report = {
  measuredAt: new Date().toISOString(),
  release: '4.0.0',
  backend: 'SurrealKV',
  edition: 'Community',
  topology: 'single local Docker node',
  dataset: { extraInvoices: count, extraPayments: count },
  warmup: 3,
  samples: 15,
  caveat:
    'PostgreSQL is a real JSONB/edge-table read reference loaded from the accepted projection, not the in-flight Retainer backend. Client timings include HTTP vs PostgreSQL driver overhead; these are not production capacity measurements.',
  timings: {},
  plans: {},
};
async function measure(name, operation) {
  for (let i = 0; i < report.warmup; i++) await operation();
  const samples = [];
  for (let i = 0; i < report.samples; i++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  report.timings[name] = {
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  };
}
try {
  await database.initialize();
  await seed(database);
  await seedFanout(database, count);
  const snapshot = await database.snapshot();
  report.dataset.rowsByTable = Object.fromEntries(
    Object.entries(snapshot.tables).map(([key, rows]) => [key, rows.length]),
  );
  await reference.load(snapshot);
  const eventParams = ['company:acme', Number.MAX_SAFE_INTEGER, '~', 20, true];
  assert.deepEqual(
    await events(database, 'company:acme'),
    normalizeEvents(await reference.query('events', eventParams)),
  );
  assert.equal((await events(database, 'company:acme')).length, Math.min(20, count));
  const allPages = [];
  let cursor = {};
  for (;;) {
    const page = await events(database, 'company:acme', { ...cursor, limit: 37 });
    if (!page.length) break;
    allPages.push(...page);
    cursor = { beforeTime: page.at(-1).occurredAt, beforeUid: page.at(-1).uid };
  }
  assert.equal(allPages.length, count);
  assert.equal(new Set(allPages.map((item) => item.uid)).size, count);
  report.fanoutPagination = { expected: count, actual: allPages.length, unique: count };
  for (const [name, operation] of [
    ['surreal.events', () => events(database, 'company:acme')],
    ['postgres.events', () => reference.query('events', eventParams)],
    ['surreal.introductions', () => introductions(database, 'deal:one')],
    ['postgres.introductions', () => reference.query('introductions', ['deal:one', 20])],
    [
      'surreal.invoices',
      () => queryFile(database, 'invoices', { afterAmount: -1, afterUid: '', limit: 20 }),
    ],
    ['postgres.invoices', () => reference.query('invoices', [-1, '', 20])],
  ])
    await measure(name, operation);
  for (const [name, values] of [
    ['events', eventParams],
    ['introductions', ['deal:one', 20]],
    ['invoices', [-1, '', 20]],
  ]) {
    const query = (
      await readFile(new URL(`queries/${name}.sql`, import.meta.url), 'utf8')
    ).replaceAll('__SCHEMA__', `"${reference.schema}"`);
    report.plans[`postgres.${name}`] = await reference.sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      values,
    );
  }
  for (const [name, variables] of [
    [
      'events',
      { target: 'company:acme', beforeTime: Number.MAX_SAFE_INTEGER, beforeUid: '~', limit: 20 },
    ],
    ['introductions', { deal: 'deal:one', limit: 20 }],
    ['invoices', { afterAmount: -1, afterUid: '', limit: 20 }],
  ]) {
    const query = await readFile(new URL(`queries/${name}.surql`, import.meta.url), 'utf8');
    const bindings = Object.entries(variables)
      .map(([key, value]) => `LET $${key} = ${quote(value)};`)
      .join('\n');
    report.plans[`surreal.${name}`] = (
      await database.query(`${bindings}\n${query.trim().replace(/;$/, '')} EXPLAIN FULL;`)
    ).at(-1);
  }
  const beforeRestart = await events(database, 'company:acme');
  const expectedSnapshot = await database.snapshot();
  execFileSync(
    'docker',
    ['compose', '-f', new URL('compose.yml', import.meta.url).pathname, 'restart', 'surrealdb'],
    { stdio: 'pipe' },
  );
  for (let i = 0; ; i++) {
    try {
      await database.query('RETURN 1;');
      break;
    } catch (error) {
      if (i === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.deepEqual(await database.snapshot(), expectedSnapshot);
  assert.deepEqual(await events(database, 'company:acme'), beforeRestart);
  report.restartVerified = true;
  report.conflictRetries = database.retries;
  report.queryWorkBounded = false;
  report.queryWorkNote =
    'events.surql materializes event candidates in LET before applying LIMIT; EXPLAIN on its final SELECT only describes that materialized input. Introductions cap returned rows but may expand high-degree meetings. Neither query establishes bounded work at production fan-out.';
  await writeReport('measurements', report);
  console.log(JSON.stringify({ ...report, plans: 'saved in .results/measurements.json' }, null, 2));
  await mkdir(new URL('.results/', import.meta.url), { recursive: true });
  await writeFile(new URL('.results/schema.surql', import.meta.url), compileSchema());
} finally {
  await reference.close();
  await database.drop();
}
