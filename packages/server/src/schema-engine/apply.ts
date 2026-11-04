import { createHash, randomUUID } from 'node:crypto';
import {
  type CoreRole,
  type FieldType,
  INTERNAL_NOTE_TYPE_ID,
  type SchemaOwner,
} from '@retainer/shared';
import type { FieldDefinitionInput, SchemaOperation } from './operations.js';
import {
  PROTECTED_FIELD_FLAGS,
  PROTECTED_FIELD_IDS,
  PROTECTED_OBJECT_IDS,
  PROTECTED_OPTIONS,
} from './protection.js';
import type { FieldState, ObjectState, SchemaIssue, SchemaState } from './types.js';

/**
 * A stable UUID derived from a seed (RFC 9562 version 8, from SHA-256). Used
 * for the inverse side of a relation, so code-defined relations get the
 * same inverse universal ID in every workspace without listing it.
 */
export function deriveUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The core fields the engine gives every event type (6.1). Their universal
 * IDs derive from the type's, so code-defined event types get the same core
 * field IDs in every workspace.
 */
export const CORE_FIELDS: Record<CoreRole, { name: string; label: string; description: string }> = {
  title: { name: 'title', label: 'Title', description: 'A short title.' },
  summary: {
    name: 'summary',
    label: 'Summary',
    description: "The agent's own short summary of what happened.",
  },
};

export const coreFieldUniversalId = (objectUniversalId: string, role: CoreRole) =>
  deriveUuid(`${objectUniversalId}:core:${role}`);

/** Types whose values make sense in structured filters by default. */
const NOT_FILTERABLE_BY_DEFAULT: ReadonlySet<FieldType> = new Set(['json', 'address', 'full_name']);

export type ApplyContext = {
  /** Owner recorded on everything this change creates. */
  owner: SchemaOwner;
};

/**
 * Step 2 of the engine: applies the requested operations to a copy of the
 * current schema, giving the desired schema. Reference errors (an unknown
 * object, a type change) are returned as issues; structural rules are
 * checked afterwards by `validateSchema`, and both are reported together.
 */
