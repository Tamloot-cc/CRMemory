import { type FieldType, INTERNAL_NOTE_TYPE_ID, MULTI_VALUE_TYPES } from '@retainer/shared';
import type { FieldState, ObjectState, SchemaIssue, SchemaState } from './types.js';

const NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,62}$/;

const reserved = (names: string[], reason: string) => names.map((name) => [name, reason] as const);

/**
 * Object names that would be confused with API resources, each with the
 * reason the validation error gives. Events and facts are built in,
 * so their reason says what to use instead: an agent told only "reserved"
 * renames its object and builds a twin of the built-in feature.
 */
export const RESERVED_OBJECT_NAMES: ReadonlyMap<string, string> = new Map([
  ...reserved(
    ['interaction', 'interactions', 'event', 'events'],
    'meetings, calls, emails and messages are event types (class "event"): log them with ' +
      'log_event (or POST /v1/events), or create your own event type with class "event"',
  ),
  ...reserved(
    ['internalNote', 'internalNotes'],
    'it names the notes remember creates for facts with no source',
  ),
  ...reserved(
    ['fact', 'facts'],
    'facts are built in: store one-off knowledge about a record with remember ' +
      '(or POST /v1/records/:id/facts) instead of creating an object',
  ),
  ...reserved(
    [
      'assertion',
      'assertions',
      'context',
      'field',
      'fields',
      'object',
      'objects',
      'record',
      'records',
      'review',
      'schema',
      'search',
      'template',
      'templates',
      'workspace',
      'workspaces',
    ],
    'it names a built-in API resource',
  ),
]);

/** Field names taken by built-in record columns and response keys. */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'id',
  'object',
  'label',
  'fields',
  'links',
  'data',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'createdBy',
  'updatedBy',
  'mergedIntoId',
]);

/** Field names an event type cannot use: its built-in columns and links (6.1, 6.2). */
export const RESERVED_EVENT_FIELD_NAMES: ReadonlySet<string> = new Set([
  'type',
  'occurredAt',
  'channel',
  'externalId',
  'participants',
  'about',
  'event',
  'via',
]);

/**
 * Types that can be unique. Each has a canonical form for
 * `record_identifiers`; phones are excluded because numbers are shared and
 * reassigned.
 */
export const UNIQUE_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  'text',
  'number',
  'date',
  'emails',
]);

/** Types whose value reads well as a record's label. */
export const LABEL_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  'text',
  'full_name',
  'emails',
  'phones',
  'links',
  'number',
  'date',
  'date_time',
  'select',
]);

/**
 * Step 3 of the engine: checks the desired schema as a whole. Returns every
 * issue rather than the first, so a template collision lists all of them.
 */
export function validateSchema(state: SchemaState): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  const active = state.objects.filter((o) => o.status === 'active');
  const byUniversalId = new Map(state.objects.map((o) => [o.universalId, o]));

  // Singular and plural names share one namespace.
  const names = new Map<string, string>();
  for (const object of active) {
    for (const name of new Set([object.nameSingular, object.namePlural])) {
      const owner = names.get(name);
      if (owner) {
        issue(object.nameSingular, `object name "${name}" is already used by ${owner}`);
      } else {
        names.set(name, object.nameSingular);
      }
    }
  }

  for (const object of active) {
    const path = object.nameSingular;
    const internal = object.universalId === INTERNAL_NOTE_TYPE_ID;
    for (const name of [object.nameSingular, object.namePlural]) {
      if (!NAME_PATTERN.test(name)) {
        issue(path, `"${name}" must be camelCase: a lowercase letter, then letters and digits`);
      } else if (RESERVED_OBJECT_NAMES.has(name) && !internal) {
        issue(path, `"${name}" is reserved: ${RESERVED_OBJECT_NAMES.get(name)}`);
      }
    }
    if (object.nameSingular === object.namePlural) {
      issue(path, 'nameSingular and namePlural must differ');
    }

    const fieldNames = new Set<string>();
    for (const field of object.fields) {
      if (field.status !== 'active') continue;
      if (fieldNames.has(field.name)) {
        issue(`${path}.${field.name}`, `field name "${field.name}" is already used on ${path}`);
      }
      fieldNames.add(field.name);
      validateField(object, field, byUniversalId, issue);
    }

    if (object.class === 'event') validateEventCore(object, issue);
    const labelField = object.fields.find((f) => f.universalId === object.labelFieldId);
    if (labelField?.status !== 'active') {
      issue(path, 'labelField must be an active field of the object');
    } else if (!LABEL_FIELD_TYPES.has(labelField.type)) {
      issue(
        path,
        `labelField cannot be a ${labelField.type} field; use one of: ${[...LABEL_FIELD_TYPES].join(', ')}`,
      );
    }
  }

  return issues;
}

