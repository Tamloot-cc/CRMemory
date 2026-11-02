import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { startWorker } from './worker/index.js';

const config = loadConfig();
const { sql } = createDb(config.DATABASE_URL);
const stops: Array<() => Promise<void>> = [];

if (config.CRMEMORY_ROLE === 'api' || config.CRMEMORY_ROLE === 'all') {
  const app = createApp({ sql });
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`CRMemory API listening on http://localhost:${info.port}`);
  });
  stops.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
}

if (config.CRMEMORY_ROLE === 'worker' || config.CRMEMORY_ROLE === 'all') {
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
