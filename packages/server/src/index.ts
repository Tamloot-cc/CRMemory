import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { loadConfig } from './config.js';
import { backendFromConfig } from './db/connect.js';
import { acquireLease } from './db/lease.js';
import { ensureCatalog } from './db/provision.js';
import { log, setLogLevel } from './log.js';
import { bootstrap, firstBootBanner } from './operator/bootstrap.js';
import { startWorker } from './worker/index.js';
import { installUpgrader, upgradeWorkspaces } from './workspaces/upgrade.js';
import { resumeProvisioning } from './workspaces/workspaces.js';

/**
 * One Retainer process (spec section 9): the API, MCP and background work,
 * on SurrealDB. Boot order: the catalog, the process lease (a second
 * process fails fast), interrupted provisioning, the first-boot workspace,
 * workspace upgrades (fixed tables, signing keys, built-in definitions),
 * then serving.
 */
const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

const backend = backendFromConfig(config);
installUpgrader(backend);
await ensureCatalog(backend);

const lease = await acquireLease(backend, {
  onLost: (error) => {
    log.error(`Lost the process lease: ${error.message}. Stopping.`);
    void shutdown('lease lost', 1);
  },
});

const resumed = await resumeProvisioning(backend);
if (resumed > 0) log.info(`Finished provisioning ${resumed} interrupted workspaces.`);
const firstBoot = await bootstrap(backend);
// Printed whatever LOG_LEVEL is: it holds the only copy of the first key.
if (firstBoot) console.log(firstBootBanner(firstBoot));
// A release that adds built-in objects, fields, protection, fixed tables or
// signing keys brings older workspaces up to it; it logs what it did.
await upgradeWorkspaces(backend);

const stops: Array<() => Promise<void>> = [];
const app = createApp({
  backend,
  webDir: config.RETAINER_WEB_DIR,
  publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
});
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log.info(`Retainer listening on http://localhost:${info.port}`);
});
stops.push(
  () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);
const worker = await startWorker({
  backend,
  intervalMinutes: config.RETAINER_CONSOLIDATE_INTERVAL_MINUTES,
});
stops.push(worker.stop);

let stopping = false;
async function shutdown(reason: string, code = 0) {
  if (stopping) return;
  stopping = true;
  log.info(`${reason}: shutting down.`);
  backend.writable = false;
  await Promise.allSettled(stops.map((stop) => stop()));
  await lease.release().catch(() => undefined);
  process.exit(code);
}

process.on('SIGINT', () => void shutdown('SIGINT received'));
process.on('SIGTERM', () => void shutdown('SIGTERM received'));
