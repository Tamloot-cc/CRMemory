import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import type { AppliedTemplate } from '../db/schema.js';
import { inWorkspace, lockSchemaExclusive } from '../db/tx.js';
import { log } from '../log.js';
import { runSchemaChange, SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { loadSchemaState } from '../schema-engine/load.js';
import type { SchemaOperation } from '../schema-engine/operations.js';
import {
  PROTECTED_FIELD_IDS,
  PROTECTED_OBJECT_IDS,
  PROTECTED_OPTIONS,
} from '../schema-engine/protection.js';
import { planUpgrade, type UpgradeConflict } from '../schema-engine/upgrade.js';
import { SEED_OPERATIONS } from '../templates/base.js';
import { getTemplate, type Template } from '../templates/index.js';

export type UpgradeReport = {
  /** Slugs of the workspaces whose schema the run changed. */
  upgraded: string[];
  conflicts: (UpgradeConflict & { workspace: string })[];
  failed: { workspace: string; message: string }[];
};

type Definitions = { operations: SchemaOperation[]; digest: string; templates: Template[] };

/**
 * The code-defined schema a workspace should have (3): the seed operations
 * and those of each template it applied, with a digest that changes when
 * any of them or the protection lists change.
 */
export function definitionsFor(applied: readonly AppliedTemplate[]): Definitions {
  const names = [...new Set(applied.map((t) => t.name))].sort();
  const templates = names.map(getTemplate).filter((t): t is Template => t !== undefined);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        seed: SEED_OPERATIONS,
        protected: {
          objects: [...PROTECTED_OBJECT_IDS].sort(),
          fields: [...PROTECTED_FIELD_IDS].sort(),
          options: [...PROTECTED_OPTIONS].sort(([a], [b]) => a.localeCompare(b)),
        },
        templates: templates.map((t) => [t.name, t.operations]),
      }),
    )
    .digest('hex');
  return {
    operations: [...SEED_OPERATIONS, ...templates.flatMap((t) => t.operations)],
    digest,
    templates,
  };
}

type WorkspaceRow = {
  id: string;
  slug: string;
  templates: AppliedTemplate[];
  definitions_digest: string | null;
};

type WorkspaceUpgrade = { changed: boolean; conflicts: UpgradeConflict[] };

/**
 * Brings one workspace up to its definitions through the schema engine's
 * trusted path, as the server's own actor. Holds the workspace's exclusive
 * schema lock and re-reads the digest under it, so concurrent runs upgrade
 * the workspace once. The digest is stamped only when nothing conflicted.
 */
export async function upgradeWorkspace(sql: Sql, workspaceId: string): Promise<WorkspaceUpgrade> {
  return inWorkspace(sql, workspaceId, async (tx) => {
    await lockSchemaExclusive(tx, workspaceId);
    const [row] = await tx<WorkspaceRow[]>`
      select id, slug, templates, definitions_digest from workspaces where id = ${workspaceId}`;
    if (!row) return { changed: false, conflicts: [] };
    const definitions = definitionsFor(row.templates);
    if (row.definitions_digest === definitions.digest) return { changed: false, conflicts: [] };

    const { operations, conflicts } = planUpgrade(
      await loadSchemaState(tx, workspaceId),
      definitions.operations,
    );
    // Even with nothing to create, the trusted path may protect elements.
    const result = await runSchemaChange(tx, {
      workspaceId,
      actor: SYSTEM_ACTOR,
      scopes: [],
      operations,
      reason: 'Upgrade built-in definitions',
      owner: 'system',
      trusted: true,
    });
    if (result.status !== 'applied' && result.status !== 'unchanged') {
      throw new Error(`the upgrade change was ${result.status}: ${result.change?.error ?? ''}`);
    }
    if (conflicts.length === 0) {
      const versions = new Map<string, number>(
        definitions.templates.map((t) => [t.name, t.version]),
      );
      const templates = row.templates.map((t) => ({
        ...t,
        version: versions.get(t.name) ?? t.version,
      }));
      await tx`
        update workspaces
        set templates = ${tx.json(templates)}, definitions_digest = ${definitions.digest},
          updated_at = now()
        where id = ${workspaceId}`;
    }
    return { changed: result.status === 'applied', conflicts };
  });
}

/**
 * Upgrades every workspace whose digest is stale (3), after migrations.
 * `sql` connects as the migration role. A workspace that fails is logged
 * and reported, and keeps its schema; the others still run.
 */
export async function upgradeWorkspaces(sql: Sql): Promise<UpgradeReport> {
  const report: UpgradeReport = { upgraded: [], conflicts: [], failed: [] };
  const rows = await sql<WorkspaceRow[]>`
    select id, slug, templates, definitions_digest from workspaces order by created_at, id`;
  for (const row of rows) {
    if (row.definitions_digest === definitionsFor(row.templates).digest) continue;
    try {
      const { changed, conflicts } = await upgradeWorkspace(sql, row.id);
      if (changed) {
        report.upgraded.push(row.slug);
        log.info(`Upgraded workspace ${row.slug} to the built-in definitions.`);
      }
      for (const conflict of conflicts) {
        report.conflicts.push({ workspace: row.slug, ...conflict });
        log.warn(
          `Workspace ${row.slug}: could not add built-in ${conflict.element}: ${conflict.message}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ workspace: row.slug, message });
      log.error(`Upgrading workspace ${row.slug} failed: ${message}`);
    }
  }
  return report;
}
