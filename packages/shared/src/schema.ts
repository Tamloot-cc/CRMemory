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

/**
 * `entity`: a thing the workspace tracks (a person, a deal). `event`:
 * something that happened, with a time, a source identity, and the records
 * it took part in or concerns (1.3). Fixed when the object is created.
 */
export const OBJECT_CLASSES = ['entity', 'event'] as const;
export type ObjectClass = (typeof OBJECT_CLASSES)[number];

/**
 * The core fields every event type has, created and protected by the
 * schema engine. Server code finds them by role, never by name. The title
 * is the event type's label field.
 */
export const CORE_ROLES = ['title', 'summary'] as const;
export type CoreRole = (typeof CORE_ROLES)[number];

/** Event types the base template adds to every workspace; none is protected. */
export const BASE_EVENT_TYPE_IDS = {
  meeting: 'f3d0b7a2-58c1-4a8e-9d2f-6b1e0c7a4d31',
  call: '2b9e4f61-07d3-4c5a-8e1b-93f2a6d8c045',
  email: '8c1a6e37-d4b2-4f09-a5e8-1d7c3b9f2e64',
  message: '5e7f2c94-a1b8-4d36-9c0e-4f8a2d6b1e73',
  note: 'a4c8e1f6-3b72-4e95-8d1a-7c2f5b9e0d48',
} as const;

/**
 * The hidden, protected event type of the notes `remember` creates for
 * facts that cite no source (6.4). Describe, queries, views, search and
 * record routes treat it as absent; the fact represents the note.
 */
export const INTERNAL_NOTE_TYPE_ID = '6d2e9a41-c7f3-4b80-9e15-0a3c8d7f2b56';

/**
 * Built-in columns of every event record, beside its fields. Filterable and
 * sortable in queries and views; written only by `log_event`.
 */
export const EVENT_COLUMNS = ['occurredAt', 'channel', 'externalId'] as const;
export type EventColumn = (typeof EVENT_COLUMNS)[number];

export type SelectOption = {
  value: string;
  label: string;
};

/**
 * A relation is written on its owning side: `many_to_one` (`person.company`,
 * one record) or `many_to_many` (`deal.contacts`, a set of records). The
 * other side is its read-only inverse, marked `isInverse`: `one_to_many`
 * for a many_to_one field (`company.people`), `many_to_many` for a
 * many_to_many one (`person.deals`).
 */
export type RelationCardinality = 'many_to_one' | 'one_to_many' | 'many_to_many';

/** Whether a relation field is the read-only, derived side of its relation. */
export const isInverseRelation = (field: { settings: { isInverse?: boolean } }) =>
  field.settings.isInverse === true;

/** Whether a relation field holds a set of records rather than one. */
export const isCollectionRelation = (field: {
  type: string;
  settings: { relationCardinality?: RelationCardinality };
}) => field.type === 'relation' && field.settings.relationCardinality === 'many_to_many';

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
  /**
   * `relation`: set by the engine on the derived, read-only side of a
   * relation. Write the other side instead.
   */
  isInverse?: boolean;
  /**
   * `relation`, owning side: what happens when the target is deleted.
   * `cascade` is refused on many_to_many fields.
   */
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
  /** `entity` (the default) or `event`; fixed once created. */
  class?: ObjectClass;
  /** API name, camelCase singular, e.g. "person". */
  nameSingular: string;
  /** API name, camelCase plural, e.g. "people". */
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description?: string;
  /**
   * The field shown when a record is referenced, e.g. "name". Required for an
   * entity; an event type's label is always its core `title` field.
   */
  labelField?: string;
  /**
   * The object's own fields. An event type gets its core `title` and
   * `summary` fields from the schema engine; list only the others.
   */
  fields: FieldDefinition[];
};
