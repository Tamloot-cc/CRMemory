// Unique-index enforcement and write-conflict granularity: the guarantees the
// spec's uniqueness claims and per-workspace write protocol rely on.
import { BASE, ok, show, sql, statuses, time, withDbs } from './lib.mjs';

const outcome = (results) =>
  results.every((r) => r.status === 'OK')
    ? 'OK'
    : String(results.findLast((r) => r.status !== 'OK').result).slice(0, 90);
const tally = (outcomes) =>
  outcomes.reduce((counts, o) => {
    counts[o] = (counts[o] ?? 0) + 1;
    return counts;
  }, {});

await withDbs(2, async (dbA, dbB) => {
  const q = async (query, db = dbA) => statuses(await sql(query, { db }));
  show('network baseline: GET /health', await time(20, () => fetch(`${BASE}/health`)));
  await ok(
    `DEFINE TABLE claim SCHEMAFULL; DEFINE FIELD v ON claim TYPE string;
     DEFINE INDEX claim_v ON claim FIELDS v UNIQUE;
     DEFINE TABLE item SCHEMAFULL; DEFINE FIELD n ON item TYPE int;
     DEFINE TABLE other SCHEMAFULL; DEFINE FIELD n ON other TYPE int;`,
    { db: dbA },
  );
  await ok(
    'DEFINE TABLE item SCHEMAFULL; DEFINE FIELD n ON item TYPE int; CREATE item:0 SET n = 0;',
    { db: dbB },
  );

  show('unique: first CREATE', await q(`CREATE claim:1 SET v = 'dana@acme.com';`));
  show('unique: duplicate CREATE', await q(`CREATE claim:2 SET v = 'dana@acme.com';`));
  show(
    'unique: duplicate INSERT',
    await q(`INSERT INTO claim { id: claim:3, v: 'dana@acme.com' };`),
  );
  show(
    'unique: duplicate in one tx',
    await q(`BEGIN; CREATE claim:4 SET v = 'x@y.z'; CREATE claim:5 SET v = 'x@y.z'; COMMIT;`),
  );
  show(
    'unique: duplicate UPDATE',
    await q(`CREATE claim:6 SET v = 'other'; UPDATE claim:6 SET v = 'dana@acme.com';`),
  );
  show(
    '  -> rows with dana@acme.com',
    await q(`SELECT VALUE id FROM claim WHERE v = 'dana@acme.com';`),
  );
  show(
    '  -> index lookup plan',
    (await q(`SELECT * FROM claim WHERE v = 'dana@acme.com' EXPLAIN;`))[0],
  );
  const racers = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      sql(`CREATE claim:race${i} SET v = 'race@acme.com';`, { db: dbA }),
    ),
  );
  show('unique: 10 concurrent creates, same value', tally(racers.map(outcome)));
  show(
    '  -> rows with race@acme.com',
    await q(`SELECT VALUE id FROM claim WHERE v = 'race@acme.com';`),
  );

  // How the index was defined: composite, inside a transaction, on a relation
  // table, or over existing rows (with and without duplicates).
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await ok(
    `DEFINE TABLE a SCHEMAFULL; DEFINE FIELD x ON a TYPE string; DEFINE FIELD y ON a TYPE string;
     DEFINE INDEX a_xy ON a FIELDS x, y UNIQUE;
     DEFINE TABLE rel TYPE RELATION IN a OUT a ENFORCED SCHEMAFULL;
     DEFINE INDEX rel_pair ON rel FIELDS in, out UNIQUE;
     CREATE a:1 SET x = 'p', y = 'q'; CREATE a:2 SET x = 'r', y = 's';`,
    { db: dbA },
  );
  show('composite (x, y) unique: duplicate', await q(`CREATE a:3 SET x = 'p', y = 'q';`));
  show('relation (in, out) unique: first', await q('RELATE a:1->rel->a:2;'));
  show('relation (in, out) unique: duplicate', await q('RELATE a:1->rel->a:2;'));
  await ok(
    'BEGIN; DEFINE TABLE b SCHEMAFULL; DEFINE FIELD x ON b TYPE string; DEFINE INDEX b_x ON b FIELDS x UNIQUE; COMMIT;',
    { db: dbA },
  );
  show(
    'unique defined inside a tx: duplicate',
    await q(`CREATE b:1 SET x = 'p'; CREATE b:2 SET x = 'p';`),
  );
  await ok(
    `DEFINE TABLE c SCHEMAFULL; DEFINE FIELD x ON c TYPE string;
     CREATE c:1 SET x = 'p'; CREATE c:2 SET x = 'q';`,
    { db: dbA },
  );
  show('unique over existing rows: define', await q('DEFINE INDEX c_x ON c FIELDS x UNIQUE;'));
  show('  duplicate right after', await q(`CREATE c:3 SET x = 'p';`));
  show('  index status', await q('INFO FOR INDEX c_x ON c;'));
  await pause(5000);
  show('  duplicate after 5 s', await q(`CREATE c:4 SET x = 'p';`));
  await ok(
    `DEFINE TABLE d SCHEMAFULL; DEFINE FIELD x ON d TYPE string;
     CREATE d:1 SET x = 'p'; CREATE d:2 SET x = 'p';`,
    { db: dbA },
  );
  show(
    'unique over existing duplicates: define',
    await q('DEFINE INDEX d_x ON d FIELDS x UNIQUE;'),
  );
  await pause(5000);
  show('  index status after 5 s', await q('INFO FOR INDEX d_x ON d;'));
  show('  another duplicate', await q(`CREATE d:3 SET x = 'p';`));

  await ok(
    `${Array.from({ length: 10 }, (_, i) => `CREATE item:${i} SET n = 0;`).join(' ')} CREATE other:0 SET n = 0;`,
    { db: dbA },
  );
  const parallel = (make) => Promise.all(Array.from({ length: 10 }, (_, i) => make(i)));
  const txn = (body) => `BEGIN; ${body} COMMIT;`;
  show(
    'conflict: 10 txs, same record',
    tally((await parallel(() => sql(txn('UPDATE item:0 SET n += 1;'), { db: dbA }))).map(outcome)),
  );
  show(
    'conflict: 10 txs, different records, same table',
    tally(
      (await parallel((i) => sql(txn(`UPDATE item:${i} SET n += 1;`), { db: dbA }))).map(outcome),
    ),
  );
  show(
    'conflict: 10 txs, alternating tables',
    tally(
      (
        await parallel((i) =>
          sql(txn(i % 2 ? 'UPDATE other:0 SET n += 1;' : `UPDATE item:${i} SET n += 1;`), {
            db: dbA,
          }),
        )
      ).map(outcome),
    ),
  );
  show(
    'conflict: 10 txs, two databases',
    tally(
      (
        await parallel((i) =>
          sql(txn(`UPDATE item:${i % 2 ? 0 : i} SET n += 1;`), { db: i % 2 ? dbB : dbA }),
        )
      ).map(outcome),
    ),
  );
  show(
    'conflict: 10 single statements, different records',
    tally((await parallel((i) => sql(`UPDATE item:${i} SET n += 1;`, { db: dbA }))).map(outcome)),
  );
});
