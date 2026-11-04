import type { FieldType } from './field-types.js';

/** Who added a piece of the schema. */
export const SCHEMA_OWNERS = ['system', 'workspace', 'agent'] as const;
export type SchemaOwner = (typeof SCHEMA_OWNERS)[number];

/**
 * Live schema rows are active or deprecated. A proposed change lives only in
 * `schema_changes` until it is approved; nothing half-exists in the schema.
 */
export const SCHEMA_STATUSES = ['active', 'deprecated'] as const;
export type SchemaStatus = (typeof SCHEMA_STATUSES)[number];

/** Where a requested schema change stands. */
export const SCHEMA_CHANGE_STATUSES = ['applied', 'proposed', 'rejected', 'failed'] as const;
export type SchemaChangeStatus = (typeof SCHEMA_CHANGE_STATUSES)[number];

/**
 * Universal IDs of the base objects every workspace has (ARCHITECTURE.md
 * 3.1). They are the same in every workspace and fixed forever, so server
 * code and clients find these objects by ID rather than by API name, which
 * a workspace may rename.
 */
export const BASE_OBJECT_IDS = {
  company: '1f24f94d-6bc5-4955-b6ab-ac946e2b140a',
  person: '7e87d873-8c93-4786-9a0b-95447310c8d3',
  task: 'd0690d5f-d7f4-47ce-8007-0a81a276a70b',
} as const;

/** Base fields that server code reads directly, such as open tasks in context packs. */
export const BASE_FIELD_IDS = {
  taskStatus: '107158ae-ba0f-482e-afe1-5e45bd6ccfd6',
  taskDueDate: '368276ea-604d-4dcd-b6ad-796431a84a06',
} as const;

export type BaseObjectName = keyof typeof BASE_OBJECT_IDS;
export type BaseFieldName = keyof typeof BASE_FIELD_IDS;

/** The `task.status` option that marks a task closed; protected (1.1). */
export const TASK_DONE_OPTION = 'done';

export type SelectOption = {
  value: string;
  label: string;
};

/**
 * A relation is written on its many_to_one side (`person.company`); the
 * one_to_many side (`company.people`) is its read-only inverse.
 */
export type RelationCardinality = 'many_to_one' | 'one_to_many';

export type OnDeleteBehavior = 'set_null' | 'cascade';

/** Type-specific field settings, as the API shows and accepts them. */
export type FieldSettings = {
  /** `select` and `multi_select`. */
  options?: SelectOption[];
  /** `relation`: API name (singular) of the object on the other side. */
  targetObject?: string;
  /** `relation`: API name of the field on the other side that points back. */
  inverseField?: string;
  relationCardinality?: RelationCardinality;
  /** `relation`, many_to_one side: what happens when the target is deleted. */
  onDelete?: OnDeleteBehavior;
  /** `emails`, `phones`, `links`: cap on total primary plus additional values. */
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
