import { createHmac } from 'node:crypto';
import type { Db } from '../db/backend.js';
import type { Operation } from '../db/protocol.js';
import { AppError } from '../errors.js';
import type { Handle } from '../memory/handles.js';
import { identifiersFor } from '../records/derive.js';
import type { FieldState } from '../schema-engine/types.js';

/**
 * The suppression list (2.1): emails and phones erased by `forget`, and the
 * identities of events it erased, stored as a keyed HMAC so the list cannot
 * be reversed by hashing guessable values. The key comes from
 * `RETAINER_SUPPRESSION_KEY`, validated by `loadConfig` at startup, and
 * never enters the database, so a database dump alone does not reveal what
 * was erased.
 *
 * Rotating the key: move the old key to `RETAINER_SUPPRESSION_PREVIOUS_KEYS`
 * (comma-separated) and set a new one. Lookups try every configured key, so
 * earlier suppressions keep matching; new ones use the current key.
 */

export const SUPPRESSION_KEY_ENV = 'RETAINER_SUPPRESSION_KEY';
export const PREVIOUS_KEYS_ENV = 'RETAINER_SUPPRESSION_PREVIOUS_KEYS';

/** The key, or a 503 explaining how to configure it. */
export function requireSuppressionKey(): string {
  const key = process.env[SUPPRESSION_KEY_ENV];
  if (!key) {
    throw new AppError(
      503,
      'not_configured',
      `forget needs ${SUPPRESSION_KEY_ENV}: set it to a long random secret and keep it ` +
        `stable; to rotate it, move the old key to ${PREVIOUS_KEYS_ENV}`,
    );
  }
  return key;
}

