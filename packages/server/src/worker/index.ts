import type { Backend } from '../db/backend.js';
import { mutate } from '../db/protocol.js';
import { log as serverLog } from '../log.js';
import { listWorkspaces } from '../workspaces/workspaces.js';
import { consolidateWorkspace } from './consolidate.js';

/**
 * Background work in the one server process (spec section 9): the scheduled
 * consolidator (4.2) and receipt cleanup. Retainer never calls a language
 * model, so there is no ingest worker. Each workspace's work is an
 * operation under the write protocol, so it queues behind that workspace's
 * writes and never interleaves with them.
 */

export type WorkerOptions = {
  backend: Backend;
  /** How often each workspace is consolidated. */
  intervalMinutes: number;
  /** How often to look for due work. */
  tickMs?: number;
  /** Where progress and failures go; the server log by default. */
  log?: Pick<typeof serverLog, 'info' | 'error'>;
};

export type Worker = {
  /** Runs one tick now; resolves when every workspace was tried. */
  tick: () => Promise<void>;
  stop: () => Promise<void>;
};

export type ConsolidateDueOptions = Pick<WorkerOptions, 'backend' | 'intervalMinutes' | 'log'> & {
  /** Checked before each workspace; returning true ends the pass early. */
  stopped?: () => boolean;
};

/** What one pass did: workspaces consolidated, and those that failed. */
export type ConsolidatePass = { consolidated: number; failed: number };

/** Receipts expire after 24 hours (section 7); at most this many go per workspace and tick. */
const RECEIPT_CLEANUP_BATCH = 1000;

/** Deletes expired receipts of one workspace. Returns how many. */
export async function cleanupReceipts(backend: Backend, workspaceId: string): Promise<number> {
  const { result } = await mutate(backend, workspaceId, {
    kind: 'receipt_cleanup',
    noReceipt: true,
    plan: async (op) => {
      const expired = await op.rows<{ id: unknown }>(
        `SELECT id FROM operations WHERE expires_at < $now LIMIT ${RECEIPT_CLEANUP_BATCH};`,
        { now: op.now },
      );
      if (expired.length > 0) {
        op.batch.write(
          `DELETE operations WHERE expires_at < ${op.batch.v(op.now)} LIMIT ${RECEIPT_CLEANUP_BATCH} RETURN BEFORE`,
          { min: 0 },
          'operations',
        );
      }
      return expired.length;
    },
  });
  return result;
}

/**
 * One pass over every active workspace: those not consolidated within the
 * interval are consolidated, and expired receipts are removed.
 */
export async function consolidateDue(options: ConsolidateDueOptions): Promise<ConsolidatePass> {
  const { backend } = options;
  const log = options.log ?? serverLog;
  const pass: ConsolidatePass = { consolidated: 0, failed: 0 };
  for (const workspace of await listWorkspaces(backend)) {
    if (options.stopped?.()) break;
    try {
      const stats = await consolidateWorkspace(backend, workspace.id, {
        minIntervalMs: options.intervalMinutes * 60_000,
      });
      if (stats) pass.consolidated++;
      if (stats && (stats.supersededFacts > 0 || stats.mergeSuggestions > 0)) {
        log.info(
          `Consolidated workspace ${workspace.id}: ${stats.supersededFacts} duplicate facts ` +
            `superseded, ${stats.mergeSuggestions} merges suggested.`,
        );
      }
      await cleanupReceipts(backend, workspace.id);
    } catch (error) {
      pass.failed++;
      log.error(`Background work for workspace ${workspace.id} failed: ${(error as Error).message}`);
    }
  }
  return pass;
}

export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const { backend, intervalMinutes } = options;
  const log = options.log ?? serverLog;
  const tickMs = options.tickMs ?? Math.min(60_000, intervalMinutes * 60_000);
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  async function runTick(): Promise<void> {
    if (!backend.writable) return;
    await consolidateDue({ backend, intervalMinutes, log, stopped: () => stopped });
  }

  const tick = () => {
    running = running.then(runTick).catch((error: unknown) => {
      log.error(`Worker tick failed: ${(error as Error).message}`);
    });
    return running;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick().then(schedule), tickMs);
  };

  log.info(`Worker started: consolidating each workspace every ${intervalMinutes} minutes.`);
  void tick().then(schedule);

  return {
    tick,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
