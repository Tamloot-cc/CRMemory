import { createApiKey } from '../auth/keys.js';
import type { Backend } from '../db/backend.js';
import { createWorkspace } from '../workspaces/workspaces.js';

export type FirstBoot = { workspaceSlug: string; keyId: string; key: string };

/**
 * A self-hosted install starts with one default workspace and an admin key
 * (7). Runs on every boot, after the process lease is taken, and does
 * nothing once any workspace exists. A racing CLI that creates the same
 * slug loses on the catalog's unique slug index.
 */
export async function bootstrap(backend: Backend): Promise<FirstBoot | null> {
  const [count] = await backend
    .adminCatalog()
    .rows<{ count: number }>('SELECT count() FROM workspaces GROUP ALL;');
  if ((count?.count ?? 0) > 0) return null;
  const workspace = await createWorkspace(backend, { name: 'Default', slug: 'default' });
  const key = await createApiKey(backend, {
    workspace: workspace.id,
    name: 'Admin (created on first boot)',
    actor: { type: 'user', id: 'admin', name: 'Administrator' },
    scopes: ['read', 'write', 'schema:write', 'admin'],
  });
  return { workspaceSlug: workspace.slug, keyId: key.id, key: key.key };
}

export function firstBootBanner(boot: FirstBoot): string {
  return [
    '',
    '================================================================',
    ' Retainer first boot: created the "default" workspace.',
    ' Admin API key (shown once; only its hash is stored):',
    '',
    `   ${boot.key}`,
    '',
    ' Create keys for your agents with:',
    '   retainer key create --workspace default --name <name> \\',
    '     --actor agent:<id> --scopes read,write,schema:write',
    '================================================================',
    '',
  ].join('\n');
}
