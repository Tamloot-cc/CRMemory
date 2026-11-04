import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import { compileSchema, objects, quote, ref, relations, tables } from './schema.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export class RetryConflict extends Error {}

export class Database {
  constructor(name = `trial_${randomBytes(8).toString('hex')}`) {
    if (!/^trial_[a-z0-9_]+$/.test(name))
      throw new Error('Experiment database names must start trial_');
    this.name = name;
    this.endpoint = `http://127.0.0.1:${process.env.EXPERIMENT_SURREAL_PORT || 18180}`;
    this.requests = 0;
    this.retries = 0;
    this.timings = [];
  }

  async query(query) {
    const started = performance.now();
    this.requests++;
    const response = await fetch(`${this.endpoint}/sql`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from('experiment:local-experiment').toString('base64')}`,
        'surreal-ns': 'retainer_experiment',
        'surreal-db': this.name,
      },
      body: query,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`SurrealDB HTTP ${response.status}: ${text}`);
    const results = JSON.parse(text);
    const failures = results.filter((result) => result.status !== 'OK');
    if (failures.length) {
      // Rollback messages may precede the original failure in an explicit transaction.
      const message = failures.map((failure) => String(failure.result)).join('\n');
      if (
        /EXPERIMENT_RETRY|can be retried|transaction conflict|read or write conflict/i.test(message)
      ) {
        throw new RetryConflict(message);
      }
      throw new Error(message);
    }
    this.timings.push(performance.now() - started);
    return results.map((result) => result.result);
  }

  async initialize() {
    await this.query(
      `DEFINE NAMESPACE IF NOT EXISTS retainer_experiment; DEFINE DATABASE ${this.name};`,
    );
    await this.query(compileSchema());
    await this.query(
      `CREATE control:main CONTENT ${quote({ revision: 0, schemaVersion: 1, metadata: { relations, fields: objects } })};`,
    );
  }

  async snapshot() {
    // All SELECTs share one explicit transaction snapshot. The commit checks its revision.
    const result = await this.query(`BEGIN TRANSACTION;
      SELECT * OMIT id FROM control:main;
      ${tables.map((table) => `SELECT * OMIT id, in, out, subject, source FROM ${table} ORDER BY uid;`).join('\n')}
      COMMIT TRANSACTION;`);
    const data = result.filter(Array.isArray);
    const control = data[0]?.[0];
    if (!control) throw new Error('Missing experiment control record');
    return {
      control,
      tables: Object.fromEntries(tables.map((table, index) => [table, data[index + 1]])),
    };
  }

  async commit(before, after) {
    const deletions = [];
    const nodes = [];
    const edges = [];
    for (const table of tables) {
      const old = new Map(before.tables[table].map((row) => [row.uid, row]));
      const next = new Map(after.tables[table].map((row) => [row.uid, row]));
      const id = (row) =>
        table.startsWith('o_')
          ? ref(row.uid)
          : `type::record(${quote(table)}, ${quote(digest(row.uid))})`;
      for (const row of old.values()) {
        if (!next.has(row.uid)) deletions.push(`DELETE ${id(row)};`);
      }
      for (const row of next.values()) {
        if (JSON.stringify(canonical(old.get(row.uid))) === JSON.stringify(canonical(row)))
          continue;
        if (relations[table] || table === 'event_link') {
          // RELATE is the only path creating graph adjacency, not a plain CREATE.
          edges.push(
            `DELETE ${id(row)}; LET $edge_source = ${ref(row.sourceUid)}; LET $edge_id = ${id(row)}; LET $edge_target = ${ref(row.targetUid)}; RELATE $edge_source->$edge_id->$edge_target CONTENT ${quote(row)};`,
          );
        } else if (table === 'assertion') {
          const { subjectUid, sourceUid } = row;
          nodes.push(
            `UPSERT ${id(row)} CONTENT ${quote(row).slice(0, -1)}, subject: ${ref(subjectUid)}${sourceUid ? `, source: ${ref(sourceUid)}` : ''} };`,
          );
        } else {
          nodes.push(`UPSERT ${id(row)} CONTENT ${quote(row)};`);
        }
      }
    }
    // A deliberately coarse CAS serializes this small correctness prototype.
    // It is not a scalable replacement for Retainer's schema/record locks.
    await this.query(`BEGIN TRANSACTION;
      IF (SELECT VALUE revision FROM ONLY control:main) != ${before.control.revision} { THROW 'EXPERIMENT_RETRY'; };
      UPDATE control:main CONTENT ${quote({ ...after.control, revision: before.control.revision + 1 })};
      ${deletions.join('\n')}
      ${nodes.join('\n')}
      ${edges.join('\n')}
      COMMIT TRANSACTION;`);
  }

  async mutate(operation, { beforeCommit } = {}) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const before = await this.snapshot();
        const after = structuredClone(before);
        const value = operation(after);
        if (attempt === 0) await beforeCommit?.();
        await this.commit(before, after);
        return value;
      } catch (error) {
        if (!(error instanceof RetryConflict)) throw error;
        this.retries++;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, (attempt + 1) * 3)));
      }
    }
    throw new Error('Experiment retry budget exhausted');
  }

  async drop() {
    await this.query(`REMOVE DATABASE ${this.name};`);
  }
}

// Real PostgreSQL read reference, populated from the accepted projection.
// This is deliberately NOT an independent implementation of the write rules.
export class PostgresReference {
  constructor() {
    this.sql = postgres(
      `postgres://experiment:local-experiment@127.0.0.1:${process.env.EXPERIMENT_PG_PORT || 18181}/experiment`,
      { max: 4, onnotice: () => {} },
    );
    this.schema = `trial_${randomBytes(8).toString('hex')}`;
  }
  async load(snapshot) {
    const sql = this.sql;
    await sql`CREATE SCHEMA ${sql(this.schema)}`;
    await sql`CREATE TABLE ${sql(this.schema)}.records (uid text PRIMARY KEY, kind text NOT NULL, data jsonb NOT NULL)`;
    await sql`CREATE TABLE ${sql(this.schema)}.edges (uid text PRIMARY KEY, field text NOT NULL, source text NOT NULL REFERENCES ${sql(this.schema)}.records(uid), target text NOT NULL REFERENCES ${sql(this.schema)}.records(uid), data jsonb NOT NULL)`;
    await sql`CREATE INDEX ON ${sql(this.schema)}.edges(target, field)`;
    await sql`CREATE INDEX ON ${sql(this.schema)}.edges(source, field)`;
    const records = Object.keys(objects).flatMap((kind) =>
      snapshot.tables[`o_${kind}`].map((row) => [row.uid, kind, row]),
    );
    const edges = [...Object.keys(relations), 'event_link'].flatMap((field) =>
      snapshot.tables[field].map((row) => [row.uid, field, row.sourceUid, row.targetUid, row]),
    );
    for (const [table, columns, rows] of [
      ['records', 'uid,kind,data', records],
      ['edges', 'uid,field,source,target,data', edges],
    ]) {
      if (!rows.length) continue;
      const values = rows
        .map(
          (row, index) =>
            `(${row.map((_, column) => `$${index * row.length + column + 1}${column === row.length - 1 ? '::jsonb' : ''}`).join(',')})`,
        )
        .join(',');
      await sql.unsafe(
        `INSERT INTO "${this.schema}".${table} (${columns}) VALUES ${values}`,
        rows.flat(),
      );
    }
  }
  async query(file, values = []) {
    const query = await readFile(new URL(`queries/${file}.sql`, import.meta.url), 'utf8');
    // schema is generated, never caller supplied. Values remain bound parameters.
    return this.sql.unsafe(query.replaceAll('__SCHEMA__', `"${this.schema}"`), values);
  }
  async close() {
    try {
      await this.sql`DROP SCHEMA ${this.sql(this.schema)} CASCADE`;
    } finally {
      await this.sql.end();
    }
  }
}

export async function writeReport(name, value) {
  await mkdir(new URL('.results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL(`.results/${name}.json`, import.meta.url),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
