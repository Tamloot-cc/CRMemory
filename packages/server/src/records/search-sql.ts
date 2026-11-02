import type { Tx } from '../db/tx.js';

/**
 * The tsvector stored in `records.search`: the label weighted A, other
 * searchable text weighted B, with the `simple` configuration (5.1).
 */
export function searchVector(tx: Tx, label: string | null, body: string) {
  return tx`setweight(to_tsvector('simple', ${label ?? ''}), 'A')
    || setweight(to_tsvector('simple', ${body}), 'B')`;
}
