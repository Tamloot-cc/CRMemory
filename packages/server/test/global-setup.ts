import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/db/migrate.js';
import { databaseUrl } from './helpers/db.js';

/**
 * Migrates once into a template database for this run. Every test file
 * clones it (see helpers/db.ts), so migrations never run per test.
 */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests need Postgres; see CLAUDE.md for the Compose command.',
    );
  }

  // One template per run, so two runs on the same server do not collide.
  const template = `retainer_test_template_${randomBytes(4).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: false });
  await admin.unsafe(`create database "${template}"`);
  try {
    await runMigrations(databaseUrl(adminUrl, template));
  } catch (error) {
    await admin.unsafe(`drop database if exists "${template}" with (force)`);
    await admin.end();
    throw error;
  }

  project.provide('adminDatabaseUrl', adminUrl);
  project.provide('templateDatabase', template);

  return async () => {
    await admin.unsafe(`drop database if exists "${template}" with (force)`);
    await admin.end();
  };
}
