// Per-request latency of a trivial query by authentication method and endpoint.
import { ok, rootToken, rpc, time, withDbs } from './lib.mjs';

await withDbs(1, async (db) => {
  const token = await rootToken();
  const results = {
    basic_sql: await time(50, () => ok('RETURN 1;', { db })),
    token_sql: await time(50, () => ok('RETURN 1;', { db, auth: token })),
    token_rpc: await time(50, () => rpc('query', ['RETURN 1;', {}], { db, auth: token })),
  };
  console.log(JSON.stringify(results, null, 1));
});
