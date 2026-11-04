import {
  BASE_FIELD_IDS,
  BASE_OBJECT_IDS,
  INTERNAL_NOTE_TYPE_ID,
  TASK_DONE_OPTION,
} from '@retainer/shared';

/**
 * Schema elements server code depends on (ARCHITECTURE.md 1.1). Protection
 * is set by the engine when the element is created, from these lists, and
 * no client operation can assign or clear it. Any new server dependency on
 * a schema element adds it here in the same change. An event type's core
 * fields are protected by the engine when it creates them.
 */
export const PROTECTED_OBJECT_IDS: ReadonlySet<string> = new Set([
  ...Object.values(BASE_OBJECT_IDS),
  INTERNAL_NOTE_TYPE_ID,
]);

export const PROTECTED_FIELD_IDS: ReadonlySet<string> = new Set([
  BASE_FIELD_IDS.taskStatus,
  BASE_FIELD_IDS.taskDueDate,
]);

/**
 * Select option values server code reads, by field universal ID. They
 * cannot be removed; their labels can change. Other options of the same
 * field can be added, relabeled and removed.
 */
export const PROTECTED_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  [BASE_FIELD_IDS.taskStatus, [TASK_DONE_OPTION]],
]);

/** Flags a protected field keeps: changing any of them reshapes the field. */
export const PROTECTED_FIELD_FLAGS = [
  'isNullable',
  'isUnique',
  'isFilterable',
  'isSearchable',
] as const;
