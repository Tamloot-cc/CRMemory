import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Actor, actorSchema } from '@retainer/shared';
import type { Backend } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { isUuid, publicId } from '../db/names.js';
import { API_KEY_SCOPES, type ApiKeyScope } from '../db/types.js';
import { AppError, notFound } from '../errors.js';
import { getWorkspace } from '../workspaces/workspaces.js';

const KEY_PREFIX = 'rtn_';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Characters of the key shown in listings, after `rtn_`. */
const DISPLAY_LENGTH = 8;

/** A new key: `rtn_` and 43 base62 characters (256 bits of randomness). */
export function generateApiKey(): string {
  let n = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let body = '';
  while (body.length < 43) {
    body = BASE62[Number(n % 62n)] + body;
    n /= 62n;
  }
  return `${KEY_PREFIX}${body}`;
}

/** Keys are stored only as their SHA-256 (7). */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export const keyPrefix = (key: string) => key.slice(0, KEY_PREFIX.length + DISPLAY_LENGTH);

/** Parses `type:id`, e.g. `agent:front-desk` or `user:dana`. */
export function parseActor(value: string, name?: string): Actor {
  const separator = value.indexOf(':');
  const parsed = actorSchema.safeParse({
    type: separator > 0 ? value.slice(0, separator) : value,
    id: separator > 0 ? value.slice(separator + 1) : '',
    ...(name ? { name } : {}),
  });
  if (!parsed.success) {
    throw new AppError(
      400,
      'invalid_actor',
      `actor "${value}" must be type:id with type user, integration, agent or system`,
    );
  }
  return parsed.data;
}

export function parseScopes(value: string): ApiKeyScope[] {
  const scopes = [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const unknown = scopes.filter((s) => !(API_KEY_SCOPES as readonly string[]).includes(s));
  if (scopes.length === 0 || unknown.length > 0) {
    throw new AppError(
      400,
      'invalid_scopes',
      `scopes must be some of: ${API_KEY_SCOPES.join(', ')}`,
      {
        unknown,
      },
    );
  }
  return scopes as ApiKeyScope[];
}

export type CreatedApiKey = {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  actor: Actor;
  /** Shown once; only the hash is stored. */
  key: string;
};

/**
 * Issues a key for one workspace. A trusted operator operation (7.1): keys
 * live in the catalog database, which runtime sessions can only read, so no
 * agent credential can mint a key.
 */
export async function createApiKey(
  backend: Backend,
  input: { workspace: string; name: string; actor: Actor; scopes: ApiKeyScope[] },
): Promise<CreatedApiKey> {
  const workspace = await getWorkspace(backend, input.workspace);
  const key = generateApiKey();
  const id = randomUUID();
  await backend.adminCatalog().query('CREATE $id CONTENT $content RETURN NONE;', {
    id: new RecordId('api_keys', id),
    content: {
      workspace: workspace.id,
      name: input.name,
      prefix: keyPrefix(key),
      hash: hashApiKey(key),
      scopes: input.scopes,
      actor: input.actor,
      created_at: new Date(),
    },
  });
  return {
    id,
    workspaceId: workspace.id,
    name: input.name,
    prefix: keyPrefix(key),
    scopes: input.scopes,
    actor: input.actor,
    key,
  };
}

export async function revokeApiKey(
  backend: Backend,
  id: string,
): Promise<{ id: string; revokedAt: string }> {
  if (!isUuid(id)) throw notFound(`key ${id}`);
  const [row] = await backend
    .adminCatalog()
    .rows<{ revoked_at: Date }>(
      'UPDATE $id SET revoked_at = revoked_at ?? time::now() RETURN revoked_at;',
      { id: new RecordId('api_keys', id) },
    );
  if (!row) throw notFound(`key ${id}`);
  return { id, revokedAt: row.revoked_at.toISOString() };
}

export type ApiKeyListing = Omit<CreatedApiKey, 'key'> & {
  createdAt: string;
  revokedAt: string | null;
};

export async function listApiKeys(backend: Backend, workspace: string): Promise<ApiKeyListing[]> {
  const { id } = await getWorkspace(backend, workspace);
  const rows = await backend.adminCatalog().rows<{
    id: RecordId;
    name: string;
    prefix: string;
    scopes: ApiKeyScope[];
    actor: Actor;
    created_at: Date;
    revoked_at?: Date | null;
  }>('SELECT * FROM api_keys WHERE workspace = $workspace ORDER BY created_at, id;', {
    workspace: id,
  });
  return rows.map((r) => ({
    id: publicId(r.id),
    workspaceId: id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    actor: r.actor,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
  }));
}
