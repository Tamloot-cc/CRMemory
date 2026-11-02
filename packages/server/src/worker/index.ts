/**
 * Background workers: ingest, consolidate, embed, schema-index builder.
 * Not implemented yet; see ARCHITECTURE.md section 4 and the build order.
 */
export async function startWorker(): Promise<{ stop: () => Promise<void> }> {
  console.log('Worker started (no jobs registered yet).');
  return { stop: async () => {} };
}
