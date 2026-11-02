import { createHash } from 'node:crypto';
import type { Tx } from './db/tx.js';
import { AppError } from './errors.js';
import { stableJson } from './records/winner.js';

/** How long a key protects against a retry. */
const TTL = '24 hours';

export function requestHash(request: unknown): string {
  return createHash('sha256').update(stableJson(request)).digest('hex');
}

export type IdempotencyClaim = { kind: 'new'; id: string } | { kind: 'replay'; result: unknown };

/**
 * Claims a caller's idempotency key for one operation (6.2), in the same
 * transaction as the write. A concurrent request with the same key waits on
 * the unique index until this transaction ends, then replays its result. A
 * key reused with a different request fails. An expired key starts over.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  workspaceId: string,
  operation: string,
  key: string,
  hash: string,
): Promise<IdempotencyClaim> {
  if (key.length === 0 || key.length > 200) {
    throw new AppError(400, 'invalid_request', 'Idempotency-Key must be 1 to 200 characters');
  }
  const [claimed] = await tx<{ id: string }[]>`
    insert into idempotency_keys (workspace_id, operation, key, request_hash, expires_at)
    values (${workspaceId}, ${operation}, ${key}, ${hash}, now() + ${TTL}::interval)
    on conflict (workspace_id, operation, key) do update
      set request_hash = excluded.request_hash, result = null, created_at = now(),
        expires_at = excluded.expires_at
      where idempotency_keys.expires_at < now()
    returning id`;
  if (claimed) return { kind: 'new', id: claimed.id };

  const [existing] = await tx<{ request_hash: string; result: unknown }[]>`
    select request_hash, result from idempotency_keys
    where workspace_id = ${workspaceId} and operation = ${operation} and key = ${key}`;
  if (!existing || existing.request_hash !== hash) {
    throw new AppError(
      422,
      'idempotency_key_reused',
      'this Idempotency-Key was used for a different request',
    );
  }
  return { kind: 'replay', result: existing.result };
}

export async function storeIdempotentResult(tx: Tx, id: string, result: unknown): Promise<void> {
  await tx`update idempotency_keys set result = ${tx.json(result as never)} where id = ${id}`;
}
