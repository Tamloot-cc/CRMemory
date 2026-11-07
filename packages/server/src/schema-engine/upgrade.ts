import type { SchemaState } from '../schema/types.js';
import { applyOperations } from './apply.js';
import type { FieldDefinitionInput, SchemaOperation } from './operations.js';
import { issueKey, validateSchema } from './validate.js';

/** A built-in element an upgrade could not add, and why. */
export type UpgradeConflict = { element: string; message: string };

export type UpgradePlan = {
  /** Operations that add what the workspace never had; they validate together. */
  operations: SchemaOperation[];
  conflicts: UpgradeConflict[];
};

/**
 * Plans bringing a workspace up to code-defined schema (3): the operations
 * that create the objects and fields `definitions` define and the workspace
 * never had. Elements are matched by universal ID, whatever their status,
 * so a renamed element is found and a deleted one is not re-created.
 * Definitions refer to objects by universal ID, which the engine resolves
 * whatever the workspace renamed them to. Existing elements are never
 * changed. An element the workspace's schema cannot take, such as one whose
 * name its own object already uses, is a conflict; the rest still apply.
 * Pure: the engine validates the result again when it runs.
 */
export function planUpgrade(current: SchemaState, definitions: SchemaOperation[]): UpgradePlan {
  const present = new Set(
    current.objects.flatMap((o) => [o.universalId, ...o.fields.map((f) => f.universalId)]),
  );
  const objects = new Map(current.objects.map((o) => [o.universalId, o]));

  // Accept each element in order, only if it adds no new issue to those the
  // workspace's schema already has.
  const baseline = new Set(validateSchema(current).map(issueKey));
  let accepted = current;
  const operations: SchemaOperation[] = [];
  const conflicts: UpgradeConflict[] = [];
  const tryAdd = (element: string, operation: SchemaOperation) => {
    const { state, issues } = applyOperations(accepted, [operation], { owner: 'system' });
    const fresh = [...issues, ...validateSchema(state)].filter((i) => !baseline.has(issueKey(i)));
    if (fresh.length === 0) {
      accepted = state;
      operations.push(operation);
    } else {
      const message = [...new Set(fresh.map((i) => `${i.path}: ${i.message}`))].join('; ');
      conflicts.push({ element, message });
    }
  };

  const addFields = (objectId: string, fields: FieldDefinitionInput[]) => {
    const object = objects.get(objectId);
    // Fields of an object the workspace deleted go with it.
    if (object && object.status !== 'active') return;
    const name = object?.nameSingular ?? objectId;
    for (const field of fields) {
      if (!field.universalId || present.has(field.universalId)) continue;
      tryAdd(`${name}.${field.name}`, { op: 'create_field', object: objectId, field });
    }
  };

  for (const operation of definitions) {
    if (operation.op === 'create_object') {
      const id = operation.object.universalId;
      if (!id) continue;
      if (present.has(id)) addFields(id, operation.object.fields);
      else tryAdd(operation.object.nameSingular, operation);
    } else if (operation.op === 'create_field') {
      addFields(operation.object, [operation.field]);
    }
  }
  return { operations, conflicts };
}
