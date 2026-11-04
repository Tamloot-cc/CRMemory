import type { Fragment } from 'postgres';
import type { Tx } from '../db/tx.js';

/**
 * Stored search text and the queries that match it (5.1). Both sides use
 * the `simple` configuration over text folded by `retainer_fold` (accents
 * removed, migration 0010), so "Jose" finds "José" and the other way round.
 * Every vector and query is built here.
 */

/** A value to index or query: a string parameter, or a SQL expression such as a column. */
type SearchText = string | Fragment;

function folded(tx: Tx, text: SearchText): Fragment {
  return tx`retainer_fold(${text}::text)`;
}

/** `to_tsvector` over folded text. */
export function textVector(tx: Tx, text: SearchText): Fragment {
  return tx`to_tsvector('simple', ${folded(tx, text)})`;
}

/**
 * The tsvector stored in `records.search` (events included) and `facts.search`: the
 * label (or title) weighted A, other searchable text weighted B.
 */
export function searchVector(tx: Tx, label: SearchText | null, body: SearchText): Fragment {
  return tx`setweight(${textVector(tx, label ?? '')}, 'A')
    || setweight(${textVector(tx, body)}, 'B')`;
}

/**
 * A query in a scalar subquery: Postgres computes it once per statement
 * (an InitPlan), not once per row, even under a generic plan.
 */
function once(tx: Tx, query: Fragment): Fragment {
  return tx`(select ${query})`;
}

/**
 * Every word of a tsquery as a prefix (`'dan':*`), so "Dan" finds "Dana" and
 * "meet" finds "meetings". Postgres renders each lexeme in single quotes
 * with inner quotes doubled, so the pattern matches whole lexemes and never
 * an operator.
 */
function asPrefix(tx: Tx, query: Fragment): Fragment {
  return tx`regexp_replace((${query})::text, '''(?:[^'']|'''')*''', '\\&:*', 'g')::tsquery`;
}

function webQuery(tx: Tx, text: string): Fragment {
  return tx`websearch_to_tsquery('simple', ${folded(tx, text)})`;
}

/** The words as typed, in `websearch_to_tsquery` syntax: quoted phrases, `OR`, `-word`. */
export function exactQuery(tx: Tx, text: string): Fragment {
  return once(tx, webQuery(tx, text));
}

/** The `search` query: `websearch_to_tsquery` syntax, every word matched as a prefix. */
export function prefixQuery(tx: Tx, text: string): Fragment {
  return once(tx, asPrefix(tx, webQuery(tx, text)));
}

/** Plain keywords, all required, each matched as a prefix (`query_records` search). */
export function plainPrefixQuery(tx: Tx, text: string): Fragment {
  return once(tx, asPrefix(tx, tx`plainto_tsquery('simple', ${folded(tx, text)})`));
}

/** The words of `text` as an exact phrase. */
export function phraseQuery(tx: Tx, text: SearchText): Fragment {
  return tx`phraseto_tsquery('simple', ${folded(tx, text)})`;
}
