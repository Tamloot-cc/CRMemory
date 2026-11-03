import type { Sql } from '../db/client.js';
import { log as serverLog } from '../log.js';
import { consolidateWorkspace } from './consolidate.js';

/**
 * Background workers: the scheduled consolidator (4.2). Retainer never
 * calls a language model, so there is no ingest worker.
 *
 * The queue is Postgres itself: every tick, a worker asks
 * `retainer_workspaces_due` for workspaces whose last run is older than the
 * interval, and runs each under a per-workspace advisory try-lock. Several
 * workers can run side by side; a workspace another worker holds is skipped.
 */

export type WorkerOptions = {
  /** A pool connected as the runtime role. */
  sql: Sql;
  /** How often each workspace is consolidated. */
  intervalMinutes: number;
  /** How often to look for due workspaces. */
  tickMs?: number;
  /** Where progress and failures go; the server log by default. */
  log?: Pick<typeof serverLog, 'info' | 'error'>;
};

export type Worker = {
  /** Runs one tick now; resolves when every due workspace was tried. */
  tick: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const { sql, intervalMinutes } = options;
  const log = options.log ?? serverLog;
  const tickMs = options.tickMs ?? Math.min(60_000, intervalMinutes * 60_000);
  const interval = `${intervalMinutes} minutes`;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  async function runTick(): Promise<void> {
    const due = await sql<{ id: string }[]>`
      select id from retainer_workspaces_due(${interval}::interval) as id`;
    for (const { id } of due) {
      if (stopped) return;
      try {
        const stats = await consolidateWorkspace(sql, id, { minInterval: interval });
        if (stats && (stats.supersededFacts > 0 || stats.mergeSuggestions > 0)) {
          log.info(
            `Consolidated workspace ${id}: ${stats.supersededFacts} duplicate facts superseded, ` +
              `${stats.mergeSuggestions} merges suggested.`,
          );
        }
      } catch (error) {
        log.error(`Consolidating workspace ${id} failed: ${(error as Error).message}`);
      }
    }
  }

  const tick = () => {
    running = running.then(runTick).catch((error: unknown) => {
      log.error(`Consolidator tick failed: ${(error as Error).message}`);
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
