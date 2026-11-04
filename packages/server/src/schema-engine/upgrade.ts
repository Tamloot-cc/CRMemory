import { applyOperations } from './apply.js';
import type { FieldDefinitionInput, ObjectDefinitionInput, SchemaOperation } from './operations.js';
import type { SchemaIssue, SchemaState } from './types.js';
import { validateSchema } from './validate.js';

/** A built-in element an upgrade could not add, and why. */
export type UpgradeConflict = { element: string; message: string };

export type UpgradePlan = {
  /** Operations that add what the workspace never had; they validate together. */
  operations: SchemaOperation[];
  conflicts: UpgradeConflict[];
};

type Candidate = { element: string; operation: SchemaOperation };

const issueKey = (issue: SchemaIssue) => `${issue.path}\n${issue.message}`;

/**
 * Plans bringing a workspace up to code-defined schema (3): the operations
 * that create the objects and fields `definitions` define and the workspace
 * never had. Elements are matched by universal ID, whatever their status,
 * so a renamed element is found and a deleted one is not re-created. Names
 * in the definitions are resolved to universal IDs, so they still apply
 * after the workspace renamed their targets. Existing elements are never
 * changed. An element the workspace's schema cannot take, such as one whose
 * name its own object already uses, is a conflict; the rest still apply.
 * Pure: the engine validates the result again when it runs.
 */
export function planUpgrade(current: SchemaState, definitions: SchemaOperation[]): UpgradePlan {
  // What the definitions build on their own names each of their objects.
  const defined = applyOperations({ objects: [] }, definitions, { owner: 'system' }).state;
  const objectIds = new Map(defined.objects.map((o) => [o.nameSingular, o.universalId]));
  const idOf = (ref: string) => objectIds.get(ref) ?? ref;

  const present = new Set(
    current.objects.flatMap((o) => [o.universalId, ...o.fields.map((f) => f.universalId)]),
  );
  const objects = new Map(current.objects.map((o) => [o.universalId, o]));

  const resolveField = (field: FieldDefinitionInput): FieldDefinitionInput => {
    const { targetObject, targetObjects } = field.settings ?? {};
    if (!targetObject && !targetObjects) return field;
    return {
      ...field,
      settings: {
        ...field.settings,
        ...(targetObject ? { targetObject: idOf(targetObject) } : {}),
        ...(targetObjects ? { targetObjects: targetObjects.map(idOf) } : {}),
      },
    };
  };

  const candidates: Candidate[] = [];
  const addFields = (objectId: string, fields: FieldDefinitionInput[]) => {
    const object = objects.get(objectId);
    // Fields of an object the workspace deleted go with it.
    if (object && object.status !== 'active') return;
    const name = object?.nameSingular ?? objectId;
    for (const field of fields) {
      if (!field.universalId || present.has(field.universalId)) continue;
      candidates.push({
        element: `${name}.${field.name}`,
        operation: { op: 'create_field', object: objectId, field: resolveField(field) },
      });
    }
  };

  for (const operation of definitions) {
    if (operation.op === 'create_object') {
      const definition: ObjectDefinitionInput = operation.object;
      const id = definition.universalId;
      if (!id) continue;
      if (present.has(id)) {
        addFields(id, definition.fields);
        continue;
      }
      candidates.push({
        element: definition.nameSingular,
        operation: {
          op: 'create_object',
          object: { ...definition, fields: definition.fields.map(resolveField) },
        },
      });
    } else if (operation.op === 'create_field') {
      addFields(idOf(operation.object), [operation.field]);
    }
  }

  // Accept candidates in order, each only if it adds no new issue to those
  // the workspace's schema already has.
  const baseline = new Set(validateSchema(current).map(issueKey));
  const operations: SchemaOperation[] = [];
  const conflicts: UpgradeConflict[] = [];
  for (const candidate of candidates) {
    const trial = [...operations, candidate.operation];
    const { state, issues } = applyOperations(current, trial, { owner: 'system' });
    const fresh = [...issues, ...validateSchema(state)].filter((i) => !baseline.has(issueKey(i)));
    if (fresh.length === 0) {
      operations.push(candidate.operation);
    } else {
      const message = [...new Set(fresh.map((i) => `${i.path}: ${i.message}`))].join('; ');
      conflicts.push({ element: candidate.element, message });
    }
  }
  return { operations, conflicts };
}
