import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { loadConfig } from './config.js';
import { createSql, RUNTIME_ROLE } from './db/client.js';
import { log, setLogLevel } from './log.js';
import { bootstrap, firstBootBanner } from './operator/bootstrap.js';
import { rebuildSearchText } from './records/rebuild-search.js';
import { startWorker } from './worker/index.js';
import { upgradeWorkspaces } from './workspaces/upgrade.js';

const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

// Boot tasks run as the migration role: only it can create workspaces and keys,
// and it rebuilds stale search text and upgrades workspaces across the database.
const owner = createSql(config.DATABASE_URL, { max: 1 });
try {
  const firstBoot = await bootstrap(owner);
  // Printed whatever LOG_LEVEL is: it holds the only copy of the first key.
  if (firstBoot) console.log(firstBootBanner(firstBoot));
  // A migration that changes how search text is built leaves it null (5.1).
  const rebuilt = await rebuildSearchText(owner);
  if (rebuilt > 0) log.info(`Rebuilt the search text of ${rebuilt} records.`);
  // A release that adds built-in objects, fields or protection brings older
  // workspaces up to it (3); it logs what it did.
  await upgradeWorkspaces(owner);
} finally {
  await owner.end({ timeout: 5 });
}

// Everything else runs as the runtime role, so row-level security applies.
const sql = createSql(config.DATABASE_URL, {
  role: RUNTIME_ROLE,
  max: config.RETAINER_DB_POOL_MAX,
});
const stops: Array<() => Promise<void>> = [];

if (config.RETAINER_ROLE === 'api' || config.RETAINER_ROLE === 'all') {
  const app = createApp({
    sql,
    webDir: config.RETAINER_WEB_DIR,
    publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
  });
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info(`Retainer API listening on http://localhost:${info.port}`);
  });
  stops.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
}

if (config.RETAINER_ROLE === 'worker' || config.RETAINER_ROLE === 'all') {
  const worker = await startWorker({
    sql,
    intervalMinutes: config.RETAINER_CONSOLIDATE_INTERVAL_MINUTES,
  });
  stops.push(worker.stop);
}

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down.`);
  await Promise.allSettled(stops.map((stop) => stop()));
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
