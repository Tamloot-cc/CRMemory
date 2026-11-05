import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { log } from '../log.js';
import type { Backend } from './backend.js';
import { isRetryableConflict } from './surreal.js';

/**
 * The single-process lease (spec section 9). It detects a mistaken second
 * process, such as an overlapping deploy; it is not coordination.
 * Correctness across processes still rests on the revision check.
 */

export const LEASE_HEARTBEAT_MS = 10_000;
export const LEASE_TTL_MS = 30_000;

export class LeaseHeldError extends Error {
  constructor(readonly holder: string) {
    super(`another Retainer process holds the lease (${holder}); refusing to start`);
    this.name = 'LeaseHeldError';
  }
}

export type Lease = {
  holder: string;
  /** Stops the heartbeat and releases the lease. */
  release: () => Promise<void>;
};

export async function acquireLease(
  backend: Backend,
  options: {
    holder?: string;
    heartbeatMs?: number;
    ttlMs?: number;
    /** Called when the lease cannot be renewed; the server stops admitting writes and exits. */
    onLost?: (error: Error) => void;
  } = {},
): Promise<Lease> {
  const holder = options.holder ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const ttl = options.ttlMs ?? LEASE_TTL_MS;
  const catalog = backend.catalog();
  const now = () => new Date();
  const started = now();
  // Racing first boots: the database lets one transaction commit and fails
  // the others at COMMIT with a retryable conflict. A retry then sees the
  // winner and refuses with LeaseHeldError.
  for (let attempt = 1; ; attempt++) {
    const at = attempt === 1 ? started : now();
    const results = await catalog.raw(
      `BEGIN;
       LET $current = (SELECT * FROM ONLY process_lease:current);
       IF $current != NONE AND $current.holder != $holder AND $current.expires_at > $now {
         THROW 'retainer:lease_held:' + $current.holder
       };
       UPSERT process_lease:current CONTENT { holder: $holder, started_at: $now, heartbeat_at: $now, expires_at: $expires };
       COMMIT;`,
      { holder, now: at, expires: new Date(at.getTime() + ttl) },
    );
    if (results.every((r) => r.status === 'OK')) break;
    const messages = results.filter((r) => r.status === 'ERR').map((r) => String(r.result));
    const held = messages
      .map((m) => /retainer:lease_held:(\S+?)['"]?$/.exec(m))
      .find((m) => m !== null);
    if (held) throw new LeaseHeldError(held[1] as string);
    if (messages.some(isRetryableConflict) && attempt < 5) continue;
    const cause =
      messages.find((m) => !/not executed|transaction was aborted/i.test(m)) ?? messages[0];
    throw new Error(`could not take the process lease: ${cause}`);
  }

  let stopped = false;
  const heartbeat = async () => {
    if (stopped) return;
    const at = now();
    try {
      const [renewed] = (await catalog.query(
        'UPDATE process_lease:current SET heartbeat_at = $now, expires_at = $expires WHERE holder = $holder RETURN id;',
        { holder, now: at, expires: new Date(at.getTime() + ttl) },
      )) as [unknown[]];
      if (!Array.isArray(renewed) || renewed.length !== 1) throw new Error('the lease was taken');
    } catch (error) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      backend.writable = false;
      log.error(`Lost the process lease: ${(error as Error).message}`);
      options.onLost?.(error as Error);
    }
  };
  const timer = setInterval(() => void heartbeat(), options.heartbeatMs ?? LEASE_HEARTBEAT_MS);
  timer.unref();

  return {
    holder,
    release: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await catalog
        .query('DELETE process_lease:current WHERE holder = $holder;', { holder })
        .catch((error) => log.warn(`Could not release the lease: ${(error as Error).message}`));
    },
  };
}
