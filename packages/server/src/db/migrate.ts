import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Extensions search needs (5.1): trigram and combined GIN indexes, and
 * accent folding.
 */
const EXTENSIONS = ['pg_trgm', 'btree_gin', 'unaccent'] as const;

/**
 * Applies pending migrations as the migration role (the table owner). The
 * extensions are trusted, so a database owner without superuser can create
 * them.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    for (const extension of EXTENSIONS) {
      await sql.unsafe(`create extension if not exists ${extension}`);
    }
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
