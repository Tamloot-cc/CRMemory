import type { Tx } from '../db/tx.js';
import { loadSchemaState } from './load.js';
import type { FieldState, ObjectState, SchemaState } from './types.js';

/** One object with lookups the record code needs. */
export type CompiledObject = {
  state: ObjectState;
  id: string;
  name: string;
  /** Active fields by API name. */
  fieldsByName: Map<string, FieldState>;
  /** Every field, deprecated included, by database ID. */
  fieldsById: Map<string, FieldState>;
  /** Active fields in definition order. */
  activeFields: FieldState[];
  labelField: FieldState | undefined;
};

/** A workspace schema at one `schema_version`, ready for validation and reads. */
export type CompiledSchema = {
  version: number;
  state: SchemaState;
  /** Active objects by singular API name. */
  objectsByName: Map<string, CompiledObject>;
  /** Every object by database ID. */
  objectsById: Map<string, CompiledObject>;
  /** Every object by universal ID. */
  objectsByUniversalId: Map<string, CompiledObject>;
  /** Every field, by database ID, with its object. */
  fieldOwners: Map<string, CompiledObject>;
};

export function compileSchema(state: SchemaState, version: number): CompiledSchema {
  const compiled: CompiledSchema = {
    version,
    state,
    objectsByName: new Map(),
    objectsById: new Map(),
    objectsByUniversalId: new Map(),
    fieldOwners: new Map(),
  };
  for (const object of state.objects) {
    if (!object.id) throw new Error('compileSchema needs a persisted schema');
    const activeFields = object.fields.filter((f) => f.status === 'active');
    const entry: CompiledObject = {
      state: object,
      id: object.id,
      name: object.nameSingular,
      fieldsByName: new Map(activeFields.map((f) => [f.name, f])),
      fieldsById: new Map(object.fields.map((f) => [f.id as string, f])),
      activeFields,
      labelField: object.fields.find((f) => f.universalId === object.labelFieldId),
    };
    if (object.status === 'active') compiled.objectsByName.set(object.nameSingular, entry);
    compiled.objectsById.set(object.id, entry);
    compiled.objectsByUniversalId.set(object.universalId, entry);
    for (const field of object.fields) compiled.fieldOwners.set(field.id as string, entry);
  }
  return compiled;
}

/**
 * Compiled schemas cached per (workspace, schema_version). Every applied
 * change increments the version, so a cached entry never goes stale; old
 * versions are dropped when a newer one is loaded.
 */
const cache = new Map<string, CompiledSchema>();

/**
 * The workspace's current schema. Call it after taking the schema lock, so
 * the version read here stays current for the rest of the transaction.
 */
export async function getSchema(tx: Tx, workspaceId: string): Promise<CompiledSchema> {
  const [workspace] = await tx<{ schema_version: number }[]>`
    select schema_version from workspaces where id = ${workspaceId}`;
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  const cached = cache.get(workspaceId);
  if (cached && cached.version === workspace.schema_version) return cached;
  const compiled = compileSchema(await loadSchemaState(tx, workspaceId), workspace.schema_version);
  cache.set(workspaceId, compiled);
  return compiled;
}
