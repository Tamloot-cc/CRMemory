import {
  BASE_FIELD_IDS,
  BASE_OBJECT_IDS,
  type BaseFieldName,
  type BaseObjectName,
  type FieldSettings,
  type ObjectView,
} from '@retainer/shared';
import type { CompiledSchema } from './compiled.js';
import { PROTECTED_OPTIONS } from './protection.js';
import type { FieldState } from './types.js';

export type { FieldView, ObjectView } from '@retainer/shared';

const BASE_OBJECT_NAMES = new Map<string, BaseObjectName>(
  Object.entries(BASE_OBJECT_IDS).map(([name, id]) => [id, name as BaseObjectName]),
);
const BASE_FIELD_NAMES = new Map<string, BaseFieldName>(
  Object.entries(BASE_FIELD_IDS).map(([name, id]) => [id, name as BaseFieldName]),
);

/** Field settings with universal IDs turned back into API names. */
function presentSettings(schema: CompiledSchema, field: FieldState): FieldSettings {
  const { targetObjectId, inverseFieldId, ...rest } = field.settings;
  const settings: FieldSettings = { ...rest };
  if (targetObjectId) {
    const target = schema.objectsByUniversalId.get(targetObjectId);
    if (target) settings.targetObject = target.name;
    const inverse = target?.state.fields.find((f) => f.universalId === inverseFieldId);
    if (inverse?.status === 'active') settings.inverseField = inverse.name;
  }
  return settings;
}

/** The active schema as describe_schema and GET /v1/schema show it (5). */
export function presentSchema(schema: CompiledSchema): ObjectView[] {
  return [...schema.objectsByName.values()].map((object) => ({
    nameSingular: object.state.nameSingular,
    namePlural: object.state.namePlural,
    labelSingular: object.state.labelSingular,
    labelPlural: object.state.labelPlural,
    description: object.state.description,
    labelField: object.labelField?.name ?? null,
    owner: object.state.owner,
    isProtected: object.state.isProtected,
    ...(BASE_OBJECT_NAMES.has(object.state.universalId)
      ? { baseObject: BASE_OBJECT_NAMES.get(object.state.universalId) }
      : {}),
    fields: object.activeFields.map((field) => ({
      name: field.name,
      label: field.label,
      description: field.description,
      type: field.type,
      settings: presentSettings(schema, field),
      isNullable: field.isNullable,
      isUnique: field.isUnique,
      isFilterable: field.isFilterable,
      isSearchable: field.isSearchable,
      readOnly: field.settings.relationCardinality === 'one_to_many',
      owner: field.owner,
      isProtected: field.isProtected,
      ...(PROTECTED_OPTIONS.has(field.universalId)
        ? { protectedOptions: [...(PROTECTED_OPTIONS.get(field.universalId) ?? [])] }
        : {}),
      ...(BASE_FIELD_NAMES.has(field.universalId)
        ? { baseField: BASE_FIELD_NAMES.get(field.universalId) }
        : {}),
    })),
  }));
}
