import type { Sql } from '../db/client.js';
import { inWorkspace } from '../db/tx.js';
import { AppError } from '../errors.js';
import { SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { applyTemplate, seedBaseObjects } from '../templates/apply.js';

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
 * Creates a workspace with its base objects and, optionally, a template.
 * An operator operation (7.1): `sql` connects as the migration role, since
 * the runtime role cannot create workspaces.
 */
export async function createWorkspace(
  sql: Sql,
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

  const workspaceId = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into workspaces (slug, name) values (${slug}, ${name})
      on conflict (slug) do nothing returning id`;
    if (!row) {
      throw new AppError(409, 'slug_taken', `a workspace with slug "${slug}" already exists`);
    }
    return row.id;
  });

  try {
    await inWorkspace(sql, workspaceId, async (tx) => {
      await seedBaseObjects(tx, workspaceId);
      if (input.template) {
        await applyTemplate(tx, {
          workspaceId,
          actor: SYSTEM_ACTOR,
          scopes: ['schema:write'],
          name: input.template,
        });
      }
    });
  } catch (error) {
    // Nothing is half-created: drop the empty workspace again.
    await sql`delete from workspaces where id = ${workspaceId}`;
    throw error;
  }

  return getWorkspace(sql, workspaceId);
}

type WorkspaceRow = {
  id: string;
  slug: string;
  name: string;
  schema_version: number;
  templates: Workspace['templates'];
  initialized_at: Date | null;
  created_at: Date;
};

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    schemaVersion: row.schema_version,
    templates: row.templates,
    initializedAt: row.initialized_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getWorkspace(sql: Sql, idOrSlug: string): Promise<Workspace> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const [row] = await sql<WorkspaceRow[]>`
    select * from workspaces where ${isUuid ? sql`id = ${idOrSlug}` : sql`slug = ${idOrSlug}`}`;
  if (!row) throw new AppError(404, 'not_found', `workspace "${idOrSlug}" not found`);
  return toWorkspace(row);
}

export async function listWorkspaces(sql: Sql): Promise<Workspace[]> {
  const rows = await sql<WorkspaceRow[]>`select * from workspaces order by created_at, id`;
  return rows.map(toWorkspace);
}
