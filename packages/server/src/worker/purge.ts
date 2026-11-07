import type { Sql } from '../db/client.js';
import { log } from '../log.js';
import { purgeDeletedWorkspaces } from '../workspaces/deletion.js';

/**
 * The scheduled run that removes deleted workspaces for good (accounts spec
 * 4.5). On AWS, EventBridge invokes the control function with this event;
 * a container in accounts mode runs it on a timer instead.
 */
export const PURGE_TASK = 'purge-deleted-workspaces';

export const isPurgeEvent = (event: unknown): boolean =>
  typeof event === 'object' && event !== null && (event as { task?: unknown }).task === PURGE_TASK;

/**
 * Runs the purge every `intervalMinutes`, first a minute after starting.
 * `sql` connects as the control role.
 */
export function startPurger(options: { sql: Sql; intervalMinutes?: number }): {
  stop: () => Promise<void>;
} {
  const intervalMs = (options.intervalMinutes ?? 60) * 60_000;
  let running: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = purgeDeletedWorkspaces(options.sql)
        .catch((error: unknown) => {
          log.error(`Removing deleted workspaces failed: ${(error as Error).message}`);
        })
        .then(() => schedule(intervalMs));
    }, delay);
  };
  schedule(60_000);
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
