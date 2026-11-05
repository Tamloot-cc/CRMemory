// Database record-access JWTs: table permissions, silent refusal, schema denial
// and confinement to the token's database.
import { NS, ok, recordAccessSigner, show, sql, withDbs } from './lib.mjs';

const signer = recordAccessSigner();
const pem = signer.publicKeyPem.replace(/\n/g, '\\n');
const now = Math.floor(Date.now() / 1000);
const claims = (db, overrides = {}) => ({
  iss: 'retainer',
  iat: now,
  nbf: now,
  exp: now + 600,
  ns: NS,
  db,
  ac: 'backend',
  id: 'principal:backend',
  ...overrides,
});

await withDbs(2, async (dbA, dbB) => {
  for (const [db, tag] of [
    [dbA, 'A'],
    [dbB, 'B'],
  ]) {
    await ok(
      `DEFINE ACCESS backend ON DATABASE TYPE RECORD WITH JWT ALGORITHM RS256 KEY "${pem}"
         DURATION FOR TOKEN 15m, FOR SESSION 15m;
       DEFINE TABLE t_full SCHEMAFULL PERMISSIONS FULL; DEFINE FIELD tag ON t_full TYPE string;
       DEFINE TABLE t_none SCHEMAFULL; DEFINE FIELD x ON t_none TYPE int;
       DEFINE TABLE t_ro SCHEMAFULL PERMISSIONS FOR select FULL, FOR create, update, delete NONE;
       DEFINE FIELD x ON t_ro TYPE int;
       DEFINE TABLE state SCHEMAFULL PERMISSIONS FULL; DEFINE FIELD revision ON state TYPE int;
       CREATE t_full:1 SET tag = '${tag}'; CREATE t_none:1 SET x = 1; CREATE t_ro:1 SET x = 1;
       CREATE state:main SET revision = 0;`,
      { db },
    );
  }
  const token = signer.sign(claims(dbA));
  const as = (query, db = dbA) => sql(query, { db, auth: token });
  const asRoot = (query) => ok(query, { db: dbA });

  show('select, PERMISSIONS FULL', await as('SELECT * FROM t_full;'));
  show('select, no PERMISSIONS clause', await as('SELECT * FROM t_none;'));
  show('create, no PERMISSIONS clause', await as('CREATE t_none:2 SET x = 2;'));
  show('update, update NONE', await as('UPDATE t_ro:1 SET x = 99;'));
  show('delete, delete NONE', await as('DELETE t_ro:1 RETURN BEFORE;'));
  show(
    'tx: bump revision + refused update',
    await as('BEGIN; UPDATE state:main SET revision += 1; UPDATE t_ro:1 SET x = 42; COMMIT;'),
  );
  show(
    '  -> revision, t_ro.x',
    await asRoot('SELECT revision FROM state:main; SELECT x FROM t_ro:1;'),
  );
  show(
    'tx with an affected-row assertion',
    await as(`BEGIN; UPDATE state:main SET revision += 1;
      LET $n = (UPDATE t_ro:1 SET x = 43 RETURN AFTER);
      IF array::len($n) != 1 { THROW 'effect_mismatch' }; COMMIT;`),
  );
  show(
    '  -> revision, t_ro.x',
    await asRoot('SELECT revision FROM state:main; SELECT x FROM t_ro:1;'),
  );
  show('DEFINE FIELD as record user', await as('DEFINE FIELD y ON t_full TYPE option<int>;'));
  show('REMOVE TABLE as record user', await as('REMOVE TABLE t_full;'));
  show('INFO FOR DB as record user', await as('INFO FOR DB;'));
  show('token for A, header names B: read', await as('SELECT tag FROM t_full;', dbB));
  show('token for A, header names B: write', await as(`CREATE t_full:2 SET tag = 'via-A';`, dbB));
  show('  -> A rows (root)', await asRoot('SELECT id, tag FROM t_full;'));
  show('  -> B rows (root)', await ok('SELECT id, tag FROM t_full;', { db: dbB }));
  show('USE DB B inside the query', await as(`USE DB ${dbB}; SELECT tag FROM t_full;`));
  show(
    'same signing key, token claims B',
    await sql('SELECT tag FROM t_full;', { db: dbB, auth: signer.sign(claims(dbB)) }),
  );
  show(
    'expired token',
    await sql('SELECT * FROM t_full;', {
      db: dbA,
      auth: signer.sign(claims(dbA, { iat: now - 1000, nbf: now - 1000, exp: now - 10 })),
      raw: true,
    }),
  );
  show('$auth and $access', await as('RETURN [$auth, $access];'));
});
