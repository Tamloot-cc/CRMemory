import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { loadConfig } from './config.js';
import { createSql, RUNTIME_ROLE } from './db/client.js';
import { bootstrap, firstBootBanner } from './operator/bootstrap.js';
import { startWorker } from './worker/index.js';

const config = loadConfig();

// First boot runs as the migration role: only it can create workspaces and keys.
const owner = createSql(config.DATABASE_URL, { max: 1 });
try {
  const firstBoot = await bootstrap(owner);
  if (firstBoot) console.log(firstBootBanner(firstBoot));
} finally {
  await owner.end({ timeout: 5 });
}

// Everything else runs as the runtime role, so row-level security applies.
const sql = createSql(config.DATABASE_URL, { role: RUNTIME_ROLE });
const stops: Array<() => Promise<void>> = [];

if (config.RETAINER_ROLE === 'api' || config.RETAINER_ROLE === 'all') {
  const app = createApp({
    sql,
    webDir: config.RETAINER_WEB_DIR,
    publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
  });
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`Retainer API listening on http://localhost:${info.port}`);
  });
  stops.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
}

if (config.RETAINER_ROLE === 'worker' || config.RETAINER_ROLE === 'all') {
  const worker = await startWorker();
  stops.push(worker.stop);
}

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down.`);
  await Promise.allSettled(stops.map((stop) => stop()));
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
