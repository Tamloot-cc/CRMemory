/**
 * Background workers: the scheduled consolidator. Retainer never calls a
 * language model, so there is no ingest worker.
 * Not implemented yet; see ARCHITECTURE.md section 4 and the build order.
 */
export async function startWorker(): Promise<{ stop: () => Promise<void> }> {
  console.log('Worker started (no jobs registered yet).');
  return { stop: async () => {} };
}