export function applyOperations(
  current: SchemaState,
  operations: SchemaOperation[],
  context: ApplyContext,
): { state: SchemaState; issues: SchemaIssue[] } {
  const state: SchemaState = structuredClone(current);
  const issues: SchemaIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });

  const allUniversalIds = () =>
    new Set(state.objects.flatMap((o) => [o.universalId, ...o.fields.map((f) => f.universalId)]));

  // The hidden internal-note type is never named by an operation (6.4).
  const visible = (o: ObjectState) =>
    o.status === 'active' && o.universalId !== INTERNAL_NOTE_TYPE_ID;

  function findObject(ref: string, path = ref): ObjectState | undefined {
    const object = state.objects.find(
      (o) => visible(o) && (o.universalId === ref || o.nameSingular === ref),
    );
    if (!object) {
      const known = state.objects
        .filter(visible)
        .map((o) => o.nameSingular)
        .join(', ');
      issue(path, `unknown object "${ref}"; objects: ${known || 'none'}`);
    }
    return object;
  }

  function findField(object: ObjectState, ref: string): FieldState | undefined {
    const field = object.fields.find(
      (f) => f.status === 'active' && (f.universalId === ref || f.name === ref),
    );
    if (!field) {
      const known = object.fields
        .filter((f) => f.status === 'active')
        .map((f) => f.name)
        .join(', ');
      issue(`${object.nameSingular}.${ref}`, `unknown field; fields: ${known}`);
    }
    return field;
  }

  /** Keys are permanent and never reused, including deprecated fields' keys. */
  function nextKey(object: ObjectState, name: string): string {
    const used = new Set(object.fields.map((f) => f.key));
    if (!used.has(name)) return name;
    for (let n = 2; ; n++) {
      const key = `${name}_${n}`;
      if (!used.has(key)) return key;
    }
  }

  function addField(object: ObjectState, definition: FieldDefinitionInput): void {
    const path = `${object.nameSingular}.${definition.name}`;
    const universalId = definition.universalId ?? randomUUID();
    if (allUniversalIds().has(universalId)) {
      issue(path, `universal ID ${universalId} already exists`);
      return;
    }
    const { targetObject, inverseField, relationCardinality, onDelete, ...rest } =
      definition.settings ?? {};

    const field: FieldState = {
      universalId,
      key: nextKey(object, definition.name),
      name: definition.name,
      label: definition.label,
      description: definition.description ?? null,
      type: definition.type,
      settings: { ...rest },
      isNullable: definition.isNullable ?? true,
      isUnique: definition.isUnique ?? false,
      isFilterable: definition.isFilterable ?? !NOT_FILTERABLE_BY_DEFAULT.has(definition.type),
      isSearchable: definition.isSearchable ?? false,
      isProtected: PROTECTED_FIELD_IDS.has(universalId),
      coreRole: null,
      owner: context.owner,
      status: 'active',
    };

    if (definition.type !== 'relation') {
      if (targetObject || inverseField || relationCardinality || onDelete) {
        issue(path, 'targetObject, inverseField and onDelete apply only to relation fields');
      }
      object.fields.push(field);
      return;
    }

    if (!targetObject) {
      issue(path, 'a relation needs settings.targetObject');
      return;
    }
    // Pushed before resolving the target, so a self-relation finds it.
    object.fields.push(field);
    const target = findObject(targetObject, path);
    if (!target) return;
    field.settings = {
      ...field.settings,
      targetObjectId: target.universalId,
      relationCardinality: 'many_to_one',
      onDelete: onDelete ?? 'set_null',
    };

    if (inverseField) {
      const inverse: FieldState = {
        universalId: deriveUuid(`${universalId}:inverse`),
        key: nextKey(target, inverseField),
        name: inverseField,
        label: object.labelPlural,
        description: null,
        type: 'relation',
        settings: {
          targetObjectId: object.universalId,
          inverseFieldId: universalId,
          relationCardinality: 'one_to_many',
        },
        isNullable: true,
        isUnique: false,
        isFilterable: false,
        isSearchable: false,
        isProtected: false,
        coreRole: null,
        owner: context.owner,
        status: 'active',
      };
      field.settings.inverseFieldId = inverse.universalId;
      target.fields.push(inverse);
    }
  }

  /** The protected, searchable title and summary fields of a new event type (6.1). */
  function addCoreFields(object: ObjectState): void {
    for (const role of ['title', 'summary'] as const) {
      const core = CORE_FIELDS[role];
      object.fields.push({
        universalId: coreFieldUniversalId(object.universalId, role),
        key: nextKey(object, core.name),
        name: core.name,
        label: core.label,
        description: core.description,
        type: 'text',
        settings: {},
        isNullable: true,
        isUnique: false,
        isFilterable: true,
        isSearchable: true,
        isProtected: true,
        coreRole: role,
        owner: context.owner,
        status: 'active',
      });
    }
  }

  /** Deprecates a field and, for a relation, its other side. */
  function deprecateField(field: FieldState): void {
    field.status = 'deprecated';
    const inverseId = field.settings.inverseFieldId;
    if (!inverseId) return;
    for (const other of state.objects) {
      const inverse = other.fields.find((f) => f.universalId === inverseId);
      if (inverse) inverse.status = 'deprecated';
    }
  }

  for (const operation of operations) {
    switch (operation.op) {
      case 'create_object': {
        const definition = operation.object;
        const universalId = definition.universalId ?? randomUUID();
        if (allUniversalIds().has(universalId)) {
          issue(definition.nameSingular, `universal ID ${universalId} already exists`);
          break;
        }
        const objectClass = definition.class ?? 'entity';
        const object: ObjectState = {
          universalId,
          nameSingular: definition.nameSingular,
          namePlural: definition.namePlural,
          labelSingular: definition.labelSingular,
          labelPlural: definition.labelPlural,
          description: definition.description ?? null,
          labelFieldId: null,
          isProtected: PROTECTED_OBJECT_IDS.has(universalId),
          class: objectClass,
          owner: context.owner,
          status: 'active',
          fields: [],
        };
        state.objects.push(object);
        if (objectClass === 'event') {
          const taken = definition.fields.filter(
            (f) => f.name === CORE_FIELDS.title.name || f.name === CORE_FIELDS.summary.name,
          );
          for (const field of taken) {
            issue(
              `${definition.nameSingular}.${field.name}`,
              'every event type gets title and summary fields; list only its other fields',
            );
          }
          if (taken.length > 0) break;
          addCoreFields(object);
          if (
            definition.labelField !== undefined &&
            definition.labelField !== CORE_FIELDS.title.name
          ) {
            issue(definition.nameSingular, "an event type's labelField is always its title");
          }
          for (const field of definition.fields) addField(object, field);
          object.labelFieldId = coreFieldUniversalId(universalId, 'title');
          break;
        }
        if (definition.fields.length === 0) {
          issue(definition.nameSingular, 'an object needs at least one field');
          break;
        }
        for (const field of definition.fields) addField(object, field);
        const labelField = object.fields.find(
          (f) => f.name === definition.labelField && f.status === 'active',
        );
        if (labelField) object.labelFieldId = labelField.universalId;
        else if (definition.labelField === undefined) {
          issue(definition.nameSingular, 'an object needs a labelField');
        } else
          issue(definition.nameSingular, `labelField "${definition.labelField}" is not a field`);
        break;
      }

      case 'update_object': {
        const object = findObject(operation.object);
        if (!object) break;
        if (operation.labelSingular !== undefined) object.labelSingular = operation.labelSingular;
        if (operation.labelPlural !== undefined) object.labelPlural = operation.labelPlural;
        if (operation.description !== undefined) object.description = operation.description;
        if (operation.labelField !== undefined) {
          const field = findField(object, operation.labelField);
          if (field && object.class === 'event' && field.coreRole !== 'title') {
            issue(object.nameSingular, "an event type's labelField is always its title");
          } else if (field) object.labelFieldId = field.universalId;
        }
        break;
      }

      case 'rename_object': {
        const object = findObject(operation.object);
        if (!object) break;
        object.nameSingular = operation.nameSingular;
        object.namePlural = operation.namePlural;
        break;
      }

      case 'delete_object': {
        const object = findObject(operation.object);
        if (!object) break;
        if (object.isProtected) {
          issue(
            object.nameSingular,
            'is protected: Retainer depends on it, so it cannot be deleted (it can be renamed)',
          );
          break;
        }
        object.status = 'deprecated';
        for (const field of object.fields) deprecateField(field);
        // Relations elsewhere that point at the object go with it.
        for (const other of state.objects) {
          for (const field of other.fields) {
            if (field.status === 'active' && field.settings.targetObjectId === object.universalId) {
              deprecateField(field);
            }
          }
        }
        break;
      }

      case 'create_field': {
        const object = findObject(operation.object);
        if (object) addField(object, operation.field);
        break;
      }

      case 'update_field': {
        const object = findObject(operation.object);
        const field = object && findField(object, operation.field);
        if (!object || !field) break;
        const path = `${object.nameSingular}.${field.name}`;
        if (operation.type !== undefined && operation.type !== field.type) {
          issue(
            path,
            'changing a field type is not supported; create a new field and delete this one',
          );
          break;
        }
        const isInverse = field.settings.relationCardinality === 'one_to_many';
        const flags = PROTECTED_FIELD_FLAGS;
        if (isInverse && flags.some((flag) => operation[flag] !== undefined)) {
          issue(path, 'an inverse relation field only takes label and description changes');
          break;
        }
        const reshaped = flags.filter(
          (flag) => operation[flag] !== undefined && operation[flag] !== field[flag],
        );
        if (field.isProtected && reshaped.length > 0) {
          issue(
            path,
            `is protected: Retainer depends on it, so ${reshaped.join(', ')} cannot change ` +
              '(it can be renamed, relabeled and described)',
          );
          break;
        }
        if (operation.label !== undefined) field.label = operation.label;
        if (operation.description !== undefined) field.description = operation.description;
        for (const flag of flags) {
          const value = operation[flag];
          if (value !== undefined) field[flag] = value;
        }
        break;
      }

      case 'rename_field': {
        const object = findObject(operation.object);
        const field = object && findField(object, operation.field);
        if (field) field.name = operation.name;
        break;
      }

      case 'delete_field': {
        const object = findObject(operation.object);
        const field = object && findField(object, operation.field);
        if (!object || !field) break;
        const path = `${object.nameSingular}.${field.name}`;
        if (field.settings.relationCardinality === 'one_to_many') {
          issue(path, 'an inverse relation field is removed by deleting its many_to_one side');
          break;
        }
        if (field.isProtected) {
          issue(path, 'is protected: Retainer depends on it, so it cannot be deleted');
          break;
        }
        if (object.labelFieldId === field.universalId) {
          issue(
            path,
            `is the label field of ${object.nameSingular}; choose another labelField first`,
          );
          break;
        }
        deprecateField(field);
        break;
      }

      case 'add_option':
      case 'update_option':
      case 'remove_option': {
        const object = findObject(operation.object);
        const field = object && findField(object, operation.field);
        if (!object || !field) break;
        const path = `${object.nameSingular}.${field.name}`;
        if (field.type !== 'select' && field.type !== 'multi_select') {
          issue(path, `options apply only to select and multi_select fields, not ${field.type}`);
          break;
        }
        const options = [...(field.settings.options ?? [])];
        if (operation.op === 'add_option') {
          options.push(operation.option);
        } else {
          const index = options.findIndex((o) => o.value === operation.value);
          if (index < 0) {
            issue(
              path,
              `unknown option "${operation.value}"; options: ${options.map((o) => o.value).join(', ')}`,
            );
            break;
          }
          if (operation.op === 'update_option') {
            options[index] = { value: operation.value, label: operation.label };
          } else if (PROTECTED_OPTIONS.get(field.universalId)?.includes(operation.value)) {
            issue(
              path,
              `option "${operation.value}" is protected: Retainer depends on it, so it cannot ` +
                'be removed (its label can change)',
            );
            break;
          } else {
            options.splice(index, 1);
          }
        }
        field.settings = { ...field.settings, options };
        break;
      }
    }
  }

  return { state, issues };
}
