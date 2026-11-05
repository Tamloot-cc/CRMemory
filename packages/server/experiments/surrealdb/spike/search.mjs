// Full-text parity with Retainer's Postgres search (ARCHITECTURE.md 5.1):
// prefixes, accents, domains, AND/OR/negation, phrases, exact-word ranking, fuzzy.
import { ok, show, sql, statuses, withDbs } from './lib.mjs';

const docs = [
  'Dana Levi',
  'José Álvarez',
  'Acme Corp dana@acme.com www.acme.com',
  'Meeting with Dana about renewal',
  'Danaher Inc',
  'Weekly meetings recap',
  'Dana Levi renewal call',
  'Jose Martinez',
];

await withDbs(1, async (db) => {
  const q = async (query) => statuses(await sql(query, { db }));
  await ok(
    `DEFINE ANALYZER prefix TOKENIZERS blank, class, punct FILTERS lowercase, ascii, edgengram(1, 20);
     DEFINE ANALYZER exact TOKENIZERS blank, class, punct FILTERS lowercase, ascii;
     DEFINE ANALYZER tri TOKENIZERS blank, class, punct FILTERS lowercase, ascii, ngram(3, 3);
     DEFINE TABLE doc SCHEMAFULL;
     DEFINE FIELD text ON doc TYPE string; DEFINE FIELD words ON doc TYPE string; DEFINE FIELD grams ON doc TYPE string;
     DEFINE INDEX ft_prefix ON doc FIELDS text FULLTEXT ANALYZER prefix BM25;
     DEFINE INDEX ft_exact ON doc FIELDS words FULLTEXT ANALYZER exact BM25;
     DEFINE INDEX ft_tri ON doc FIELDS grams FULLTEXT ANALYZER tri BM25;`,
    { db },
  );
  for (const [i, text] of docs.entries()) {
    const s = JSON.stringify(text);
    await ok(`CREATE doc:${i} SET text = ${s}, words = ${s}, grams = ${s};`, { db });
  }
  const find = async (label, where) =>
    show(label, (await q(`SELECT VALUE text FROM doc WHERE ${where};`))[0]);
  await find('prefix: dan', `text @@ 'dan'`);
  await find('accent: jose', `text @@ 'jose'`);
  await find('accent: José', `text @@ 'José'`);
  await find('domain: acme', `text @@ 'acme'`);
  await find('two words (AND): dana renewal', `text @@ 'dana renewal'`);
  await find('phrase: "dana levi"', `text @@ '"dana levi"'`);
  await find('word order: levi dana', `text @@ 'levi dana'`);
  await find('OR: two @@ predicates', `text @@ 'jose' OR text @@ 'danaher'`);
  await find('@OR@: jose danaher', `text @OR@ 'jose danaher'`);
  await find('negation: dana, not renewal', `text @@ 'dana' AND !(text @@ 'renewal')`);
  show(
    'BM25, exact-word index: dana',
    (
      await q(`SELECT text, search::score(1) AS s FROM doc WHERE words @1@ 'dana' ORDER BY s DESC;`)
    )[0],
  );
  show(
    'BM25, prefix index: dana',
    (
      await q(`SELECT text, search::score(1) AS s FROM doc WHERE text @1@ 'dana' ORDER BY s DESC;`)
    )[0],
  );
  await find('trigrams @@ (AND): dana levy', `grams @@ 'dana levy'`);
  show(
    'trigrams @OR@ then jaro_winkler: dana levy',
    (
      await q(`SELECT text, string::similarity::jaro_winkler(string::lowercase(text), 'dana levy') AS sim
        FROM doc WHERE grams @OR@ 'dana levy' ORDER BY sim DESC LIMIT 3;`)
    )[0],
  );
  for (const [label, where] of [
    ['plan: OR', `text @@ 'jose' OR text @@ 'danaher'`],
    ['plan: negation', `text @@ 'dana' AND !(text @@ 'renewal')`],
  ]) {
    const [plan] = await q(`SELECT * FROM doc WHERE ${where} EXPLAIN;`);
    show(label, JSON.stringify(plan).match(/"index":"[a-z_]+"|TableScan/g));
  }
});
