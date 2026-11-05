/**
 * Domain constants and stored shapes shared by the storage code. (On
 * PostgreSQL `main` these lived beside the Drizzle tables in `db/schema.ts`.)
 */

export { SCHEMA_CHANGE_STATUSES, type SchemaChangeStatus } from '@retainer/shared';
export type { AppliedTemplate, WorkspaceSettings } from './protocol.js';

export const API_KEY_SCOPES = ['read', 'write', 'schema:write', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const IDENTIFIER_KINDS = ['email', 'phone', 'domain', 'value'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * Why a participant was not matched to a record (4.1, 6.2). `ambiguous`:
 * the handle is claimed by more than one live record (1.2). `suppressed`:
 * the handle was erased by `forget` (2.1), so it is not stored.
 */
export const UNMATCHED_REASONS = [
  'no_match',
  'phone_only',
  'deleted_record',
  'ambiguous',
  'suppressed',
] as const;
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];

/**
 * How a link row ties its record to the event (1.3). `participant`: who
 * took part. `about`: a record the event concerns; it carries only `record`.
 */
export const EVENT_LINKS = ['participant', 'about'] as const;
export type EventLink = (typeof EVENT_LINKS)[number];

/**
 * `retracted`: the source event was deleted, so the assertion no longer
 * counts and can never win again (rules 2.1, 2.4).
 */
export const ASSERTION_STATUSES = [
  'active',
  'superseded',
  'pending_review',
  'rejected',
  'retracted',
] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

/**
 * Why an assertion waits for review (rule 2.3). `unique_conflict`: a
 * recomputation would have restored a value another record now claims.
 */
export type ReviewReason = 'outranked' | 'low_confidence' | 'unique_conflict';

/**
 * A view's settings as stored: every field is named by `fields.key`
 * (rule 1.4.1). The API translates to and from field names.
 */
export type StoredViewConfig = {
  filter?: Record<string, unknown>;
  sort?: { field: string; direction: 'asc' | 'desc' }[];
  columns?: {
    order: string[];
    widths?: Record<string, number>;
    aggregates?: Record<string, string>;
  };
  groupBy?: string;
  hiddenGroups?: (string | null)[];
  groupAggregate?: { field: string; op: string };
  dateField?: string;
};
