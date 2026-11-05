import { ident } from './surreal.js';

/**
 * Fixed-table definitions (spec sections 4, 5 and 7). Tables and fields are
 * applied in one transaction; every index is defined on its own statement,
 * outside a transaction, and verified before it is relied on (section 7:
 * on Cloud, a unique index defined inside a transaction accepted duplicates).
 *
 * Bump a revision when its definitions change. The runner compares actual
 * and desired definitions on every upgrade, so `OVERWRITE` is safe to rerun.
 */

export const CATALOG_REVISION = 1;
export const WORKSPACE_REVISION = 1;

export const ACTOR_TYPE = '{ type: string, id: string, name: option<string> }';
const OPT = (type: string) => (type === 'any' ? 'any' : `option<${type} | null>`);

export type IndexDefinition = {
  name: string;
  table: string;
  fields: string[];
  unique?: boolean;
  /** A full-text index: the analyzer's name. */
  fulltext?: string;
};

export type TableDefinition = {
  name: string;
  /** `RELATION` tables: allowed endpoints; empty means any record. */
  relation?: { in?: string[]; out?: string[]; enforced?: boolean };
  fields: [name: string, type: string][];
  /** Catalog tables: what the runtime record-access session may do. */
  permissions?: string;
};

export function tableStatements(table: TableDefinition): string[] {
  const kind = table.relation
    ? `TYPE RELATION${table.relation.in?.length ? ` IN ${table.relation.in.map(ident).join(' | ')}` : ''}${
        table.relation.out?.length ? ` OUT ${table.relation.out.map(ident).join(' | ')}` : ''
      }${table.relation.enforced ? ' ENFORCED' : ''}`
    : 'TYPE NORMAL';
  const statements = [
    `DEFINE TABLE OVERWRITE ${ident(table.name)} ${kind} SCHEMAFULL PERMISSIONS ${table.permissions ?? 'FULL'};`,
  ];
  for (const [name, type] of table.fields) {
    const path = name
      .split('.')
      .map((p) => (p === '*' ? '*' : ident(p)))
      .join('.');
    statements.push(
      `DEFINE FIELD OVERWRITE ${path} ON ${ident(table.name)} TYPE ${type} PERMISSIONS FULL;`,
    );
  }
  return statements;
}

