import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, sql } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
  console.log('Migrations applied.');
}
