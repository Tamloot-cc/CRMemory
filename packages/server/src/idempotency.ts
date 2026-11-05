import { createHash } from 'node:crypto';
import { stableJson } from './records/winner.js';

/**
 * Idempotency keys are claimed by the operation receipt itself (section 7):
 * `operations` has a unique index on `(kind, idempotency_key)` and the
 * receipt commits in the same transaction as the write. What remains here
 * is the hash a key is bound to.
 */
export function requestHash(request: unknown): string {
  return createHash('sha256').update(stableJson(request)).digest('hex');
}
