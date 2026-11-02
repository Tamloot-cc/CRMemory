import type { FieldType } from './field-types.js';

/** Who added a piece of the schema. */
export const SCHEMA_OWNERS = ['system', 'workspace', 'agent'] as const;
export type SchemaOwner = (typeof SCHEMA_OWNERS)[number];

export const SCHEMA_STATUSES = ['active', 'proposed', 'deprecated'] as const;
export type SchemaStatus = (typeof SCHEMA_STATUSES)[number];

export type SelectOption = {
  value: string;
  label: string;
};

export type RelationCardinality = 'many_to_one' | 'one_to_many';

/** Type-specific settings, stored in `fields.settings`. */
export type FieldSettings = {
  /** `select` and `multi_select`. */
  options?: SelectOption[];
  /** `relation`: the object on the other side. */
  targetObject?: string;
  /** `relation`: the field on the other side that points back. */
  inverseField?: string;
  relationCardinality?: RelationCardinality;
  /** `relation`, many_to_one side: what happens when the target is deleted. */
  onDelete?: 'set_null' | 'cascade';
  /** `emails`, `phones`, `links`: cap on additional values. */
  maxValues?: number;
};

/** A field as defined in code (standard objects) or requested by a client. */
export type FieldDefinition = {
  /** Stable across every workspace. Required for standard fields. */
  universalId?: string;
  /** API name, camelCase, unique within the object. */
  name: string;
  label: string;
  description?: string;
  type: FieldType;
  settings?: FieldSettings;
  isNullable?: boolean;
  isUnique?: boolean;
  isFilterable?: boolean;
  isSearchable?: boolean;
};

/** An object type as defined in code or requested by a client. */
export type ObjectDefinition = {
  universalId?: string;
  /** API name, camelCase singular, e.g. "person". */
  nameSingular: string;
  /** API name, camelCase plural, e.g. "people". */
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description?: string;
  /** The field shown when a record is referenced, e.g. "name". */
  labelField: string;
  fields: FieldDefinition[];
};
