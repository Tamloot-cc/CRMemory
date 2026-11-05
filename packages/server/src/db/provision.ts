import { AppError } from '../errors.js';
import { log } from '../log.js';
import { acceptedKeys, defineAccess } from './access.js';
import type { Backend, Db } from './backend.js';
import { RecordId } from './cbor.js';
import {
  ACTOR_TYPE,
  CATALOG_INDEXES,
  CATALOG_REVISION,
  CATALOG_TABLES,
  type IndexDefinition,
  indexStatement,
  SEARCH_ANALYZERS,
  type TableDefinition,
  tableStatements,
  WORKSPACE_INDEXES,
  WORKSPACE_REVISION,
  WORKSPACE_TABLES,
} from './definitions.js';
import { accessName, CATALOG_DATABASE, workspaceDatabase } from './names.js';
import type { WorkspaceState } from './protocol.js';
import { ident, SurrealError } from './surreal.js';

/**
 * Provisioning and the fixed-table upgrade runner (spec sections 4 and 7).
 * Every step compares actual and desired definitions, so a step interrupted
 * by a restart is simply run again.
 */

// ---------------------------------------------------------------------------
// Indexes: defined alone, then verified (section 7)
// ---------------------------------------------------------------------------

type IndexSignature = { fields: string; kind: string };

function signatureOf(definition: string): IndexSignature {
  const text = definition.replace(/`/g, '').replace(/\s+/g, ' ');
  const fields = /FIELDS (.+?)(?: UNIQUE| FULLTEXT| HNSW| COUNT|;|$)/i.exec(text)?.[1] ?? '';
  const kind = / UNIQUE/i.test(text)
    ? 'unique'
    : (/FULLTEXT ANALYZER (\w+)/i.exec(text)?.[1] ?? 'plain');
  return {
    fields: fields
      .split(',')
      .map((f) => f.trim())
      .join(','),
    kind: kind.toLowerCase(),
  };
}

const sameSignature = (a: IndexSignature, b: IndexSignature) =>
  a.fields === b.fields && a.kind === b.kind;

/** A row that satisfies a table's required fields, for duplicate probes. */
function probeContent(table: TableDefinition, index: IndexDefinition): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [name, type] of table.fields) {
    if (name.includes('.')) continue;
    const required = !type.startsWith('option<');
    if (!required && !index.fields.includes(name)) continue;
    const base = type.replace(/^option<(.*?)( \| null)?>$/, '$1');
    content[name] =
      base === ACTOR_TYPE
        ? { type: 'system', id: 'probe' }
        : base === 'int' || base === 'number'
          ? 0
          : base === 'bool'
            ? false
            : base === 'datetime'
              ? new Date(0)
              : base.startsWith('array')
                ? []
                : base === 'any'
                  ? null
                  : '__retainer_probe__';
  }
  return content;
}

async function waitReady(db: Db, index: IndexDefinition): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const [info] = (await db.query(
      `INFO FOR INDEX ${ident(index.name)} ON ${ident(index.table)};`,
    )) as [{ building?: { status?: string; error?: string } }];
    const status = info?.building?.status;
    if (status === 'ready') return;
    if (status === 'error' || info?.building?.error) {
      throw new Error(`index ${index.name} failed to build: ${info?.building?.error ?? status}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`index ${index.name} did not become ready`);
}

/**
 * A unique index must refuse a duplicate: two probe rows inside a cancelled
 * transaction. Relation tables need endpoints, created in the same
 * transaction.
 */
