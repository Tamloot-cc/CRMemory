// Schema definitions inside transactions, typed-table behavior, native relation
// constraints, and definitions racing ordinary writers on one revision record.
import { ok, show, sql, statuses, withDbs } from './lib.mjs';

await withDbs(1, async (db) => {
  const q = async (query) => statuses(await sql(query, { db }));
  await ok(
    `DEFINE TABLE obj SCHEMAFULL; DEFINE FIELD name ON obj TYPE option<string>;
     DEFINE TABLE state SCHEMAFULL; DEFINE FIELD revision ON state TYPE int;
     CREATE state:main SET revision = 0; CREATE obj:1 SET name = 'a'; CREATE obj:2 SET name = 'a';`,
    { db },
  );
  show('schemafull: undeclared field', await q(`CREATE obj:3 SET name = 'x', nope = 1;`));
  show(
    'tx: DEFINE FIELD + write it + bump revision',
    await q(`BEGIN; DEFINE FIELD f_new ON obj TYPE option<string>; UPDATE obj:1 SET f_new = 'v';
      UPDATE state:main SET revision += 1; COMMIT;`),
  );
  show(
    'tx: definitions, then THROW',
    await q(`BEGIN; DEFINE FIELD f_rb ON obj TYPE option<string>;
    DEFINE TABLE t_rb SCHEMAFULL; THROW 'abort'; COMMIT;`),
  );
  show(
    '  -> f_rb, t_rb after rollback',
    await q('RETURN [(INFO FOR TABLE obj).fields.f_rb, (INFO FOR DB).tables.t_rb];'),
  );
  show(
    'tx: relation table + unique pair + RELATE',
    await q(`BEGIN; DEFINE TABLE other SCHEMAFULL;
      DEFINE TABLE r_f1 TYPE RELATION IN obj OUT other ENFORCED SCHEMAFULL;
      DEFINE INDEX r_f1_pair ON r_f1 FIELDS in, out UNIQUE;
      CREATE other:1; RELATE obj:1->r_f1->other:1; COMMIT;`),
  );
  show('  missing target', await q('RELATE obj:2->r_f1->other:404;'));
  show('  wrong target table', await q('RELATE obj:2->r_f1->obj:1;'));
  show('  duplicate pair', await q('RELATE obj:1->r_f1->other:1;'));
  show(
    '  CREATE directly in relation table',
    await q('CREATE r_f1 SET in = obj:2, out = other:1;'),
  );
  show(
    'tx: UNIQUE index over duplicates',
    await q(
      `BEGIN; DEFINE INDEX u_name ON obj FIELDS name UNIQUE; UPDATE state:main SET revision += 1; COMMIT;`,
    ),
  );
  show(
    '  -> index exists, revision',
    await q('RETURN (INFO FOR TABLE obj).indexes.u_name; SELECT revision FROM state:main;'),
  );
  show(
    'explicit null vs missing',
    await q(`DEFINE FIELD n ON obj TYPE option<string | null>; UPDATE obj:1 SET n = NULL; UPDATE obj:2 SET n = NONE;
      SELECT id, type::of(n) AS t FROM obj ORDER BY id;`),
  );
  const writers = Array.from({ length: 20 }, (_, i) =>
    sql(`BEGIN; UPDATE obj:2 SET name = 'w${i}'; UPDATE state:main SET revision += 1; COMMIT;`, {
      db,
    }),
  );
  const definition = sql(
    'BEGIN; DEFINE FIELD f_conc ON obj TYPE option<int>; UPDATE state:main SET revision += 1; COMMIT;',
    { db },
  );
  const outcome = (results) =>
    results.every((r) => r.status === 'OK')
      ? 'OK'
      : String(results.findLast((r) => r.status !== 'OK').result).slice(0, 100);
  const [defined, ...written] = (await Promise.all([definition, ...writers])).map(outcome);
  show('definition racing 20 writers', {
    definition: defined,
    writers_committed: written.filter((s) => s === 'OK').length,
    writer_errors: [...new Set(written.filter((s) => s !== 'OK'))],
  });
  show('  -> final revision', await q('SELECT VALUE revision FROM state:main;'));
});
