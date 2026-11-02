import type { FieldSettings, ObjectView } from '@retainer/shared';
import type { CompiledSchema } from './compiled.js';
import type { FieldState } from './types.js';

export type { FieldView, ObjectView } from '@retainer/shared';

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
    })),
  }));
}