async function probeUnique(
  db: Db,
  index: IndexDefinition,
  tables: ReadonlyMap<string, TableDefinition>,
  relation?: { from: string; to: string },
): Promise<void> {
  const table = tables.get(index.table);
  const vars: Record<string, unknown> = {};
  let text: string;
  if (relation) {
    const a = new RecordId(relation.from, '__retainer_probe_a__');
    const b = new RecordId(relation.to, '__retainer_probe_b__');
    // An endpoint satisfies its own table's required fields.
    const endpointContent = (name: string) => {
      const definition = tables.get(name);
      return definition
        ? probeContent(definition, { name: '', table: name, fields: [] })
        : {
            created_at: new Date(0),
            updated_at: new Date(0),
            created_by: { type: 'system', id: 'probe' },
            updated_by: { type: 'system', id: 'probe' },
          };
    };
    Object.assign(vars, {
      a,
      b,
      ca: endpointContent(relation.from),
      cb: endpointContent(relation.to),
      c: table ? probeContent(table, index) : {},
    });
    // The duplicate shares only the indexed endpoint: a second target for
    // an index on `in`, a second source for one on `out`.
    const onlyIn = index.fields.length === 1 && index.fields[0] === 'in';
    const onlyOut = index.fields.length === 1 && index.fields[0] === 'out';
    vars.a2 = new RecordId(relation.from, '__retainer_probe_a2__');
    vars.b2 = new RecordId(relation.to, '__retainer_probe_b2__');
    text = [
      'BEGIN;',
      'CREATE $a CONTENT $ca;',
      'CREATE $b CONTENT $cb;',
      onlyOut ? 'CREATE $a2 CONTENT $ca;' : '',
      onlyIn ? 'CREATE $b2 CONTENT $cb;' : '',
      `RELATE $a->${ident(index.table)}->$b CONTENT $c;`,
      `RELATE ${onlyOut ? '$a2' : '$a'}->${ident(index.table)}->${onlyIn ? '$b2' : '$b'} CONTENT $c;`,
      'CANCEL;',
    ].join('\n');
  } else {
    if (!table) throw new Error(`no table definition for ${index.table}`);
    vars.c = probeContent(table, index);
    vars.a = new RecordId(index.table, '__retainer_probe_a__');
    vars.b = new RecordId(index.table, '__retainer_probe_b__');
    text = 'BEGIN;\nCREATE $a CONTENT $c;\nCREATE $b CONTENT $c;\nCANCEL;';
  }
  const results = await db.raw(text, vars);
  const refused = results.some(
    (r) => r.status === 'ERR' && String(r.result).includes(`index \`${index.name}\``),
  );
  if (!refused) {
    const errors = results.filter((r) => r.status === 'ERR').map((r) => r.result);
    throw new Error(
      `unique index ${index.name} accepted a duplicate${errors.length ? `: ${errors.join('; ')}` : ''}`,
    );
  }
}

/**
 * Brings indexes to their definitions: each one alone, outside any
 * transaction, then checked ready and, for a unique index, refusing a
 * duplicate. Returns the names it (re)defined.
 */
export async function applyIndexes(
  db: Db,
  indexes: readonly IndexDefinition[],
  tables: ReadonlyMap<string, TableDefinition>,
  relations: ReadonlyMap<string, { from: string; to: string }> = new Map(),
): Promise<string[]> {
  const infos = new Map<string, Record<string, string>>();
  const defined: string[] = [];
  for (const index of indexes) {
    let existing = infos.get(index.table);
    if (!existing) {
      const [info] = (await db.query(`INFO FOR TABLE ${ident(index.table)};`)) as [
        { indexes?: Record<string, string> },
      ];
      existing = info?.indexes ?? {};
      infos.set(index.table, existing);
    }
    const actual = existing[index.name];
    const desired = indexStatement(index);
    if (!actual || !sameSignature(signatureOf(actual), signatureOf(desired))) {
      await db.query(desired);
      defined.push(index.name);
    }
    await waitReady(db, index);
    if (index.unique) {
      await probeUnique(db, index, tables, relations.get(index.table));
    }
  }
  return defined;
}

// ---------------------------------------------------------------------------
// Access methods
// ---------------------------------------------------------------------------

/**
 * Defines an access method for every accepted signing key the database
 * lacks, and removes those of keys no longer accepted. Returns the keys the
 * database accepts afterwards.
 */
