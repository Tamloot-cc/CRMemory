// Per-request latency by authentication method and endpoint, and how write
// transactions scale with the number of writes and statements they carry.
import {
  BASE,
  BASIC,
  NS,
  ok,
  recordAccessSigner,
  rootToken,
  rpc,
  TARGET,
  time,
  withDbs,
} from './lib.mjs';

const n = TARGET === 'local' ? 50 : 15;

await withDbs(1, async (db) => {
  const token = await rootToken();
  const signer = recordAccessSigner();
  const now = Math.floor(Date.now() / 1000);
  await ok(
    `DEFINE ACCESS backend ON DATABASE TYPE RECORD WITH JWT ALGORITHM RS256
       KEY "${signer.publicKeyPem.replace(/\n/g, '\\n')}" DURATION FOR TOKEN 15m, FOR SESSION 15m;
     DEFINE TABLE state SCHEMAFULL PERMISSIONS FULL; DEFINE FIELD revision ON state TYPE int;
     DEFINE TABLE item SCHEMAFULL PERMISSIONS FULL; DEFINE FIELD n ON item TYPE int;
     CREATE state:main SET revision = 0;`,
    { db, auth: token },
  );
  const record = signer.sign({
    iat: now,
    nbf: now,
    exp: now + 900,
    ns: NS,
    db,
    ac: 'backend',
    id: 'principal:backend',
  });
  let next = 0;
  const writes = (count) => {
    const ids = Array.from({ length: count }, () => next++);
    return `BEGIN; UPDATE state:main SET revision += 1;
      ${ids.map((i) => `CREATE item:${i} SET n = ${i};`).join(' ')} COMMIT;`;
  };
  const results = {
    health: await time(n, () => fetch(`${BASE}/health`)),
    // Cloud issues tokens only; Basic authentication is measured locally.
    ...(TARGET === 'local' && {
      basic_sql: await time(n, () => ok('RETURN 1;', { db, auth: BASIC })),
    }),
    token_sql: await time(n, () => ok('RETURN 1;', { db, auth: token })),
    token_rpc: await time(n, () => rpc('query', ['RETURN 1;', {}], { db, auth: token })),
    record_access_sql: await time(n, () => ok('RETURN 1;', { db, auth: record })),
    ten_selects_one_request: await time(n, () =>
      ok('SELECT * FROM state:main;'.repeat(10), { db, auth: record }),
    ),
    tx_1_write: await time(n, () => ok(writes(1), { db, auth: record })),
    tx_10_writes: await time(n, () => ok(writes(10), { db, auth: record })),
    tx_50_writes: await time(Math.ceil(n / 3), () => ok(writes(50), { db, auth: record })),
  };
  console.log(JSON.stringify(results, null, 1));
});
