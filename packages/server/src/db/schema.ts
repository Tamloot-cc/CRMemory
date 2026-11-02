import type { Actor, FieldSettings, FieldType, SchemaOwner, SchemaStatus } from '@retainer/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Constraints Drizzle cannot express live in the custom migration
// drizzle/0001_security.sql: composite foreign keys that SET NULL a single
// column, the runtime role and its grants, row-level security policies and
// the API-key lookup function.

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const deletedAt = () => timestamp('deleted_at', { withTimezone: true });
const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

/**
 * Tenant foreign keys include `workspace_id`, so a row can only reference a
 * parent in its own workspace. Every parent has a unique `(workspace_id, id)`.
 */
function tenantFk(
  name: string,
  columns: [AnyPgColumn, AnyPgColumn],
  parent: [AnyPgColumn, AnyPgColumn],
) {
  return foreignKey({ name, columns, foreignColumns: parent }).onDelete('cascade');
}

// ---------------------------------------------------------------------------
// Tenancy and auth
// ---------------------------------------------------------------------------

export type AppliedTemplate = { name: string; version: number; appliedAt: string };

export type WorkspaceSettings = {
  /** Agent assertions below this confidence wait for review (rule 2.3). */
  confidenceThreshold?: number;
};

export const workspaces = pgTable('workspaces', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Increments on every applied schema change. API/MCP schemas cache on it. */
  schemaVersion: integer('schema_version').notNull().default(0),
  settings: jsonb('settings').$type<WorkspaceSettings>().notNull().default({}),
  /** Templates applied to this workspace, with their versions (3.1). */
  templates: jsonb('templates').$type<AppliedTemplate[]>().notNull().default([]),
  /** Set when a template (including `blank`) is first applied. */
  initializedAt: timestamp('initialized_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const API_KEY_SCOPES = ['read', 'write', 'schema:write', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * The runtime role has no access to this table; it reads keys only through
 * the SECURITY DEFINER function `retainer_lookup_api_key`.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    /** First characters of the key, shown in listings. */
    prefix: text('prefix').notNull(),
    /** SHA-256 of the full key. The key itself is never stored. */
    hash: text('hash').notNull().unique(),
    scopes: text('scopes').array().$type<ApiKeyScope[]>().notNull(),
    /** The actor every write made with this key is attributed to. */
    actor: jsonb('actor').$type<Actor>().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_keys_workspace_idx').on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// Schema (metadata)
// ---------------------------------------------------------------------------

export const objectTypes = pgTable(
  'object_types',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Same in every workspace for standard objects. */
    universalId: uuid('universal_id').notNull(),
    owner: text('owner').$type<SchemaOwner>().notNull(),
    status: text('status').$type<SchemaStatus>().notNull(),
    nameSingular: text('name_singular').notNull(),
    namePlural: text('name_plural').notNull(),
    labelSingular: text('label_singular').notNull(),
    labelPlural: text('label_plural').notNull(),
    description: text('description'),
    /** The field shown when a record is referenced (usually its name). */
    labelFieldId: uuid('label_field_id'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('object_types_workspace_id_uq').on(t.workspaceId, t.id),
    uniqueIndex('object_types_universal_uq').on(t.workspaceId, t.universalId),
    uniqueIndex('object_types_singular_uq')
      .on(t.workspaceId, t.nameSingular)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('object_types_plural_uq')
      .on(t.workspaceId, t.namePlural)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const fields = pgTable(
  'fields',
  {
    id: id(),
    workspaceId: workspaceId(),
    objectTypeId: uuid('object_type_id').notNull(),
    universalId: uuid('universal_id').notNull(),
    /**
     * Short permanent key used in `records.data`. Never changes and is never
     * reused, so renaming a field (changing `name`) never rewrites data.
     */
    key: text('key').notNull(),
    name: text('name').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    type: text('type').$type<FieldType>().notNull(),
    settings: jsonb('settings').$type<FieldSettings>().notNull().default({}),
    isNullable: boolean('is_nullable').notNull().default(true),
    isUnique: boolean('is_unique').notNull().default(false),
    isFilterable: boolean('is_filterable').notNull().default(false),
    isSearchable: boolean('is_searchable').notNull().default(false),
    owner: text('owner').$type<SchemaOwner>().notNull(),
    status: text('status').$type<SchemaStatus>().notNull(),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('fields_workspace_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'fields_object_type_fk',
      [t.workspaceId, t.objectTypeId],
      [objectTypes.workspaceId, objectTypes.id],
    ),
    uniqueIndex('fields_universal_uq').on(t.workspaceId, t.universalId),
    uniqueIndex('fields_key_uq').on(t.objectTypeId, t.key),
    uniqueIndex('fields_name_uq').on(t.objectTypeId, t.name).where(sql`${t.status} = 'active'`),
  ],
);

export const SCHEMA_CHANGE_STATUSES = ['applied', 'proposed', 'rejected', 'failed'] as const;
export type SchemaChangeStatus = (typeof SCHEMA_CHANGE_STATUSES)[number];

export const schemaChanges = pgTable(
  'schema_changes',
  {
    id: id(),
    workspaceId: workspaceId(),
    status: text('status').$type<SchemaChangeStatus>().notNull(),
    /** The operations as requested; approval re-runs the engine on these. */
    request: jsonb('request').$type<unknown[]>().notNull(),
    /** The operations produced by the schema engine's diff. */
    operations: jsonb('operations').$type<unknown[]>().notNull(),
    /** True when any operation is destructive (rename, delete, required…). */
    isDestructive: boolean('is_destructive').notNull(),
    reason: text('reason'),
    requestedBy: jsonb('requested_by').$type<Actor>().notNull(),
    decidedBy: jsonb('decided_by').$type<Actor>(),
    /** `schema_version` after this change was applied. */
    appliedVersion: integer('applied_version'),
    error: text('error'),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [index('schema_changes_workspace_status_idx').on(t.workspaceId, t.status, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const records = pgTable(
  'records',
  {
    id: id(),
    workspaceId: workspaceId(),
    objectTypeId: uuid('object_type_id').notNull(),
    /**
     * Field values keyed by `fields.key`. A cache computed from
     * `field_assertions`; it can always be rebuilt from them.
     */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** Server-computed search text (5.1); not a generated column. */
    search: tsvector('search'),
    /** The label field as plain text, for display and fuzzy lookup (5.1). */
    label: text('label'),
    /** Set when this record was merged into another (4.2). */
    mergedIntoId: uuid('merged_into_id'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    updatedBy: jsonb('updated_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique('records_workspace_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'records_object_type_fk',
      [t.workspaceId, t.objectTypeId],
      [objectTypes.workspaceId, objectTypes.id],
    ),
    index('records_workspace_object_idx').on(t.workspaceId, t.objectTypeId, t.createdAt),
    index('records_data_gin').using(
      'gin',
      t.workspaceId,
      t.objectTypeId,
      t.data.op('jsonb_path_ops'),
    ),
    index('records_search_gin').using('gin', t.workspaceId, t.search),
    index('records_label_trgm').using('gin', t.workspaceId, t.label.op('gin_trgm_ops')),
  ],
);

/** Relations between records, one row per edge, derived from assertions. */
export const recordLinks = pgTable(
  'record_links',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The many_to_one relation field this edge belongs to. */
    fieldId: uuid('field_id').notNull(),
    sourceRecordId: uuid('source_record_id').notNull(),
    targetRecordId: uuid('target_record_id').notNull(),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk('record_links_field_fk', [t.workspaceId, t.fieldId], [fields.workspaceId, fields.id]),
    tenantFk(
      'record_links_source_fk',
      [t.workspaceId, t.sourceRecordId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'record_links_target_fk',
      [t.workspaceId, t.targetRecordId],
      [records.workspaceId, records.id],
    ),
    uniqueIndex('record_links_source_field_uq').on(t.sourceRecordId, t.fieldId),
    index('record_links_target_idx').on(t.targetRecordId, t.fieldId),
  ],
);

export const IDENTIFIER_KINDS = ['email', 'phone', 'domain', 'value'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * Normalized identifiers pointing at a record (1.2): every email, phone and
 * website domain, plus the value of every `is_unique` field. A claim row
 * enforces uniqueness through one partial index, with no per-field DDL.
 */
export const recordIdentifiers = pgTable(
  'record_identifiers',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    kind: text('kind').$type<IdentifierKind>().notNull(),
    /** Canonical value: lowercased email, E.164 phone, host, or JSON text. */
    value: text('value').notNull(),
    /** True when the field is unique; claims are what the unique index covers. */
    isClaim: boolean('is_claim').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk(
      'record_identifiers_record_fk',
      [t.workspaceId, t.recordId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'record_identifiers_field_fk',
      [t.workspaceId, t.fieldId],
      [fields.workspaceId, fields.id],
    ),
    uniqueIndex('record_identifiers_claim_uq')
      .on(t.workspaceId, t.fieldId, t.value)
      .where(sql`${t.isClaim}`),
    index('record_identifiers_lookup_idx').on(t.workspaceId, t.kind, t.value),
    index('record_identifiers_record_idx').on(t.recordId, t.fieldId),
  ],
);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const INTERACTION_KINDS = ['meeting', 'call', 'email', 'message', 'note'] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

/**
 * A log of what happened, written by the agent (1.3, 4.1). Retainer stores
 * the agent's own summary, never transcripts or message bodies.
 */
export const interactions = pgTable(
  'interactions',
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text('kind').$type<InteractionKind>().notNull(),
    /** Where it came from, e.g. "gmail", "zoom", "whatsapp", "api". */
    channel: text('channel').notNull(),
    /** The source system's ID. Makes logging the same item twice a no-op. */
    externalId: text('external_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    title: text('title'),
    /** The agent's short summary of the interaction. */
    summary: text('summary'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Hash of the normalized input. Logging the same `(channel, external_id)`
     * again with the same hash returns this row; a different hash is a
     * conflict (1.3).
     */
    requestHash: text('request_hash').notNull(),
    /** Server-computed from title (weighted higher) and summary (5.1). */
    search: tsvector('search'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique('interactions_workspace_id_uq').on(t.workspaceId, t.id),
    uniqueIndex('interactions_external_uq')
      .on(t.workspaceId, t.channel, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('interactions_workspace_time_idx').on(t.workspaceId, t.occurredAt),
    index('interactions_search_gin').using('gin', t.workspaceId, t.search),
  ],
);

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

export const interactionParticipants = pgTable(
  'interaction_participants',
  {
    id: id(),
    workspaceId: workspaceId(),
    interactionId: uuid('interaction_id').notNull(),
    /** The participant's place in the logged list, so reads keep the agent's order. */
    position: integer('position').notNull(),
    /** Normalized email address or E.164 phone number. */
    handle: text('handle'),
    displayName: text('display_name'),
    /** The agent's own word for the part they played, e.g. "customer" or "from". */
    role: text('role'),
    /** Set once the participant is matched to a record. FK in 0001_security. */
    recordId: uuid('record_id'),
    /** Set when `record_id` is null: why the participant stayed unresolved. */
    unmatchedReason: text('unmatched_reason').$type<UnmatchedReason>(),
  },
  (t) => [
    tenantFk(
      'interaction_participants_interaction_fk',
      [t.workspaceId, t.interactionId],
      [interactions.workspaceId, interactions.id],
    ),
    index('interaction_participants_interaction_idx').on(t.interactionId),
    index('interaction_participants_record_idx').on(t.recordId),
    index('interaction_participants_deleted_record_idx')
      .on(t.workspaceId)
      .where(sql`${t.unmatchedReason} = 'deleted_record'`),
    check(
      'interaction_participants_unmatched_reason',
      sql`${t.unmatchedReason} in ('no_match', 'phone_only', 'deleted_record', 'ambiguous', 'suppressed')`,
    ),
  ],
);

/**
 * `retracted`: the source interaction was retracted, so the assertion no
 * longer counts and can never win again (rules 2.1, 2.4).
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

/** A claimed value for one field of one record. `records.data` is derived from these. */
export const fieldAssertions = pgTable(
  'field_assertions',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    value: jsonb('value').$type<unknown>(),
    actor: jsonb('actor').$type<Actor>().notNull(),
    /** FK in 0001_security (sets only this column to null). */
    sourceInteractionId: uuid('source_interaction_id'),
    /** 0..1. People and integrations write 1. */
    confidence: real('confidence').notNull().default(1),
    status: text('status').$type<AssertionStatus>().notNull(),
    reviewReason: text('review_reason').$type<ReviewReason>(),
    /**
     * When the claim was true at the source: the interaction's `occurred_at`,
     * or server time for direct writes. Decides ties within a precedence.
     */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    reviewedBy: jsonb('reviewed_by').$type<Actor>(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk(
      'field_assertions_record_fk',
      [t.workspaceId, t.recordId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'field_assertions_field_fk',
      [t.workspaceId, t.fieldId],
      [fields.workspaceId, fields.id],
    ),
    index('field_assertions_record_field_idx').on(t.recordId, t.fieldId, t.status),
    // Relation claims by target, for merges and forget (4.2, 2.1).
    index('field_assertions_field_idx').on(t.workspaceId, t.fieldId),
    index('field_assertions_source_idx')
      .on(t.sourceInteractionId)
      .where(sql`${t.sourceInteractionId} is not null`),
    index('field_assertions_review_idx')
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.status} = 'pending_review'`),
  ],
);

/** A plain-language claim about a record. Superseded, never silently deleted. */
export const facts = pgTable(
  'facts',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    content: text('content').notNull(),
    kind: text('kind').$type<'stated' | 'inferred'>().notNull(),
    confidence: real('confidence').notNull().default(1),
    /** When the fact became true in the world; set from the source (rule 2.6). */
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    /** FK in 0001_security (sets only this column to null). */
    supersededBy: uuid('superseded_by'),
    /** Server-computed from content (5.1). */
    search: tsvector('search'),
    actor: jsonb('actor').$type<Actor>().notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique('facts_workspace_id_uq').on(t.workspaceId, t.id),
    tenantFk('facts_record_fk', [t.workspaceId, t.recordId], [records.workspaceId, records.id]),
    // Every fact of a record, for merges and record deletion (4.2, 2.1).
    index('facts_record_idx').on(t.recordId),
    index('facts_record_current_idx')
      .on(t.recordId, t.validFrom)
      .where(sql`${t.validTo} is null and ${t.deletedAt} is null`),
    index('facts_search_gin').using('gin', t.workspaceId, t.search),
  ],
);

/** What a fact rests on: an interaction (optionally a quote) or other facts. */
export const factSources = pgTable(
  'fact_sources',
  {
    id: id(),
    workspaceId: workspaceId(),
    factId: uuid('fact_id').notNull(),
    /** FK in 0001_security (sets only this column to null). */
    interactionId: uuid('interaction_id'),
    premiseFactId: uuid('premise_fact_id'),
    quote: text('quote'),
  },
  (t) => [
    tenantFk('fact_sources_fact_fk', [t.workspaceId, t.factId], [facts.workspaceId, facts.id]),
    tenantFk(
      'fact_sources_premise_fk',
      [t.workspaceId, t.premiseFactId],
      [facts.workspaceId, facts.id],
    ),
    index('fact_sources_fact_idx').on(t.factId),
    index('fact_sources_interaction_idx').on(t.interactionId),
  ],
);

/** Suggested merges of duplicate records; a `user` actor decides (4.2). */
export const mergeSuggestions = pgTable(
  'merge_suggestions',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The pair is stored in sorted order, so each pair has one row. */
    recordAId: uuid('record_a_id').notNull(),
    recordBId: uuid('record_b_id').notNull(),
    reason: text('reason').notNull(),
    status: text('status').$type<'pending' | 'accepted' | 'dismissed'>().notNull(),
    decidedBy: jsonb('decided_by').$type<Actor>(),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    tenantFk(
      'merge_suggestions_record_a_fk',
      [t.workspaceId, t.recordAId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'merge_suggestions_record_b_fk',
      [t.workspaceId, t.recordBId],
      [records.workspaceId, records.id],
    ),
    uniqueIndex('merge_suggestions_pair_uq').on(t.workspaceId, t.recordAId, t.recordBId),
    // The pair index covers record_a; this one covers record_b (4.2).
    index('merge_suggestions_record_b_idx').on(t.workspaceId, t.recordBId),
    index('merge_suggestions_pending_idx')
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check('merge_suggestions_sorted_pair', sql`${t.recordAId} < ${t.recordBId}`),
  ],
);

/** Caller idempotency keys for create-style writes (6.2). */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    workspaceId: workspaceId(),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** The original response, stored in the same transaction as the write. */
    result: jsonb('result').$type<unknown>(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_uq').on(t.workspaceId, t.operation, t.key),
    index('idempotency_keys_expiry_idx').on(t.expiresAt),
  ],
);

/** Handles that must never be recreated after `forget` (2.1). */
export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text('kind').$type<'email' | 'phone'>().notNull(),
    /** Keyed HMAC of the normalized handle; a plain hash would be guessable. */
    hmac: text('hmac').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppressions_uq').on(t.workspaceId, t.kind, t.hmac)],
);

/** Minimal record of a hard deletion: who, when and how much, never what (2.1). */
export const deletionAuditLog = pgTable(
  'deletion_audit_log',
  {
    id: id(),
    workspaceId: workspaceId(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    counts: jsonb('counts').$type<Record<string, number>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('deletion_audit_log_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/**
 * The consolidator's last run per workspace (4.2). Workers take turns
 * through an advisory lock. `compared_until` is how far records have been
 * compared for merge suggestions, so a later run probes only newer changes.
 */
export const consolidatorRuns = pgTable('consolidator_runs', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  comparedUntil: timestamp('compared_until', { withTimezone: true }).notNull(),
  /** Counts from the last run: superseded facts, new suggestions. */
  stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
});
