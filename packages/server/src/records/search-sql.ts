import { fold } from './search-docs.js';

/**
 * Keyword queries over `search_documents` (spec section 8). Text is folded
 * as the stored documents are (lowercase, accents removed); the analyzers
 * tokenize both sides the same way, so prefixes ("Dan" finds "Dana"),
 * accents and email/host domain words match through the full-text index.
 *
 * The syntax is the one `websearch_to_tsquery` took: words are all
 * required, `OR` between two terms makes either one enough, `-word`
 * excludes, and a quoted phrase needs its words in order. Phrases are not
 * native: their words match through the index and the phrase is checked
 * against the folded text.
 */

export type SearchTerm = { words: string; phrase: boolean };
export type ParsedSearch = {
  /** Clauses ANDed together; each clause's alternatives are ORed. */
  clauses: SearchTerm[][];
  /** Terms that must not match. */
  excluded: SearchTerm[];
};

const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string) => fold(text).match(WORD) ?? [];

/** Parses websearch syntax: quoted phrases, `OR`, `-word`. */
export function parseSearch(text: string): ParsedSearch {
  const tokens: { term: SearchTerm; negated: boolean }[] = [];
  const ors: number[] = [];
  const pattern = /(-?)"([^"]*)"?|(\S+)/g;
  for (const m of text.matchAll(pattern)) {
    if (m[3] !== undefined && m[3] === 'OR') {
      ors.push(tokens.length);
      continue;
    }
    const negated = m[1] === '-' || (m[3]?.startsWith('-') ?? false);
    const raw = m[2] ?? (m[3] as string).replace(/^-+/, '');
    const words = wordsOf(raw);
    if (words.length === 0) continue;
    tokens.push({
      term: { words: words.join(' '), phrase: m[2] !== undefined && words.length > 1 },
      negated,
    });
  }
  const clauses: SearchTerm[][] = [];
  const excluded: SearchTerm[] = [];
  tokens.forEach((token, i) => {
    if (token.negated) {
      excluded.push(token.term);
      return;
    }
    // `a OR b`: b joins a's clause when an OR stands between them.
    const joins = ors.includes(i) && i > 0 && !tokens[i - 1]?.negated && clauses.length > 0;
    if (joins) clauses.at(-1)?.push(token.term);
    else clauses.push([token.term]);
  });
  return { clauses, excluded };
}

/** Plain keywords, all required (the `query_records` search). */
export function plainSearch(text: string): ParsedSearch {
  const words = wordsOf(text);
  return {
    clauses: words.length ? [[{ words: words.join(' '), phrase: false }]] : [],
    excluded: [],
  };
}

/** A phrase as a regex over folded text: its words in order, as whole words. */
export function phrasePattern(words: string): string {
  const escaped = words.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(^|[^\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}]+')}([^\\p{L}\\p{N}]|$)`;
}

export type SearchCondition = {
  /** A SurrealQL condition, or null when nothing can match. */
  where: string | null;
  vars: Record<string, unknown>;
  /** Score expression: the BM25 score of the required words, and of exact words. */
  score: string;
  exact: string;
};

/**
 * The condition matching a parsed query over `search_documents`.
 * `column` is the prefix-analyzed column (`all_text` or `label_text`);
 * exact-word scoring uses `folded`. Parameter names start with `prefix`.
 */
export function searchCondition(
  parsed: ParsedSearch,
  column: 'all_text' | 'label_text',
  prefix = 's',
): SearchCondition {
  const vars: Record<string, unknown> = {};
  let n = 0;
  const param = (value: unknown) => {
    const name = `${prefix}${n++}`;
    vars[name] = value;
    return `$${name}`;
  };
  const termCondition = (term: SearchTerm) => {
    const words = `${column} @@ ${param(term.words)}`;
    return term.phrase
      ? `(${words} AND string::matches(folded, <regex>${param(phrasePattern(term.words))}))`
      : words;
  };
  if (parsed.clauses.length === 0) return { where: null, vars, score: '0', exact: '0' };

  // Single-word clauses share one scored match, so BM25 ranks the hit.
  const required = parsed.clauses
    .filter((c) => c.length === 1 && !(c[0] as SearchTerm).phrase)
    .map((c) => (c[0] as SearchTerm).words);
  const parts: string[] = [];
  let score = '0';
  let exact = '0';
  if (required.length > 0) {
    const words = required.join(' ');
    parts.push(`${column} @1@ ${param(words)}`);
    // Words as typed rank above prefix matches; the exact index never narrows.
    parts.push(`(folded @2@ ${param(words)} OR true)`);
    score = 'search::score(1)';
    exact = 'search::score(2)';
  }
  for (const clause of parsed.clauses) {
    if (clause.length === 1 && !(clause[0] as SearchTerm).phrase) continue;
    const alternatives = clause.map(termCondition);
    parts.push(
      alternatives.length === 1 ? (alternatives[0] as string) : `(${alternatives.join(' OR ')})`,
    );
  }
  for (const term of parsed.excluded) parts.push(`!(${termCondition(term)})`);
  return { where: parts.join(' AND '), vars, score, exact };
}
