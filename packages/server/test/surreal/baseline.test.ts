import type { Actor } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { percentiles } from '../../src/db/queue.js';
import { logEventFor } from '../../src/memory/service.js';
import { type Caller, createRecord } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * Phase 1 baseline (spec section 10): write latency and queue wait for a
 * 200-event ingestion burst into one workspace. It records numbers; it
 * asserts only correctness, never a timing.
 */
const backend = useTestBackend();
const AGENT: Actor = { type: 'agent', id: 'inbox' };
const BURST = 200;

describe('baseline: 200-event ingestion burst', () => {
  it('logs every event once and reports latency and queue wait', async () => {
    const { id: workspaceId } = await createWorkspace(backend, {
      name: 'Burst',
      template: 'sales',
    });
    const caller: Caller = { workspaceId, actor: AGENT, scopes: ['read', 'write'] };
    const people = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createRecord(backend, caller, 'person', { emails: `burst${i}@acme.test` }),
      ),
    );
    const before = { ...backend.queues.stats, waitMs: backend.queues.stats.waitMs.length };
    const latencies: number[] = [];
    const started = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: BURST }, async (_, i) => {
        const t0 = performance.now();
        const result = await logEventFor(backend, caller, {
          type: 'call',
          channel: 'zoom',
          externalId: `burst-${i}`,
          occurredAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
          title: `Call ${i}`,
          fields: {},
          participants: [
            { handle: `burst${i % 10}@acme.test` },
            { handle: `burst${(i + 1) % 10}@acme.test` },
          ],
          about: [],
        });
        latencies.push(performance.now() - t0);
        return result;
      }),
    );
    const wall = performance.now() - started;
    const failed = results.filter((r) => r.status === 'rejected');
    const stats = backend.queues.stats;
    const waits = stats.waitMs.slice(before.waitMs);
    const holds = stats.holdMs.slice(before.waitMs);
    const summary = {
      events: BURST,
      wallMs: Math.round(wall),
      latencyMs: percentiles(latencies),
      queueWaitMs: percentiles(waits),
      holdMs: percentiles(holds),
      conflicts: stats.conflicts - before.conflicts,
      busy: stats.busy - before.busy,
      failed: failed.map((f) => String((f as PromiseRejectedResult).reason?.code ?? f)),
    };
    console.log(`BASELINE ${JSON.stringify(summary)}`);
    expect(people).toHaveLength(10);
    expect(failed).toEqual([]);
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(BURST);
  }, 120_000);
});
