import type { TestProject } from 'vitest/node';
import { generateSigningKeyEntry } from '../src/db/access.js';
import { serverHealthy, serverVersion } from '../src/db/surreal.js';

/**
 * Integration tests need a SurrealDB server (CLAUDE.md has the Compose
 * command). Each test file gets a fresh namespace of its own (helpers/backend.ts);
 * this run's signing keys are generated once and shared.
 */
export default async function setup(project: TestProject) {
  const url = (process.env.RETAINER_SURREAL_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
  if (!(await serverHealthy(url))) {
    throw new Error(
      `SurrealDB is not reachable at ${url}. Start it with: docker compose -f docker/compose.yml up -d surrealdb (set RETAINER_SURREAL_URL and RETAINER_SURREAL_PASS if needed)`,
    );
  }
  project.provide('surrealUrl', url);
  project.provide('surrealVersion', await serverVersion(url));
  project.provide('signingKeys', [generateSigningKeyEntry('t1'), generateSigningKeyEntry('t2')]);
}
