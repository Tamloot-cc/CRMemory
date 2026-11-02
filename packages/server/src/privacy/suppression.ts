import { createHmac } from 'node:crypto';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { Handle } from '../memory/handles.js';
import { identifiersFor } from '../records/derive.js';
import type { FieldState } from '../schema-engine/types.js';

/**
 * The suppression list (2.1): emails and phones erased by `forget`, stored
 * as a keyed HMAC so the list cannot be reversed by hashing guessable
 * handles. The key comes from `RETAINER_SUPPRESSION_KEY`, validated by
 * `loadConfig` at startup, and never enters the database, so a database
 * dump alone does not reveal the handles. Changing the key forgets every
 * suppression made with the old one.
 */

export const SUPPRESSION_KEY_ENV = 'RETAINER_SUPPRESSION_KEY';

/** The key, or a 503 explaining how to configure it. */
export function requireSuppressionKey(): string {
  const key = process.env[SUPPRESSION_KEY_ENV];
  if (!key) {
    throw new AppError(
      503,
      'not_configured',
      `forget needs ${SUPPRESSION_KEY_ENV}: set it to a long random secret and keep it ` +
        'stable, since suppressions made with one key are not found with another',
    );
  }
  return key;
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

/**
 * A keyed stand-in for a suppressed handle, for anything that must tell
 * handles apart without storing them, such as an interaction's request
 * hash. A handle can only be suppressed when the key is set.
 */
export function suppressionDigest(workspaceId: string, handle: Handle): string {
  return hmac(requireSuppressionKey(), workspaceId, handle);
}

/** Adds normalized handles to the workspace's suppression list. Returns how many were new. */
export async function suppress(
  tx: Tx,
  workspaceId: string,
  handles: readonly Handle[],
): Promise<number> {
  const key = requireSuppressionKey();
  if (handles.length === 0) return 0;
  const rows = [...new Map(handles.map((h) => [handleKey(h), h])).values()].map((h) => ({
    workspace_id: workspaceId,
    kind: h.kind,
    hmac: hmac(key, workspaceId, h),
  }));
  const inserted = await tx`
    insert into suppressions ${tx(rows)}
    on conflict (workspace_id, kind, hmac) do nothing
    returning id`;
  return inserted.length;
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
  tx: Tx,
  workspaceId: string,
  handles: readonly Handle[],
): Promise<Set<string>> {
  if (handles.length === 0) return new Set();
  const key = process.env[SUPPRESSION_KEY_ENV];
  if (!key) {
    const [any] = await tx`select 1 from suppressions where workspace_id = ${workspaceId} limit 1`;
    if (any) requireSuppressionKey();
    return new Set();
  }
  const byHmac = new Map(handles.map((h) => [hmac(key, workspaceId, h), h]));
  const rows = await tx<{ hmac: string }[]>`
    select hmac from suppressions
    where workspace_id = ${workspaceId} and hmac = any(${[...byHmac.keys()]}::text[])`;
  return new Set(
    rows.flatMap((r) => {
      const handle = byHmac.get(r.hmac);
      return handle ? [handleKey(handle)] : [];
    }),
  );
}

export const isSuppressed = (suppressed: ReadonlySet<string>, handle: Handle) =>
  suppressed.has(handleKey(handle));
