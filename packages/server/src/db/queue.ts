import { AppError } from '../errors.js';
import { log } from '../log.js';

/**
 * The process-local workspace write queue (spec section 6, step 1). One
 * writer per workspace at a time; other workspaces and reads proceed. A
 * caller that waits longer than the limit gets a retryable `workspace_busy`.
 * Only database work happens while the queue is held.
 */

export const DEFAULT_QUEUE_LIMIT_MS = 10_000;

export type QueueStats = {
  operations: number;
  waitMs: number[];
  holdMs: number[];
  conflicts: number;
  busy: number;
};

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class WriteQueues {
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, Waiter[]>();
  readonly stats: QueueStats = { operations: 0, waitMs: [], holdMs: [], conflicts: 0, busy: 0 };
  limitMs = DEFAULT_QUEUE_LIMIT_MS;

  /** Runs `fn` holding the workspace's queue; records wait and hold times. */
  async run<T>(workspaceId: string, kind: string, fn: () => Promise<T>): Promise<T> {
    const queued = performance.now();
    await this.acquire(workspaceId);
    const started = performance.now();
    try {
      return await fn();
    } finally {
      const ended = performance.now();
      this.release(workspaceId);
      this.record(started - queued, ended - started);
      log.debug(
        `write ${kind} on ${workspaceId}: waited ${(started - queued).toFixed(1)} ms, held ${(
          ended - started
        ).toFixed(1)} ms`,
      );
    }
  }

  /** True while some operation holds the workspace's queue. */
  isHeld(workspaceId: string): boolean {
    return this.held.has(workspaceId);
  }

  private record(wait: number, hold: number): void {
    this.stats.operations++;
    // Bounded, so a long-running process does not grow without limit.
    if (this.stats.waitMs.length >= 10_000) this.stats.waitMs.shift();
    if (this.stats.holdMs.length >= 10_000) this.stats.holdMs.shift();
    this.stats.waitMs.push(wait);
    this.stats.holdMs.push(hold);
  }

  private acquire(workspaceId: string): Promise<void> {
    if (!this.held.has(workspaceId)) {
      this.held.add(workspaceId);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const list = this.waiting.get(workspaceId) ?? [];
          const index = list.indexOf(waiter);
          if (index >= 0) list.splice(index, 1);
          this.stats.busy++;
          reject(workspaceBusy(this.limitMs));
        }, this.limitMs),
      };
      const list = this.waiting.get(workspaceId) ?? [];
      list.push(waiter);
      this.waiting.set(workspaceId, list);
    });
  }

  private release(workspaceId: string): void {
    const next = this.waiting.get(workspaceId)?.shift();
    if (next) {
      clearTimeout(next.timer);
      // The queue stays held: ownership passes to the next waiter.
      next.resolve();
      return;
    }
    this.waiting.delete(workspaceId);
    this.held.delete(workspaceId);
  }
}

export function workspaceBusy(limitMs: number): AppError {
  return new AppError(
    503,
    'workspace_busy',
    `other writes to this workspace held it for more than ${limitMs / 1000} s; retry shortly`,
    { retryable: true, retryAfterMs: 1000 },
  );
}

export function schemaBusy(): AppError {
  return new AppError(
    503,
    'schema_busy',
    'a schema change is being applied to this workspace; retry shortly',
    { retryable: true, retryAfterMs: 1000 },
  );
}

/** p50 and p95 of a list of milliseconds. */
export function percentiles(values: readonly number[]): { p50: number; p95: number } {
  if (values.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number).toFixed(2);
  return { p50: at(0.5), p95: at(0.95) };
}
