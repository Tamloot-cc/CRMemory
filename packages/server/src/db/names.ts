import { RecordId } from './cbor.js';

/**
 * Physical names (spec section 5). They come from immutable IDs, never from
 * business names: renaming an object or field changes metadata, not tables.
 * Every name is checked by `ident` before it reaches a statement.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const hex = (uuid: string) => {
  if (!isUuid(uuid)) throw new Error(`expected a UUID, got "${uuid}"`);
  return uuid.replace(/-/g, '').toLowerCase();
};

/** The catalog database: workspaces, routes, keys and the process lease (section 4). */
export const CATALOG_DATABASE = 'catalog';

/** One database per workspace, named from its logical ID. */
export const workspaceDatabase = (workspaceId: string) => `ws_${hex(workspaceId)}`;

/** The table of one object type, from the object's universal ID. */
export const objectTable = (objectUniversalId: string) => `o_${hex(objectUniversalId)}`;

/** The edge table of one owning relation field, from the field's universal ID. */
export const relationTable = (fieldUniversalId: string) => `r_${hex(fieldUniversalId)}`;

/** A field's column in its object table, from its permanent key. */
export function fieldColumn(key: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid field key "${key}"`);
  return `f_${key}`;
}

/** A record's native ID in its object table. */
export const recordRef = (table: string, id: string) => new RecordId(table, id);

/** The access method a workspace database defines for one signing key. */
export const accessName = (keyId: string) => {
  if (!/^[a-z0-9_]{1,40}$/.test(keyId)) throw new Error(`invalid signing key ID "${keyId}"`);
  return `backend_${keyId}`;
};

/** The public UUID of a native record ID with a string key. */
export function publicId(value: unknown): string {
  if (value instanceof RecordId) return String(value.id);
  return String(value);
}