/** The current key first, then previous ones, for lookups. */
function configuredKeys(): string[] {
  const current = process.env[SUPPRESSION_KEY_ENV];
  const previous = (process.env[PREVIOUS_KEYS_ENV] ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return [...new Set([...(current ? [current] : []), ...previous])];
}

/** The emails and phones a field value holds, normalized: what `forget` suppresses. */
export function suppressibleHandles(field: FieldState, value: unknown): Handle[] {
  if (field.type !== 'emails' && field.type !== 'phones') return [];
  return identifiersFor(field, value).flatMap((i) =>
    i.kind === 'email' || i.kind === 'phone' ? [{ kind: i.kind, value: i.value }] : [],
  );
}

/** The workspace is part of the message, so one handle has a different HMAC per workspace. */
function hmac(key: string, workspaceId: string, handle: Handle): string {
  return createHmac('sha256', key)
    .update(`${workspaceId}\n${handle.kind}\n${handle.value}`)
    .digest('hex');
}

const handleKey = (handle: Handle) => `${handle.kind}:${handle.value}`;

/** Adds normalized handles to the workspace's suppression list. Returns how many were new. */
export async function suppress(
  op: Operation,
  workspaceId: string,
  handles: readonly Handle[],
): Promise<number> {
  const key = requireSuppressionKey();
  if (handles.length === 0) return 0;
  const rows = [...new Map(handles.map((h) => [handleKey(h), h])).values()].map((h) => ({
    kind: h.kind,
    hmac: hmac(key, workspaceId, h),
  }));
  const existing = await op.rows<{ kind: string; hmac: string }>(
    'SELECT kind, hmac FROM suppressions WHERE hmac IN $hmacs;',
    { hmacs: rows.map((r) => r.hmac) },
  );
  const known = new Set(existing.map((r) => `${r.kind}:${r.hmac}`));
  const fresh = rows.filter((r) => !known.has(`${r.kind}:${r.hmac}`));
  op.batch.insert(
    'suppressions',
    fresh.map((r) => ({ id: op.newId(), ...r, created_at: op.now })),
  );
  return fresh.length;
}

/**
 * Which of the given normalized handles are suppressed, as `kind:value`.
 * Callers hold the privacy lock in shared mode (2.1), so a `forget` either
 * finished before this check or starts after the caller commits.
 *
 * Without a key no suppression can have been made, unless the key was
 * removed after one was: then every write that could bring a handle back
 * fails closed rather than skip the check.
 */
export async function suppressedOf(
  db: Db,
  workspaceId: string,
  handles: readonly Handle[],
): Promise<Set<string>> {
  if (handles.length === 0) return new Set();
  const keys = configuredKeys();
  if (keys.length === 0) {
    const [any] = await db.rows('SELECT id FROM suppressions LIMIT 1;');
    if (any) requireSuppressionKey();
    return new Set();
  }
  const byHmac = new Map(
    keys.flatMap((key) => handles.map((h) => [hmac(key, workspaceId, h), h] as const)),
  );
  const rows = await db.rows<{ hmac: string }>(
    'SELECT hmac FROM suppressions WHERE hmac IN $hmacs;',
    { hmacs: [...byHmac.keys()] },
  );
  return new Set(
    rows.flatMap((r) => {
      const handle = byHmac.get(r.hmac);
      return handle ? [handleKey(handle)] : [];
    }),
  );
}

export const isSuppressed = (suppressed: ReadonlySet<string>, handle: Handle) =>
  suppressed.has(handleKey(handle));

// ---------------------------------------------------------------------------
// Event identity tombstones (6.4)
// ---------------------------------------------------------------------------

/** Domain separator, so an identity HMAC can never equal a handle's. */
const EVENT_IDENTITY_DOMAIN = 'retainer:event-identity-suppression:v1';

/** Names a key without revealing it, so a tombstone records which key made it. */
export function keyId(key: string): string {
  return createHmac('sha256', key).update('retainer:suppression-key-id').digest('hex').slice(0, 16);
}

/**
 * The tombstone digest of an event identity. The parts are JSON-encoded, so
 * no two different (workspace, channel, external ID) triples share an input.
 */
function identityHmac(
  key: string,
  workspaceId: string,
  channel: string,
  externalId: string,
): string {
  return createHmac('sha256', key)
    .update(`${EVENT_IDENTITY_DOMAIN}\n${JSON.stringify([workspaceId, channel, externalId])}`)
    .digest('hex');
}

/**
 * Records that an erased event's identity must not be logged again. Stores
 * no raw channel, external ID or record ID: only the workspace, the key's ID
 * and the HMAC. A retained suppression token, not anonymization.
 */
export async function tombstoneEventIdentity(
  op: Operation,
  workspaceId: string,
  identities: readonly { channel: string; externalId: string }[],
): Promise<void> {
  if (identities.length === 0) return;
  const key = requireSuppressionKey();
  const rows = [
    ...new Map(
      identities.map((i) => {
        const digest = identityHmac(key, workspaceId, i.channel, i.externalId);
        return [digest, { key_id: keyId(key), hmac: digest }] as const;
      }),
    ).values(),
  ];
  const existing = await op.rows<{ hmac: string }>(
    'SELECT hmac FROM event_identity_tombstones WHERE key_id = $key AND hmac IN $hmacs;',
    { key: keyId(key), hmacs: rows.map((r) => r.hmac) },
  );
  const known = new Set(existing.map((r) => r.hmac));
  op.batch.insert(
    'event_identity_tombstones',
    rows.filter((r) => !known.has(r.hmac)).map((r) => ({ id: op.newId(), ...r, created_at: op.now })),
  );
}

/**
 * Whether an identity was erased. Every configured key is tried, so a key
 * rotation keeps matching. A tombstone made with a key that is no longer
 * configured cannot be checked, so the write fails closed rather than let a
 * changed key silently clear the suppression.
 *
 * The caller holds the identity's lock (`lockEventIdentity`) and the privacy
 * lock in shared mode; `forget` holds the privacy lock exclusively, so an
 * erasure and a logging of the same identity never interleave.
 */
export async function isEventIdentitySuppressed(
  db: Db,
  workspaceId: string,
  channel: string,
  externalId: string,
): Promise<boolean> {
  const [stored] = (await db.query(
    'SELECT VALUE array::distinct(key_id) FROM event_identity_tombstones GROUP ALL;',
  )) as [string[][]];
  const keyIds = [...new Set((stored ?? []).flat())];
  if (keyIds.length === 0) return false;
  const keys = configuredKeys();
  const known = new Set(keys.map(keyId));
  if (keyIds.some((id) => !known.has(id))) {
    throw new AppError(
      503,
      'not_configured',
      'event identities erased with a suppression key that is not configured cannot be ' +
        `checked; set ${SUPPRESSION_KEY_ENV} or ${PREVIOUS_KEYS_ENV} to include it`,
    );
  }
  const candidates = keys.map((key) => ({
    key_id: keyId(key),
    hmac: identityHmac(key, workspaceId, channel, externalId),
  }));
  const rows = await db.rows<{ key_id: string; hmac: string }>(
    'SELECT key_id, hmac FROM event_identity_tombstones WHERE hmac IN $hmacs;',
    { hmacs: candidates.map((c) => c.hmac) },
  );
  return rows.some((r) => candidates.some((c) => c.key_id === r.key_id && c.hmac === r.hmac));
}
