import { randomUUID } from 'node:crypto';
import type { Backend } from '../db/backend.js';
import type { RecordId } from '../db/cbor.js';
import { mutate, readState } from '../db/protocol.js';
import {
  type CatalogWorkspace,
  catalogWorkspace,
  markWorkspaceActive,
  provisionDatabase,
  removeWorkspace,
} from '../db/provision.js';
import { AppError } from '../errors.js';
import { SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { planApplyTemplate, seedBaseObjects } from '../templates/apply.js';

export type Workspace = {
  id: string;
  slug: string;
  name: string;
  schemaVersion: number;
  templates: { name: string; version: number; appliedAt: string }[];
  initializedAt: string | null;
  createdAt: string;
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Seeds the base objects and the requested template, then marks the
 * workspace active (section 4). Each step checks what is already there, so
 * an interrupted creation resumes.
 */
async function finishProvisioning(
  backend: Backend,
  row: CatalogWorkspace & { template?: string | null },
) {
  const db = await backend.workspace(row.id, { provisioning: true });
  const state = await readState(db);
  if (state.schema_version === 0) {
    await mutate(backend, row.id, {
      kind: 'provision_workspace',
      admin: true,
      provisioning: true,
      refs: () => [],
      plan: (op) => seedBaseObjects(op),
    });
  }
  if (row.template && !state.templates.some((t) => t.name === row.template)) {
    await mutate(backend, row.id, {
      kind: 'provision_workspace',
      admin: true,
      provisioning: true,
      refs: () => [],
      plan: (op) =>
        planApplyTemplate(op, {
          actor: SYSTEM_ACTOR,
          scopes: ['schema:write'],
          name: row.template as string,
        }),
    });
  }
  await markWorkspaceActive(backend, row.id);
}

/**
 * Creates a workspace with its base objects and, optionally, a template.
 * An operator operation (7.1) through the administrative client. One
 * workspace at a time (section 4): creation is serialized in this process.
 */
export async function createWorkspace(
  backend: Backend,
  input: { name: string; slug?: string; template?: string },
): Promise<Workspace> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid_request', 'a workspace needs a name');
  const slug = input.slug ?? slugify(name);
  if (!SLUG_PATTERN.test(slug)) {
    throw new AppError(
      400,
      'invalid_request',
      `slug "${slug}" must be lowercase letters and digits separated by hyphens`,
    );
  }
  return backend.queues.run('__provisioning__', 'create_workspace', async () => {
    const id = randomUUID();
    const row = await provisionDatabase(backend, {
      id,
      slug,
      name,
      now: new Date(),
      template: input.template ?? null,
    });
    try {
      await finishProvisioning(backend, { ...row, template: input.template ?? null });
    } catch (error) {
      // Nothing is half-created: remove the workspace again.
      await removeWorkspace(backend, id).catch(() => undefined);
      throw error;
    }
    return getWorkspace(backend, id);
  });
}

/** Resumes workspaces whose creation was interrupted (run at start, under the lease). */
export async function resumeProvisioning(backend: Backend): Promise<number> {
  const rows = await backend
    .adminCatalog()
    .rows<CatalogWorkspace & { id: RecordId; template?: string | null }>(
      'SELECT * FROM workspaces WHERE state = "provisioning" ORDER BY created_at;',
    );
  for (const row of rows) {
    const id = String(row.id.id);
    await provisionDatabase(backend, {
      id,
      slug: row.slug,
      name: row.name,
      now: new Date(),
      template: row.template ?? null,
    });
    await finishProvisioning(backend, { ...row, id });
  }
  return rows.length;
}

async function toWorkspace(backend: Backend, row: CatalogWorkspace): Promise<Workspace> {
  const state = await readState(backend.adminDb(row.database));
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    schemaVersion: state.schema_version,
    templates: state.templates,
    initializedAt: state.initialized_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getWorkspace(backend: Backend, idOrSlug: string): Promise<Workspace> {
  let row: CatalogWorkspace | undefined;
  if (UUID_PATTERN.test(idOrSlug)) row = await catalogWorkspace(backend, idOrSlug);
  else {
    const [found] = await backend
      .adminCatalog()
      .rows<CatalogWorkspace & { id: RecordId }>('SELECT * FROM workspaces WHERE slug = $slug;', {
        slug: idOrSlug,
      });
    row = found ? { ...found, id: String(found.id.id) } : undefined;
  }
  if (row?.state !== 'active') {
    throw new AppError(404, 'not_found', `workspace "${idOrSlug}" not found`);
  }
  return toWorkspace(backend, row);
}

/** The caller's own workspace, through the runtime catalog session. */
export async function readWorkspaceInfo(
  backend: Backend,
  workspaceId: string,
): Promise<{ id: string; slug: string; name: string }> {
  const [row] = await backend
    .catalog()
    .rows<{ slug: string; name: string }>(
      'SELECT slug, name FROM type::record("workspaces", $id);',
      {
        id: workspaceId,
      },
    );
  if (!row) throw new AppError(404, 'not_found', `workspace "${workspaceId}" not found`);
  return { id: workspaceId, slug: row.slug, name: row.name };
}

export async function listWorkspaces(backend: Backend): Promise<Workspace[]> {
  const rows = await backend
    .adminCatalog()
    .rows<CatalogWorkspace & { id: RecordId }>(
      'SELECT * FROM workspaces WHERE state = "active" ORDER BY created_at, id;',
    );
  return Promise.all(rows.map((row) => toWorkspace(backend, { ...row, id: String(row.id.id) })));
}