/**
 * An event type has exactly one active title and one active summary field,
 * protected text fields, and its title is its label field (6.1). Entities
 * have no core fields.
 */
function validateEventCore(
  object: ObjectState,
  issue: (path: string, message: string) => void,
): void {
  for (const role of ['title', 'summary'] as const) {
    const core = object.fields.filter((f) => f.status === 'active' && f.coreRole === role);
    if (core.length !== 1 || core[0]?.type !== 'text' || !core[0]?.isProtected) {
      issue(object.nameSingular, `an event type needs exactly one protected ${role} field`);
    }
  }
  const title = object.fields.find((f) => f.status === 'active' && f.coreRole === 'title');
  if (title && object.labelFieldId !== title.universalId) {
    issue(object.nameSingular, "an event type's labelField is always its title");
  }
}

function validateField(
  object: ObjectState,
  field: FieldState,
  objects: Map<string, ObjectState>,
  issue: (path: string, message: string) => void,
): void {
  const path = `${object.nameSingular}.${field.name}`;
  const { settings } = field;

  if (!NAME_PATTERN.test(field.name)) {
    issue(path, `"${field.name}" must be camelCase: a lowercase letter, then letters and digits`);
  } else if (RESERVED_FIELD_NAMES.has(field.name)) {
    issue(path, `"${field.name}" is reserved for a built-in record property`);
  } else if (object.class === 'event' && RESERVED_EVENT_FIELD_NAMES.has(field.name)) {
    issue(path, `"${field.name}" is reserved for a built-in event property`);
  }
  if (field.coreRole && object.class !== 'event') {
    issue(path, 'only an event type has core fields');
  }

  if (field.type === 'select' || field.type === 'multi_select') {
    const options = settings.options ?? [];
    if (options.length === 0) issue(path, 'a select field needs at least one option');
    const values = new Set<string>();
    for (const option of options) {
      if (values.has(option.value)) issue(path, `option "${option.value}" is listed twice`);
      values.add(option.value);
    }
  } else if (settings.options) {
    issue(path, 'options apply only to select and multi_select fields');
  }

  if (settings.maxValues !== undefined && !MULTI_VALUE_TYPES.has(field.type)) {
    issue(path, 'maxValues applies only to emails, phones and links fields');
  }

  if (field.isUnique && !UNIQUE_FIELD_TYPES.has(field.type)) {
    issue(
      path,
      field.type === 'phones'
        ? 'phones cannot be unique: numbers are shared and reassigned'
        : `a ${field.type} field cannot be unique; unique types: ${[...UNIQUE_FIELD_TYPES].join(', ')}`,
    );
  }

  if (field.type !== 'relation') return;

  const target = settings.targetObjectId ? objects.get(settings.targetObjectId) : undefined;
  if (target?.status !== 'active') {
    issue(path, 'the relation target object does not exist or was deleted');
    return;
  }
  const inverse = settings.inverseFieldId
    ? target.fields.find((f) => f.universalId === settings.inverseFieldId)
    : undefined;

  if (settings.relationCardinality === 'many_to_one') {
    if (settings.inverseFieldId && inverse?.status !== 'active') {
      issue(path, 'the inverse field of this relation is missing');
    }
    if (inverse && inverse.settings.inverseFieldId !== field.universalId) {
      issue(path, 'the inverse field does not point back at this relation');
    }
  } else if (settings.relationCardinality === 'one_to_many') {
    if (inverse?.status !== 'active') {
      issue(path, 'an inverse relation needs an active many_to_one field on the other side');
    } else if (inverse.settings.relationCardinality !== 'many_to_one') {
      issue(path, 'the other side of an inverse relation must be many_to_one');
    }
    if (!field.isNullable) issue(path, 'an inverse relation field cannot be required');
  } else {
    issue(path, 'relationCardinality must be many_to_one or one_to_many');
  }
}
