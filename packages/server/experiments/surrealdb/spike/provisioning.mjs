// Time to provision and remove a workspace-sized database, as each test file
// (and each browser test) would. Postgres clones a template; SurrealDB cannot.
import { performance } from 'node:perf_hooks';
import { NS, newDb, ok, rootToken } from './lib.mjs';

const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('\n');
const definitions = [
  `DEFINE ACCESS backend ON DATABASE TYPE RECORD WITH JWT ALGORITHM HS512
     KEY 'spike-only-key-spike-only-key-spike-only-key' DURATION FOR TOKEN 15m;`,
  // Fixed tables: metadata, assertions, directory, identifiers, jobs, receipts...
  range(
    22,
    (i) => `DEFINE TABLE fx${i} SCHEMAFULL PERMISSIONS FULL;
      ${range(6, (j) => `DEFINE FIELD c${j} ON fx${i} TYPE option<string>;`)}
      DEFINE INDEX fx${i}_a ON fx${i} FIELDS c0, c1; DEFINE INDEX fx${i}_u ON fx${i} FIELDS c2 UNIQUE;`,
  ),
  // Base-template object tables.
  range(
    6,
    (i) => `DEFINE TABLE o${i} SCHEMAFULL PERMISSIONS FULL;
      ${range(15, (j) => `DEFINE FIELD f${j} ON o${i} TYPE option<string | null>;`)}
      DEFINE INDEX o${i}_f0 ON o${i} FIELDS f0;`,
  ),
  // Relation tables, one per owning relation field.
  range(
    10,
    (
      i,
    ) => `DEFINE TABLE r${i} TYPE RELATION IN o${i % 6} OUT o${(i + 1) % 6} ENFORCED SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD assertion ON r${i} TYPE option<string>; DEFINE INDEX r${i}_pair ON r${i} FIELDS in, out UNIQUE;`,
  ),
  `DEFINE ANALYZER prefix TOKENIZERS blank, class, punct FILTERS lowercase, ascii, edgengram(1, 20);
   DEFINE ANALYZER exact TOKENIZERS blank, class, punct FILTERS lowercase, ascii;
   DEFINE TABLE search_documents SCHEMAFULL PERMISSIONS FULL;
   DEFINE FIELD text ON search_documents TYPE string; DEFINE FIELD words ON search_documents TYPE string;
   DEFINE INDEX sp ON search_documents FIELDS text FULLTEXT ANALYZER prefix BM25;
   DEFINE INDEX se ON search_documents FIELDS words FULLTEXT ANALYZER exact BM25;`,
].join('\n');

const auth = await rootToken();
async function provision() {
  const db = newDb('prov');
  const started = performance.now();
  await ok(`DEFINE NAMESPACE IF NOT EXISTS ${NS}; USE NS ${NS}; DEFINE DATABASE ${db};`, {
    db: undefined,
    auth,
  });
  const remove = () => ok(`REMOVE DATABASE ${db};`, { db: undefined, auth });
  try {
    await ok(`BEGIN; ${definitions} COMMIT;`, { db, auth });
  } catch (error) {
    await remove();
    throw error;
  }
  const provisioned = performance.now();
  await remove();
  return { provision: provisioned - started, remove: performance.now() - provisioned };
}
const summary = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { p50: +sorted[Math.floor(sorted.length / 2)].toFixed(1), max: +sorted.at(-1).toFixed(1) };
};

console.log('definition statements:', definitions.split(';').filter((s) => s.trim()).length);
const sequential = [];
for (let i = 0; i < 10; i++) sequential.push(await provision());
console.log('sequential provision ms', summary(sequential.map((t) => t.provision)));
console.log('remove ms', summary(sequential.map((t) => t.remove)));
const started = performance.now();
const parallel = await Promise.all(Array.from({ length: 8 }, provision));
console.log(
  '8 in parallel: wall ms',
  +(performance.now() - started).toFixed(1),
  'each',
  summary(parallel.map((t) => t.provision)),
);
