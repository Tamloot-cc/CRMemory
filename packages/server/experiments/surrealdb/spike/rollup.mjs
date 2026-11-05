// Bounded one-hop event rollups. Postgres takes each source record's newest page
// through a lateral join (memory/events.ts, eventHistory); this measures the
// SurrealDB equivalents at increasing fan-out, with the same shapes in Postgres.
// The closure variant is a table scan per source; it runs once, at 100 sources.
import postgres from 'postgres';
import { ok, rootToken, show, time, withDbs } from './lib.mjs';

const FANOUT = (process.env.SPIKE_FANOUT || '100,1000,5000').split(',').map(Number);
const NOISE = Number(process.env.SPIKE_NOISE || 100000);
const T0 = Date.parse('2020-01-01T00:00:00Z');
const iso = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const page = 'ORDER BY occurred_at DESC LIMIT 21';
const operators = (plan) => JSON.stringify(plan).match(/"operator":"(TableScan|IndexScan)"/g);

const auth = await rootToken();
const pg = postgres(
  `postgres://experiment:local-experiment@127.0.0.1:${process.env.EXPERIMENT_PG_PORT || 18181}/experiment`,
  { onnotice: () => {} },
);
const schema = `spike_${Date.now()}`;

try {
  await withDbs(
    1,
    async (db) => {
      const q = (query) => ok(query, { db, auth });
      await q(`
        DEFINE TABLE inv_company TYPE RELATION IN invoice OUT company SCHEMAFULL;
        DEFINE INDEX inv_company_out ON inv_company FIELDS out;
        DEFINE TABLE att TYPE RELATION IN payment OUT invoice | company SCHEMAFULL;
        DEFINE FIELD occurred_at ON att TYPE datetime;
        DEFINE INDEX att_out_time ON att FIELDS out, occurred_at;
        CREATE invoice:probe;`);
      for (const [label, query] of [
        ['plan: literal record', `SELECT in FROM att WHERE out = invoice:probe ${page} EXPLAIN;`],
        [
          'plan: top-level LET',
          `LET $s = invoice:probe; SELECT in FROM att WHERE out = $s ${page} EXPLAIN;`,
        ],
        [
          'plan: inside .map() closure',
          `RETURN [invoice:probe].map(|$s| (SELECT in FROM att WHERE out = $s ${page} EXPLAIN));`,
        ],
        [
          'plan: inside FOR',
          `FOR $s IN [invoice:probe] { RETURN (SELECT in FROM att WHERE out = $s ${page} EXPLAIN); };`,
        ],
        [
          'plan: inline subquery',
          `SELECT in FROM att WHERE out IN (SELECT VALUE in FROM inv_company) ${page} EXPLAIN;`,
        ],
      ]) {
        const results = await q(query);
        show(label, operators(results.at(-1)));
      }

      let payment = 0;
      const insert = async (rows) => {
        for (let i = 0; i < rows.length; i += 5000) {
          const values = rows
            .slice(i, i + 5000)
            .map(([p, out, m]) => `{in: payment:${p}, out: ${out}, occurred_at: d'${iso(m)}'}`);
          await q(`INSERT RELATION INTO att [${values.join(',')}];`);
        }
      };
      // Unrelated attachments, so a table scan is visible in the timings.
      await insert(
        Array.from({ length: NOISE }, (_, i) => [payment++, `invoice:n${i % 20000}`, i]),
      );
      await pg.unsafe(`create schema ${schema}; set search_path = ${schema};
        create table links (source text, target text); create index on links (target);
        create table att (out text, occurred_at timestamptz); create index on att (out, occurred_at desc);
        insert into att select 'invoice:n' || (g % 20000), timestamptz '2020-01-01' + g * interval '1 minute'
          from generate_series(0, ${NOISE - 1}) g;
        analyze;`);

      const single = [];
      let loaded = 0;
      for (const n of [1000, 10000, 50000]) {
        await insert(
          Array.from({ length: n - loaded }, (_, i) => [payment++, 'invoice:hot', loaded + i]),
        );
        loaded = n;
        single.push({
          events_on_one_record: n,
          first_page: await time(30, () =>
            q(`SELECT in, occurred_at FROM att WHERE out = invoice:hot ${page};`),
          ),
          cursor_page: await time(30, () =>
            q(
              `SELECT in, occurred_at FROM att WHERE out = invoice:hot AND occurred_at < d'${iso(n / 2)}' ${page};`,
            ),
          ),
        });
      }
      console.log(JSON.stringify({ single_source: single }, null, 1));

      let invoices = 0;
      for (const sources of FANOUT) {
        const links = [];
        const rows = [];
        for (let i = invoices; i < sources; i++) {
          links.push(`{in: invoice:f${i}, out: company:c1}`);
          for (let j = 0; j < 5; j++) rows.push([payment++, `invoice:f${i}`, 200000 + i * 5 + j]);
        }
        for (let i = 0; i < links.length; i += 5000) {
          await q(`INSERT RELATION INTO inv_company [${links.slice(i, i + 5000).join(',')}];`);
        }
        await insert(rows);
        await pg.unsafe(`set search_path = ${schema};
          insert into links select 'invoice:f' || g, 'company:c1' from generate_series(${invoices}, ${sources - 1}) g;
          insert into att select 'invoice:f' || g, timestamptz '2020-01-01' + (200000 + g * 5 + j) * interval '1 minute'
            from generate_series(${invoices}, ${sources - 1}) g, generate_series(0, 4) j;
          analyze;`);
        invoices = sources;

        const [ids] = await q('SELECT VALUE in FROM inv_company WHERE out = company:c1;');
        // One top-level statement per source; the IDs come from the database, not a caller.
        const batch = ids
          .map((id) => `SELECT in, out, occurred_at FROM att WHERE out = ${id} ${page};`)
          .join('\n');
        const result = { sources, events: sources * 5 };
        result.surreal_one_statement_per_source = await time(10, async () => {
          const pages = await q(batch);
          pages
            .flat()
            .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
            .slice(0, 21);
        });
        // Index lookups or a table scan, by planner choice; either reads every
        // listed source's attachments before sorting.
        const inList = `LET $s = SELECT VALUE in FROM inv_company WHERE out = company:c1;
          SELECT in, out, occurred_at FROM att WHERE out IN $s ${page}`;
        result.surreal_in_list = await time(5, () => q(`${inList};`));
        result.surreal_in_list_plan = operators((await q(`${inList} EXPLAIN;`)).at(-1));
        if (sources === FANOUT[0]) {
          result.surreal_closure_single_run = await time(
            1,
            () =>
              q(`LET $s = SELECT VALUE in FROM inv_company WHERE out = company:c1;
                 LET $c = array::flatten($s.map(|$x| (SELECT in, out, occurred_at FROM att WHERE out = $x ${page})));
                 SELECT * FROM $c ${page};`),
            0,
          );
        }
        result.postgres_lateral = await time(20, () =>
          pg.unsafe(`set search_path = ${schema};
            select t.* from links s cross join lateral (
              select out, occurred_at from att where att.out = s.source order by occurred_at desc limit 21
            ) t where s.target = 'company:c1' order by t.occurred_at desc limit 21`),
        );
        console.log(JSON.stringify(result));
      }
    },
    auth,
  );
} finally {
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.end();
}