async function applyAccess(backend: Backend, db: Db, known: readonly string[]): Promise<string[]> {
  const accepted = acceptedKeys(backend.keys);
  const [info] = (await db.query('INFO FOR DB;')) as [{ accesses?: Record<string, string> }];
  const existing = Object.keys(info?.accesses ?? {});
  const statements: string[] = [];
  for (const key of accepted) {
    if (!existing.includes(accessName(key.id)) || !known.includes(key.id)) {
      statements.push(defineAccess(key));
    }
  }
  for (const name of existing) {
    if (!name.startsWith('backend_')) continue;
    if (!accepted.some((k) => accessName(k.id) === name)) {
      statements.push(`REMOVE ACCESS IF EXISTS ${ident(name)} ON DATABASE;`);
    }
  }
  if (statements.length > 0) await db.query(statements.join('\n'));
  return accepted.map((k) => k.id);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const tableMap = (tables: readonly TableDefinition[]) => new Map(tables.map((t) => [t.name, t]));

/** Creates or upgrades the namespace and catalog database. Idempotent. */
export async function ensureCatalog(backend: Backend): Promise<void> {
  const ns = backend.config.namespace;
  if (backend.config.admin.level === 'root') {
    await backend
      .adminNamespace()
      .query(`DEFINE NAMESPACE IF NOT EXISTS ${ident(ns)}; DEFINE DATABASE IF NOT EXISTS ${ident(CATALOG_DATABASE)};`);
  } else {
    await backend.adminNamespace().query(`DEFINE DATABASE IF NOT EXISTS ${ident(CATALOG_DATABASE)};`);
  }
  const db = backend.adminCatalog();
  const [state] = await db.rows<{ revision: number }>(
    'SELECT revision FROM ONLY catalog_state:current;',
  ).catch(() => [] as { revision: number }[]);
  if (!state || state.revision < CATALOG_REVISION) {
    await db.query(
      ['BEGIN;', ...CATALOG_TABLES.flatMap(tableStatements), 'COMMIT;'].join('\n'),
    );
  }
  await applyIndexes(db, CATALOG_INDEXES, tableMap(CATALOG_TABLES));
  await applyAccess(backend, db, []);
  if (!state || state.revision < CATALOG_REVISION) {
    await db.query('UPSERT catalog_state:current SET revision = $revision;', {
      revision: CATALOG_REVISION,
    });
  }
}

// ---------------------------------------------------------------------------
// Workspace databases
// ---------------------------------------------------------------------------

/** Applies the fixed tables, analyzers and indexes of a workspace database. */
async function applyFixedTables(db: Db): Promise<void> {
  await db.query(
    ['BEGIN;', ...SEARCH_ANALYZERS, ...WORKSPACE_TABLES.flatMap(tableStatements), 'COMMIT;'].join(
      '\n',
    ),
  );
  await applyIndexes(
    db,
    WORKSPACE_INDEXES,
    tableMap(WORKSPACE_TABLES),
    new Map([['event_attachments', { from: 'jobs', to: 'jobs' }]]),
  );
}

export type CatalogWorkspace = {
  id: string;
  slug: string;
  name: string;
  database: string;
  state: 'provisioning' | 'active';
  access_keys: string[];
  created_at: Date;
  updated_at: Date;
};

export async function catalogWorkspace(
  backend: Backend,
  workspaceId: string,
): Promise<CatalogWorkspace | undefined> {
  const [row] = await backend
    .adminCatalog()
    .rows<CatalogWorkspace & { id: RecordId }>('SELECT * FROM type::record("workspaces", $id);', {
      id: workspaceId,
    });
  return row ? { ...row, id: String(row.id.id) } : undefined;
}

/**
 * Steps 1–2 of workspace creation (section 4): the catalog entry
 * (`provisioning`), then the database with its fixed tables, access methods
 * and state. The base template and `active` follow in `workspaces.ts`.
 * Resumable: every step checks what exists.
 */
export async function provisionDatabase(
  backend: Backend,
  input: { id: string; slug: string; name: string; now: Date; template?: string | null },
): Promise<CatalogWorkspace> {
  const catalog = backend.adminCatalog();
  const database = workspaceDatabase(input.id);
  let row = await catalogWorkspace(backend, input.id);
  if (!row) {
    try {
      await catalog.query(
        'CREATE type::record("workspaces", $id) CONTENT { slug: $slug, name: $name, database: $database, state: "provisioning", access_keys: [], template: $template, created_at: $now, updated_at: $now };',
        {
          id: input.id,
          slug: input.slug,
          name: input.name,
          database,
          now: input.now,
          template: input.template ?? null,
        },
      );
    } catch (error) {
      if (error instanceof SurrealError && error.message.includes('workspaces_slug_uq')) {
        throw new AppError(409, 'slug_taken', `a workspace with slug "${input.slug}" already exists`);
      }
      throw error;
    }
    row = (await catalogWorkspace(backend, input.id)) as CatalogWorkspace;
  }
  await backend.adminNamespace().query(`DEFINE DATABASE IF NOT EXISTS ${ident(database)};`);
  await upgradeFixedTables(backend, input.id, database, input.now);
  await upgradeAccessMethods(backend, input.id, database);
  return (await catalogWorkspace(backend, input.id)) as CatalogWorkspace;
}

/** Brings one workspace database's fixed tables to this release (section 7). */
export async function upgradeFixedTables(
  backend: Backend,
  workspaceId: string,
  database: string,
  now = new Date(),
): Promise<boolean> {
  const db = backend.adminDb(database);
  const [state] = await db
    .rows<WorkspaceState>('SELECT * FROM ONLY workspace_state:current;')
    .catch(() => [] as WorkspaceState[]);
  if (state && state.fixed_revision >= WORKSPACE_REVISION) return false;
  await applyFixedTables(db);
  if (!state) {
    await db.query(
      'CREATE workspace_state:current CONTENT { workspace_id: $id, revision: 0, schema_version: 0, mode: "active", fixed_revision: $revision, access_keys: [], settings: {}, templates: [], created_at: $now, updated_at: $now };',
      { id: workspaceId, revision: WORKSPACE_REVISION, now },
    );
  } else {
    // Advances the revision, so a write planned against old tables fails.
    await db.query(
      'UPDATE workspace_state:current SET fixed_revision = $revision, revision += 1, updated_at = $now;',
      { revision: WORKSPACE_REVISION, now },
    );
  }
  log.info(`Upgraded the fixed tables of workspace ${workspaceId} to revision ${WORKSPACE_REVISION}.`);
  return true;
}

/**
 * Defines the access methods of the configured signing keys and removes
 * those no longer accepted; records them in `workspace_state` and the
 * catalog (section 4, key rotation).
 */
export async function upgradeAccessMethods(
  backend: Backend,
  workspaceId: string,
  database: string,
): Promise<string[]> {
  const db = backend.adminDb(database);
  const [state] = await db.rows<WorkspaceState>('SELECT access_keys FROM ONLY workspace_state:current;');
  const before = state?.access_keys ?? [];
  const accepted = acceptedKeys(backend.keys).map((k) => k.id);
  const upToDate =
    accepted.every((id) => before.includes(id)) && before.every((id) => accepted.includes(id));
  if (upToDate) return before;
  const after = await applyAccess(backend, db, before);
  await db.query('UPDATE workspace_state:current SET access_keys = $keys;', { keys: after });
  await backend
    .adminCatalog()
    .query('UPDATE type::record("workspaces", $id) SET access_keys = $keys, updated_at = $now;', {
      id: workspaceId,
      keys: after,
      now: new Date(),
    });
  backend.forgetRoute(workspaceId);
  return after;
}

export async function markWorkspaceActive(backend: Backend, workspaceId: string): Promise<void> {
  await backend
    .adminCatalog()
    .query(
      'UPDATE type::record("workspaces", $id) SET state = "active", updated_at = $now RETURN id;',
      { id: workspaceId, now: new Date() },
    );
  backend.forgetRoute(workspaceId);
}

/** Removes a workspace database and its catalog entry (tests and failed creation). */
export async function removeWorkspace(backend: Backend, workspaceId: string): Promise<void> {
  const row = await catalogWorkspace(backend, workspaceId);
  if (row) {
    await backend.adminNamespace().query(`REMOVE DATABASE IF EXISTS ${ident(row.database)};`);
  }
  await backend
    .adminCatalog()
    .query(
      'DELETE type::record("workspaces", $id); DELETE api_keys WHERE workspace = $id;',
      { id: workspaceId },
    );
  backend.forgetRoute(workspaceId);
  backend.upgraded.delete(workspaceId);
}