export function indexStatement(index: IndexDefinition): string {
  // `name.*` indexes each element of an array field.
  const fields = index.fields
    .map((f) => (f.endsWith('.*') ? `${ident(f.slice(0, -2))}.*` : ident(f)))
    .join(', ');
  const kind = index.fulltext
    ? ` FULLTEXT ANALYZER ${ident(index.fulltext)} BM25`
    : index.unique
      ? ' UNIQUE'
      : '';
  return `DEFINE INDEX OVERWRITE ${ident(index.name)} ON ${ident(index.table)} FIELDS ${fields}${kind};`;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const CATALOG_READ = 'FOR select FULL, FOR create, update, delete NONE';

export const CATALOG_TABLES: TableDefinition[] = [
  {
    name: 'catalog_state',
    permissions: CATALOG_READ,
    fields: [['revision', 'int']],
  },
  {
    name: 'workspaces',
    permissions: CATALOG_READ,
    fields: [
      ['slug', 'string'],
      ['name', 'string'],
      ['database', 'string'],
      // provisioning → active; only active workspaces receive requests.
      ['state', 'string'],
      // Signing keys the workspace database accepts (mirrors workspace_state).
      ['access_keys', 'array<string>'],
      // The template requested at creation, so interrupted provisioning resumes.
      ['template', 'option<string | null>'],
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
    ],
  },
  {
    name: 'api_keys',
    permissions: CATALOG_READ,
    fields: [
      ['workspace', 'string'],
      ['name', 'string'],
      ['prefix', 'string'],
      ['hash', 'string'],
      ['scopes', 'array<string>'],
      ['actor', ACTOR_TYPE],
      ['created_at', 'datetime'],
      ['revoked_at', OPT('datetime')],
    ],
  },
  {
    // One process per deployment (section 9). The runtime session keeps it.
    name: 'process_lease',
    permissions: 'FULL',
    fields: [
      ['holder', 'string'],
      ['started_at', 'datetime'],
      ['heartbeat_at', 'datetime'],
      ['expires_at', 'datetime'],
    ],
  },
];

export const CATALOG_INDEXES: IndexDefinition[] = [
  { name: 'workspaces_slug_uq', table: 'workspaces', fields: ['slug'], unique: true },
  { name: 'workspaces_database_uq', table: 'workspaces', fields: ['database'], unique: true },
  { name: 'api_keys_hash_uq', table: 'api_keys', fields: ['hash'], unique: true },
  { name: 'api_keys_workspace_idx', table: 'api_keys', fields: ['workspace'] },
];

// ---------------------------------------------------------------------------
// Workspace databases
// ---------------------------------------------------------------------------

export const SEARCH_ANALYZERS = [
  // Prefixes, accent folding and email/host domain words (section 8).
  'DEFINE ANALYZER OVERWRITE rt_prefix TOKENIZERS blank, class, punct FILTERS lowercase, ascii, edgengram(1, 24);',
  // Words as typed, ranked above prefix matches.
  'DEFINE ANALYZER OVERWRITE rt_exact TOKENIZERS blank, class, punct FILTERS lowercase, ascii;',
  // Fuzzy label candidates, reranked by Jaro-Winkler.
  'DEFINE ANALYZER OVERWRITE rt_trigram TOKENIZERS blank, class, punct FILTERS lowercase, ascii, ngram(3, 3);',
];

export const WORKSPACE_TABLES: TableDefinition[] = [
  {
    // One row, `workspace_state:current`: every writer touches it (section 6).
    name: 'workspace_state',
    fields: [
      ['workspace_id', 'string'],
      ['revision', 'int'],
      ['schema_version', 'int'],
      ['mode', 'string'],
      ['schema_change', OPT('string')],
      // The persisted physical plan of a schema change in progress (section 7).
      ['plan', OPT('any')],
      ['fixed_revision', 'int'],
      ['definitions_digest', OPT('string')],
      ['access_keys', 'array<string>'],
      ['settings', 'any'],
      ['templates', 'any'],
      ['initialized_at', OPT('datetime')],
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
    ],
  },
  {
    name: 'object_types',
    fields: [
      ['universal_id', 'string'],
      ['owner', 'string'],
      ['status', 'string'],
      ['name_singular', 'string'],
      ['name_plural', 'string'],
      ['label_singular', 'string'],
      ['label_plural', 'string'],
      ['description', OPT('string')],
      ['label_field_id', OPT('string')],
      ['is_protected', 'bool'],
      ['class', 'string'],
      ['table', 'string'],
      ['seq', 'int'],
      ['created_by', ACTOR_TYPE],
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
    ],
  },
  {
    name: 'fields',
    fields: [
      ['object_type_id', 'string'],
      ['universal_id', 'string'],
      ['key', 'string'],
      ['name', 'string'],
      ['label', 'string'],
      ['description', OPT('string')],
      ['type', 'string'],
      ['settings', 'any'],
      ['is_nullable', 'bool'],
      ['is_unique', 'bool'],
      ['is_filterable', 'bool'],
      ['is_searchable', 'bool'],
      ['is_protected', 'bool'],
      ['core_role', OPT('string')],
      ['owner', 'string'],
      ['status', 'string'],
      ['seq', 'int'],
      ['created_by', ACTOR_TYPE],
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
    ],
  },
  {
    name: 'schema_changes',
    fields: [
      ['status', 'string'],
      ['request', 'any'],
      ['operations', 'any'],
      ['is_destructive', 'bool'],
      ['reason', OPT('string')],
      ['requested_by', ACTOR_TYPE],
      ['decided_by', OPT(ACTOR_TYPE)],
      ['applied_version', OPT('int')],
      ['error', OPT('string')],
      ['created_at', 'datetime'],
      ['decided_at', OPT('datetime')],
    ],
  },
  {
    // Public ID → object table, liveness and merge survivor (section 5).
    name: 'record_directory',
    fields: [
      ['object_type_id', 'string'],
      ['tb', 'string'],
      ['is_event', 'bool'],
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
      ['deleted_at', OPT('datetime')],
      ['merged_into', OPT('string')],
    ],
  },
  {
    name: 'field_assertions',
    fields: [
      ['record', 'string'],
      ['field_id', 'string'],
      ['value', 'any'],
      // Relation values: the record IDs the value points at, element-indexed
      // so a merge finds every assertion pointing at the merged record.
      ['refs', 'array<string>'],
      ['actor', ACTOR_TYPE],
      ['source', OPT('string')],
      ['is_initial', 'bool'],
      ['confidence', 'number'],
      ['status', 'string'],
      ['review_reason', OPT('string')],
      ['observed_at', 'datetime'],
      ['reviewed_by', OPT(ACTOR_TYPE)],
      ['reviewed_at', OPT('datetime')],
      ['created_at', 'datetime'],
    ],
  },
  {
    name: 'record_identifiers',
    fields: [
      ['record', 'string'],
      ['field_id', 'string'],
      ['kind', 'string'],
      ['value', 'string'],
      ['created_at', 'datetime'],
    ],
  },
  {
    // Only actual uniqueness reservations (section 5).
    name: 'unique_claims',
    fields: [
      ['record', 'string'],
      ['field_id', 'string'],
      ['value', 'string'],
      ['created_at', 'datetime'],
    ],
  },
  {
    // The shared immutable event core, one row per event record.
    name: 'event_identity',
    fields: [
      ['object_type_id', 'string'],
      ['occurred_at', 'datetime'],
      // Cleared (NONE) by erasure.
      ['channel', 'option<string>'],
      ['external_id', 'option<string>'],
      ['created_at', 'datetime'],
    ],
  },
  {
    // Canonical participant/about links, unresolved participants included.
    name: 'event_links',
    fields: [
      ['event', 'string'],
      ['position', 'int'],
      ['handle', OPT('string')],
      ['role', OPT('string')],
      ['record', OPT('string')],
      ['unmatched_reason', OPT('string')],
      ['link', 'string'],
    ],
  },
  {
    // Resolved direct attachments of events to records: participant, about
    // or one of the event's relation fields. Read by target and time.
    name: 'event_attachments',
    relation: { enforced: true },
    fields: [
      ['event', 'string'],
      ['target', 'string'],
      ['via', 'string'],
      ['field_id', OPT('string')],
      ['link_id', OPT('string')],
      ['event_type', 'string'],
      ['occurred_at', 'datetime'],
    ],
  },
  {
    // Derived one-hop rollup entries (section 5).
    name: 'rollup_attachments',
    fields: [
      ['target', 'string'],
      ['event', 'string'],
      ['event_type', 'string'],
      ['occurred_at', 'datetime'],
      ['field_id', 'string'],
      ['source', 'string'],
    ],
  },
  {
    name: 'event_identity_tombstones',
    fields: [
      ['key_id', 'string'],
      ['hmac', 'string'],
      ['created_at', 'datetime'],
    ],
  },
  {
    name: 'facts',
    fields: [
      ['record', 'string'],
      ['content', 'string'],
      ['kind', 'string'],
      ['confidence', 'number'],
      ['valid_from', 'datetime'],
      ['valid_to', OPT('datetime')],
      ['superseded_by', OPT('string')],
      ['actor', ACTOR_TYPE],
      ['created_at', 'datetime'],
      ['deleted_at', OPT('datetime')],
    ],
  },
  {
    name: 'fact_sources',
    fields: [
      ['fact', 'string'],
      ['source', OPT('string')],
      ['premise_fact', OPT('string')],
      ['quote', OPT('string')],
    ],
  },
  {
    name: 'merge_suggestions',
    fields: [
      ['record_a', 'string'],
      ['record_b', 'string'],
      ['reason', 'string'],
      ['status', 'string'],
      ['decided_by', OPT(ACTOR_TYPE)],
      ['created_at', 'datetime'],
      ['decided_at', OPT('datetime')],
    ],
  },
  {
    name: 'views',
    fields: [
      ['object_type_id', 'string'],
      ['name', 'string'],
      ['kind', 'string'],
      ['visibility', 'string'],
      ['position', 'number'],
      ['config', 'any'],
      ['created_by', ACTOR_TYPE],
      ['updated_by', ACTOR_TYPE],
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
    ],
  },
  {
    // Operation receipts (section 7): every public mutation has one.
    name: 'operations',
    fields: [
      ['kind', 'string'],
      ['idempotency_key', 'option<string>'],
      ['request_hash', OPT('string')],
      ['status', 'string'],
      ['result', 'any'],
      // Records the result mentions, so erasure can sanitize it.
      ['refs', 'array<string>'],
      ['created_at', 'datetime'],
      ['expires_at', 'datetime'],
    ],
  },
  {
    name: 'suppressions',
    fields: [
      ['kind', 'string'],
      ['hmac', 'string'],
      ['created_at', 'datetime'],
    ],
  },
  {
    name: 'deletion_audit_log',
    fields: [
      ['actor_type', 'string'],
      ['actor_id', 'string'],
      ['counts', 'any'],
      ['created_at', 'datetime'],
    ],
  },
  {
    name: 'consolidator_runs',
    fields: [
      ['started_at', 'datetime'],
      ['compared_until', 'datetime'],
      ['stats', 'any'],
    ],
  },
  {
    // Durable jobs (section 9): resumed after a restart.
    name: 'jobs',
    fields: [
      ['kind', 'string'],
      ['payload', 'any'],
      ['status', 'string'],
      ['attempts', 'int'],
      ['run_after', 'datetime'],
      ['last_error', OPT('string')],
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
    ],
  },
  {
    // Rebuildable search projection (section 8): one row per visible record
    // or fact. `owner` is the record a fact belongs to, or the record itself.
    name: 'search_documents',
    fields: [
      ['kind', 'string'],
      ['owner', 'string'],
      ['object_type_id', 'string'],
      ['label', OPT('string')],
      // The label, folded: label prefix matches rank first.
      ['label_text', 'string'],
      // Label and searchable body text: prefix matches through the index.
      ['all_text', 'string'],
      // The same text for the exact-word index.
      ['folded', 'string'],
      // The label for trigram (fuzzy) candidates.
      ['grams', 'string'],
      ['updated_at', 'datetime'],
    ],
  },
];

export const WORKSPACE_INDEXES: IndexDefinition[] = [
  { name: 'object_types_universal_uq', table: 'object_types', fields: ['universal_id'], unique: true },
  { name: 'fields_universal_uq', table: 'fields', fields: ['universal_id'], unique: true },
  { name: 'fields_key_uq', table: 'fields', fields: ['object_type_id', 'key'], unique: true },
  { name: 'schema_changes_status_idx', table: 'schema_changes', fields: ['status', 'created_at'] },
  {
    name: 'record_directory_object_idx',
    table: 'record_directory',
    fields: ['object_type_id', 'created_at'],
  },
  { name: 'record_directory_merged_idx', table: 'record_directory', fields: ['merged_into'] },
  { name: 'record_directory_updated_idx', table: 'record_directory', fields: ['updated_at'] },
  {
    name: 'field_assertions_record_idx',
    table: 'field_assertions',
    fields: ['record', 'field_id', 'status'],
  },
  { name: 'field_assertions_field_idx', table: 'field_assertions', fields: ['field_id'] },
  { name: 'field_assertions_source_idx', table: 'field_assertions', fields: ['source'] },
  { name: 'field_assertions_refs_idx', table: 'field_assertions', fields: ['refs.*'] },
  {
    name: 'field_assertions_review_idx',
    table: 'field_assertions',
    fields: ['status', 'created_at'],
  },
  {
    name: 'record_identifiers_lookup_idx',
    table: 'record_identifiers',
    fields: ['kind', 'value'],
  },
  {
    name: 'record_identifiers_record_idx',
    table: 'record_identifiers',
    fields: ['record', 'field_id'],
  },
  {
    name: 'record_identifiers_field_idx',
    table: 'record_identifiers',
    fields: ['field_id', 'value'],
  },
  {
    name: 'unique_claims_uq',
    table: 'unique_claims',
    fields: ['field_id', 'value'],
    unique: true,
  },
  { name: 'unique_claims_record_idx', table: 'unique_claims', fields: ['record', 'field_id'] },
  // A NONE external ID never collides, so only identified events reserve.
  {
    name: 'event_identity_external_uq',
    table: 'event_identity',
    fields: ['channel', 'external_id'],
    unique: true,
  },
  { name: 'event_identity_time_idx', table: 'event_identity', fields: ['occurred_at'] },
  {
    name: 'event_identity_type_time_idx',
    table: 'event_identity',
    fields: ['object_type_id', 'occurred_at'],
  },
  { name: 'event_links_event_idx', table: 'event_links', fields: ['event', 'position'] },
  { name: 'event_links_record_idx', table: 'event_links', fields: ['record', 'link'] },
  { name: 'event_links_unmatched_idx', table: 'event_links', fields: ['unmatched_reason'] },
  { name: 'event_links_handle_idx', table: 'event_links', fields: ['handle'] },
  {
    name: 'event_attachments_target_idx',
    table: 'event_attachments',
    fields: ['target', 'occurred_at'],
  },
  { name: 'event_attachments_event_idx', table: 'event_attachments', fields: ['event'] },
  {
    name: 'event_attachments_uq',
    table: 'event_attachments',
    fields: ['event', 'target', 'via', 'field_id', 'link_id'],
    unique: true,
  },
  {
    name: 'rollup_attachments_target_idx',
    table: 'rollup_attachments',
    fields: ['target', 'occurred_at'],
  },
  { name: 'rollup_attachments_source_idx', table: 'rollup_attachments', fields: ['source'] },
  { name: 'rollup_attachments_event_idx', table: 'rollup_attachments', fields: ['event'] },
  {
    name: 'rollup_attachments_uq',
    table: 'rollup_attachments',
    fields: ['target', 'event', 'field_id', 'source'],
    unique: true,
  },
  {
    name: 'event_identity_tombstones_uq',
    table: 'event_identity_tombstones',
    fields: ['key_id', 'hmac'],
    unique: true,
  },
  { name: 'facts_record_idx', table: 'facts', fields: ['record', 'valid_from'] },
  { name: 'facts_created_idx', table: 'facts', fields: ['created_at'] },
  { name: 'fact_sources_fact_idx', table: 'fact_sources', fields: ['fact'] },
  { name: 'fact_sources_source_idx', table: 'fact_sources', fields: ['source'] },
  {
    name: 'merge_suggestions_pair_uq',
    table: 'merge_suggestions',
    fields: ['record_a', 'record_b'],
    unique: true,
  },
  { name: 'merge_suggestions_b_idx', table: 'merge_suggestions', fields: ['record_b'] },
  {
    name: 'merge_suggestions_status_idx',
    table: 'merge_suggestions',
    fields: ['status', 'created_at'],
  },
  { name: 'views_object_idx', table: 'views', fields: ['object_type_id', 'position'] },
  {
    name: 'operations_key_uq',
    table: 'operations',
    fields: ['kind', 'idempotency_key'],
    unique: true,
  },
  { name: 'operations_expiry_idx', table: 'operations', fields: ['expires_at'] },
  { name: 'operations_refs_idx', table: 'operations', fields: ['refs.*'] },
  { name: 'suppressions_uq', table: 'suppressions', fields: ['kind', 'hmac'], unique: true },
  { name: 'deletion_audit_log_idx', table: 'deletion_audit_log', fields: ['created_at'] },
  { name: 'jobs_status_idx', table: 'jobs', fields: ['status', 'run_after'] },
  { name: 'search_documents_owner_idx', table: 'search_documents', fields: ['owner'] },
  {
    name: 'search_documents_type_idx',
    table: 'search_documents',
    fields: ['object_type_id', 'kind'],
  },
  {
    name: 'search_all_prefix',
    table: 'search_documents',
    fields: ['all_text'],
    fulltext: 'rt_prefix',
  },
  {
    name: 'search_all_exact',
    table: 'search_documents',
    fields: ['folded'],
    fulltext: 'rt_exact',
  },
  {
    name: 'search_label_prefix',
    table: 'search_documents',
    fields: ['label_text'],
    fulltext: 'rt_prefix',
  },
  {
    name: 'search_label_trigram',
    table: 'search_documents',
    fields: ['grams'],
    fulltext: 'rt_trigram',
  },
];
