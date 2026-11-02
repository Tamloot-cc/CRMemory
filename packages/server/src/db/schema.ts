import type { Actor, FieldSettings, FieldType } from '@retainer/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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

// ---------------------------------------------------------------------------
// Tenancy and auth
// ---------------------------------------------------------------------------

export const workspaces = pgTable('workspaces', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Increments on every applied schema change. API/MCP schemas cache on it. */
  schemaVersion: integer('schema_version').notNull().default(0),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const API_KEY_SCOPES = ['read', 'write', 'schema:write', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

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
    owner: text('owner').$type<'system' | 'workspace' | 'agent'>().notNull(),
    status: text('status').$type<'active' | 'proposed' | 'deprecated'>().notNull(),
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
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('object_types_universal_uq').on(t.workspaceId, t.universalId),
    uniqueIndex('object_types_singular_uq')
      .on(t.workspaceId, t.nameSingular)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('object_types_plural_uq')
      .on(t.workspaceId, t.namePlural)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const fields = pgTable(
  'fields',
  {
    id: id(),
    workspaceId: workspaceId(),
    objectTypeId: uuid('object_type_id')
      .notNull()
      .references(() => objectTypes.id, { onDelete: 'cascade' }),
    universalId: uuid('universal_id').notNull(),
    /**
     * Short permanent key used in `records.data`. Never changes, so renaming
     * a field (changing `name`) never rewrites data.
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
    owner: text('owner').$type<'system' | 'workspace' | 'agent'>().notNull(),
    status: text('status').$type<'active' | 'proposed' | 'deprecated'>().notNull(),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('fields_universal_uq').on(t.workspaceId, t.universalId),
    uniqueIndex('fields_key_uq').on(t.objectTypeId, t.key),
    uniqueIndex('fields_name_uq').on(t.objectTypeId, t.name).where(sql`${t.deletedAt} is null`),
  ],
);

export const schemaChanges = pgTable(
  'schema_changes',
  {
    id: id(),
    workspaceId: workspaceId(),
    status: text('status').$type<'applied' | 'proposed' | 'rejected' | 'failed'>().notNull(),
    /** The operations requested, as produced by the schema engine's diff. */
    operations: jsonb('operations').$type<unknown[]>().notNull(),
    /** True when any operation is destructive (rename, type change, delete…). */
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
  (t) => [index('schema_changes_workspace_status_idx').on(t.workspaceId, t.status)],
);

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const records = pgTable(
  'records',
  {
    id: id(),
    workspaceId: workspaceId(),
    objectTypeId: uuid('object_type_id')
      .notNull()
      .references(() => objectTypes.id, { onDelete: 'cascade' }),
    /**
     * Field values keyed by `fields.key`. A cache computed from
     * `field_assertions`; it can always be rebuilt from them.
     */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    search: tsvector('search'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    updatedBy: jsonb('updated_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('records_workspace_object_idx').on(t.workspaceId, t.objectTypeId, t.createdAt),
    index('records_data_gin').using('gin', t.data),
    index('records_search_gin').using('gin', t.search),
  ],
);

/** Relations between records, one row per edge. */
export const recordLinks = pgTable(
  'record_links',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The many_to_one relation field this edge belongs to. */
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    sourceRecordId: uuid('source_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    targetRecordId: uuid('target_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('record_links_edge_uq').on(t.fieldId, t.sourceRecordId, t.targetRecordId),
    index('record_links_target_idx').on(t.targetRecordId, t.fieldId),
  ],
);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const INTERACTION_KINDS = [
  'meeting',
  'call',
  'email',
  'message',
  'note',
  'document',
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const interactions = pgTable(
  'interactions',
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text('kind').$type<InteractionKind>().notNull(),
    /** Where it came from, e.g. "gmail", "zoom", "whatsapp", "api". */
    channel: text('channel').notNull(),
    /** The source system's ID. Makes re-ingesting the same item a no-op. */
    externalId: text('external_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    title: text('title'),
    content: text('content').notNull(),
    contentFormat: text('content_format')
      .$type<'text' | 'markdown' | 'html' | 'transcript'>()
      .notNull()
      .default('text'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ingestStatus: text('ingest_status')
      .$type<'pending' | 'processing' | 'done' | 'failed'>()
      .notNull()
      .default('pending'),
    ingestError: text('ingest_error'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('interactions_external_uq')
      .on(t.workspaceId, t.channel, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('interactions_workspace_time_idx').on(t.workspaceId, t.occurredAt),
    index('interactions_pending_idx')
      .on(t.ingestStatus)
      .where(sql`${t.ingestStatus} in ('pending', 'processing')`),
  ],
);

export const interactionParticipants = pgTable(
  'interaction_participants',
  {
    id: id(),
    interactionId: uuid('interaction_id')
      .notNull()
      .references(() => interactions.id, { onDelete: 'cascade' }),
    /** Email address or E.164 phone number. */
    handle: text('handle'),
    displayName: text('display_name'),
    role: text('role').$type<'from' | 'to' | 'cc' | 'attendee' | 'speaker' | 'mentioned'>(),
    /** Set once the participant is matched to a record. */
    recordId: uuid('record_id').references(() => records.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('interaction_participants_interaction_idx').on(t.interactionId),
    index('interaction_participants_record_idx').on(t.recordId),
  ],
);

/** A claimed value for one field of one record. `records.data` is derived from these. */
export const fieldAssertions = pgTable(
  'field_assertions',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    value: jsonb('value').$type<unknown>(),
    actor: jsonb('actor').$type<Actor>().notNull(),
    sourceInteractionId: uuid('source_interaction_id').references(() => interactions.id, {
      onDelete: 'set null',
    }),
    /** 0..1. People and integrations write 1. */
    confidence: real('confidence').notNull().default(1),
    status: text('status')
      .$type<'active' | 'superseded' | 'pending_review' | 'rejected'>()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('field_assertions_record_field_idx').on(t.recordId, t.fieldId, t.createdAt),
    index('field_assertions_review_idx')
      .on(t.workspaceId)
      .where(sql`${t.status} = 'pending_review'`),
  ],
);

/** A plain-language claim about a record. Superseded, never silently deleted. */
export const facts = pgTable(
  'facts',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    kind: text('kind').$type<'stated' | 'inferred'>().notNull(),
    confidence: real('confidence').notNull().default(1),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    supersededBy: uuid('superseded_by'),
    actor: jsonb('actor').$type<Actor>().notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('facts_record_current_idx')
      .on(t.recordId, t.validFrom)
      .where(sql`${t.validTo} is null and ${t.deletedAt} is null`),
  ],
);

/** What a fact rests on: an interaction (optionally a quote) or other facts. */
export const factSources = pgTable(
  'fact_sources',
  {
    id: id(),
    factId: uuid('fact_id')
      .notNull()
      .references(() => facts.id, { onDelete: 'cascade' }),
    interactionId: uuid('interaction_id').references(() => interactions.id, {
      onDelete: 'set null',
    }),
    premiseFactId: uuid('premise_fact_id').references(() => facts.id, { onDelete: 'cascade' }),
    quote: text('quote'),
  },
  (t) => [
    index('fact_sources_fact_idx').on(t.factId),
    index('fact_sources_interaction_idx').on(t.interactionId),
  ],
);

/** A short, regenerated profile of a record; the top of every context pack. */
export const recordCards = pgTable(
  'record_cards',
  {
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    workspaceId: workspaceId(),
    content: text('content').notNull(),
    factCount: integer('fact_count').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.recordId] })],
);
