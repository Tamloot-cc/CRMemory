import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, inject, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { databaseUrl } from '../helpers/db.js';

// An install that has workspaces when it upgrades: they all move into one
// Default organization with no owner (accounts spec 4.2).

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const LAST_BEFORE_ACCOUNTS = '0023_comments_security';

/** The migrations folder as it was before accounts. */
async function migrationsBeforeAccounts(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'retainer-migrations-'));
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === LAST_BEFORE_ACCOUNTS);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

it('moves existing workspaces into one Default organization with no owner', async () => {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `retainer_test_upgrade_${Math.random().toString(16).slice(2, 10)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: false });
  await admin.unsafe(`create database "${name}"`);
  const folder = await migrationsBeforeAccounts();
  const url = databaseUrl(adminUrl, name);
  const sql = postgres(url, { max: 1, onnotice: false });
  try {
    for (const extension of ['pg_trgm', 'btree_gin', 'unaccent']) {
      await sql.unsafe(`create extension if not exists ${extension}`);
    }
    await migrate(drizzle(sql), { migrationsFolder: folder });
    await sql`insert into workspaces (slug, name) values ('acme', 'Acme'), ('beta', 'Beta')`;

    await runMigrations(url);

    const organizations = await sql`select id, name from organizations`;
    expect(organizations).toEqual([{ id: expect.any(String), name: 'Default' }]);
    const workspaces = await sql`select slug, organization_id from workspaces order by slug`;
    expect(workspaces).toEqual([
      { slug: 'acme', organization_id: organizations[0]?.id },
      { slug: 'beta', organization_id: organizations[0]?.id },
    ]);
    expect(await sql`select 1 from organization_members`).toHaveLength(0);
  } finally {
    await sql.end();
    await rm(folder, { recursive: true, force: true });
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
});

it('creates no organization for a database without workspaces', async () => {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `retainer_test_upgrade_${Math.random().toString(16).slice(2, 10)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: false });
  await admin.unsafe(`create database "${name}"`);
  const url = databaseUrl(adminUrl, name);
  try {
    await runMigrations(url);
    const sql = postgres(url, { max: 1, onnotice: false });
    try {
      expect(await sql`select 1 from organizations`).toHaveLength(0);
    } finally {
      await sql.end();
    }
  } finally {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
});
