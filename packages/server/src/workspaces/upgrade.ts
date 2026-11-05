import { createHash } from 'node:crypto';
import type { Backend } from '../db/backend.js';
import type { RecordId } from '../db/cbor.js';
import { mutate, NoChange } from '../db/protocol.js';
import { catalogWorkspace, upgradeAccessMethods, upgradeFixedTables } from '../db/provision.js';
import type { AppliedTemplate } from '../db/types.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { planSchemaChange, SYSTEM_ACTOR } from '../schema-engine/engine.js';
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

type Definitions = { operations: SchemaOperation[]; digest: string };

/** By sorted template names; the definitions are constant while the process runs. */
const definitionsCache = new Map<string, Definitions>();

/**
 * The code-defined schema a workspace should have (3): the seed operations
 * and those of each template it applied, with a digest that changes when
 * any of them or the protection lists change.
 */
export function definitionsFor(applied: readonly AppliedTemplate[]): Definitions {
  const names = [...new Set(applied.map((t) => t.name))].sort();
  const cacheKey = names.join('\n');
  const cached = definitionsCache.get(cacheKey);
  if (cached) return cached;
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
  const definitions = {
    operations: [...SEED_OPERATIONS, ...templates.flatMap((t) => t.operations)],
    digest,
  };
  definitionsCache.set(cacheKey, definitions);
  return definitions;
}

type WorkspaceUpgrade = { changed: boolean; conflicts: UpgradeConflict[] };

/**
 * Brings one workspace up to its built-in definitions through the schema
 * engine's trusted path, as the server's own actor, under the write
 * protocol: a concurrent run replans and finds the digest current. The
 * digest is stamped only when nothing conflicted.
 */
export async function upgradeDefinitions(
  backend: Backend,
  workspaceId: string,
): Promise<WorkspaceUpgrade> {
  const { result } = await mutate(backend, workspaceId, {
    kind: 'upgrade_definitions',
    admin: true,
    refs: () => [],
    plan: async (op): Promise<WorkspaceUpgrade> => {
      const definitions = definitionsFor(op.state.templates);
      if (op.state.definitions_digest === definitions.digest) {
        throw new NoChange({ changed: false, conflicts: [] });
      }
      const { operations, conflicts } = planUpgrade(
        (await op.schema()).state,
        definitions.operations,
      );
      // Even with nothing to create, the trusted path may protect elements.
      const result = await planSchemaChange(op, {
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
        const templates = op.state.templates.map((t) => ({
          ...t,
          version: getTemplate(t.name)?.version ?? t.version,
        }));
        op.batch.update('workspace_state', 'current', {
          templates,
          definitions_digest: definitions.digest,
        });
      }
      if (result.status === 'unchanged' && conflicts.length > 0) {
        throw new NoChange({ changed: false, conflicts });
      }
      return { changed: result.status === 'applied', conflicts };
    },
  });
  return result;
}

/**
 * The upgrade runner for one workspace (section 7): fixed tables, then
 * signing-key access methods, then built-in definitions. A failed
 * fixed-table or access upgrade leaves the workspace's requests with a
 * retryable error; a failed definitions upgrade is reported and the
 * workspace keeps its current schema.
 */
export async function upgradeWorkspace(
  backend: Backend,
  workspaceId: string,
): Promise<WorkspaceUpgrade & { slug: string } | undefined> {
  const row = await catalogWorkspace(backend, workspaceId);
  if (!row || row.state !== 'active') return undefined;
  try {
    await upgradeFixedTables(backend, workspaceId, row.database);
    await upgradeAccessMethods(backend, workspaceId, row.database);
  } catch (error) {
    log.error(`Upgrading workspace ${row.slug} failed: ${(error as Error).message}`);
    throw new AppError(503, 'workspace_upgrading', 'the workspace is being upgraded; retry', {
      retryable: true,
    });
  }
  backend.upgraded.add(workspaceId);
  const upgrade = await upgradeDefinitions(backend, workspaceId);
  return { ...upgrade, slug: row.slug };
}

/** Lets a request trigger its workspace's upgrade before the worker reaches it. */
export function installUpgrader(backend: Backend): void {
  const inflight = new Map<string, Promise<void>>();
  backend.upgradeWorkspace = (workspaceId) => {
    let running = inflight.get(workspaceId);
    if (!running) {
      running = upgradeWorkspace(backend, workspaceId)
        .then(() => undefined)
        .catch((error) => {
          // A failed definitions upgrade still lets the workspace run.
          if (backend.upgraded.has(workspaceId)) {
            log.error(`Upgrading workspace ${workspaceId} failed: ${(error as Error).message}`);
            return;
          }
          throw error;
        })
        .finally(() => inflight.delete(workspaceId));
      inflight.set(workspaceId, running);
    }
    return running;
  };
}

/**
 * Upgrades every workspace, one at a time, at start (section 7). A
 * workspace that fails is logged and reported; the others still run.
 */
export async function upgradeWorkspaces(backend: Backend): Promise<UpgradeReport> {
  const report: UpgradeReport = { upgraded: [], conflicts: [], failed: [] };
  const rows = await backend
    .adminCatalog()
    .rows<{ id: RecordId; slug: string }>(
      'SELECT id, slug FROM workspaces WHERE state = "active" ORDER BY created_at, id;',
    );
  for (const row of rows) {
    const id = String(row.id.id);
    try {
      const result = await upgradeWorkspace(backend, id);
      if (!result) continue;
      if (result.changed) {
        report.upgraded.push(row.slug);
        log.info(`Upgraded workspace ${row.slug} to the built-in definitions.`);
      }
      for (const conflict of result.conflicts) {
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
