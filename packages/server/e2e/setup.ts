import { generateSigningKeyEntry } from '../src/db/access.js';
import { serverHealthy } from '../src/db/surreal.js';

/**
 * Browser tests run the server in process against real SurrealDB; each test
 * gets its own namespace (fixtures.ts). One signing key is generated per run.
 */
export default async function setup() {
  const url = process.env.RETAINER_SURREAL_URL;
  if (!url) throw new Error('RETAINER_SURREAL_URL is required for browser tests');
  if (!(await serverHealthy(url.replace(/\/+$/, '')))) {
    throw new Error(`SurrealDB is not reachable at ${url}`);
  }
  process.env.RETAINER_BROWSER_SIGNING_KEY ??= generateSigningKeyEntry('browser');
}
