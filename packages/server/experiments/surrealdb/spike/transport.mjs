// How caller values reach SurrealDB: JSON-RPC variable coercion, CBOR, /sql
// query-string variables, and statement failures outside a transaction.
import { ADMIN, BASE, NS, ok, rpc, rpcCbor, show, sql, statuses, withDbs } from './lib.mjs';

const texts = [
  'INV:2026',
  'Order:12345',
  'acme:corp',
  'status:paid',
  'Meeting: Q3 review',
  'https://acme.com',
  'mailto:dana@acme.com',
  'dana@acme.com',
  '10:30',
  '2026-11-05',
  '2026-11-05T10:00:00Z',
  '3f2a8c1e-1b2c-4d5e-8f9a-0b1c2d3e4f5a',
  '5m',
  '42',
];

await withDbs(1, async (db) => {
  await ok(
    'DEFINE TABLE t SCHEMAFULL; DEFINE FIELD s ON t TYPE option<string>; DEFINE TABLE loose SCHEMALESS;',
    { db },
  );
  const json = (query, vars) =>
    rpc('query', [query, vars], { db }).then((r) => statuses(r.body.result ?? []));
  const cbor = (query, vars) =>
    rpcCbor('query', [query, vars], { db }).then((r) => statuses(r.result ?? []));

  const [jsonTypes] = await json('RETURN $v.map(|$x| type::of($x));', { v: texts });
  const [cborTypes] = await cbor('RETURN $v.map(|$x| type::of($x));', { v: texts });
  console.log('value'.padEnd(40), 'JSON-RPC'.padEnd(10), 'CBOR');
  texts.forEach((text, i) => {
    console.log(text.padEnd(40), String(jsonTypes[i]).padEnd(10), cborTypes[i]);
  });
  show(
    'JSON: nested object value',
    await json('RETURN type::of($o.a.b);', { o: { a: { b: 'INV:2026' } } }),
  );
  show('JSON: into string field', await json('UPSERT t:1 SET s = $v RETURN s;', { v: 'INV:2026' }));
  show(
    'JSON: into schemaless field',
    await json('UPSERT loose:1 SET s = $v RETURN type::of(s);', { v: 'INV:2026' }),
  );
  show('CBOR: into string field', await cbor('UPSERT t:2 SET s = $v RETURN s;', { v: 'INV:2026' }));
  show(
    'CBOR: into schemaless field',
    await cbor('UPSERT loose:2 SET s = $v RETURN type::of(s);', { v: 'INV:2026' }),
  );
  // CBOR tags: 12 datetime [seconds, nanoseconds], 8 record id [table, id], 10 decimal string.
  show(
    'CBOR: tagged datetime, record, decimal',
    await cbor('RETURN [type::of($d), type::of($r), type::of($m), $m * 1];', {
      d: { $tag: 12, value: [1793872800, 0] },
      r: { $tag: 8, value: ['t', '1'] },
      m: { $tag: 10, value: '12345678901234567890.123456789' },
    }),
  );
  show(
    'JSON: value cast is not executed',
    await json('CREATE t:9 SET s = <string>$v RETURN s;', { v: "x'; REMOVE TABLE t; --" }),
  );
  const response = await fetch(`${BASE}/sql?v=${encodeURIComponent('INV:2026')}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: ADMIN,
      'surreal-ns': NS,
      'surreal-db': db,
    },
    body: 'RETURN type::of($v);',
  });
  show('/sql query-string variable', statuses(await response.json()));
  show(
    'no tx: THROW, then a write',
    statuses(await sql(`THROW 'boom'; CREATE t:after SET s = 'x';`, { db })),
  );
  show('  -> t:after exists', await ok('SELECT VALUE id FROM t:after;', { db }));
});
