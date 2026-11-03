import type { Actor } from './actor.js';
import type { FieldType, MoneyValue } from './field-types.js';
import type {
  FieldDefinition,
  FieldSettings,
  ObjectDefinition,
  SchemaChangeStatus,
  SchemaOwner,
  SelectOption,
} from './schema.js';
export type Scope = 'read' | 'write' | 'schema:write' | 'admin';
export type Session = {
  workspace: { id: string; name: string; slug: string };
  actor: Actor;
  scopes: Scope[];
};
export type FieldView = Omit<FieldDefinition, 'description' | 'settings'> & {
  description: string | null;
  settings: FieldSettings;
  readOnly: boolean;
  owner: SchemaOwner;
  isNullable: boolean;
  isUnique: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
};
export type ObjectView = {
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description: string | null;
  labelField: string | null;
  owner: SchemaOwner;
  fields: FieldView[];
};
export type SchemaDescription = {
  workspace: Session['workspace'] & {
    schemaVersion: number;
    initialized: boolean;
    templates: { name: string; version: number; appliedAt: string }[];
  };
  objects: ObjectView[];
  /**
   * What Retainer stores besides records (1.3): interactions and facts. Fixed
   * by Retainer and written only through their own tools, never upsert_record.
   */
  builtIns: BuiltInView[];
};
/** A built-in part of every workspace's memory, as describe_schema lists it. */
export type BuiltInView = {
  name: 'interaction' | 'fact';
  labelSingular: string;
  labelPlural: string;
  description: string;
  fields: { name: string; type: string; description: string }[];
  /** The MCP tools (and REST routes) that write it. */
  writeWith: string[];
  /** The MCP tools (and REST routes) that read it. */
  readWith: string[];
};
export type RecordReference = { id: string; object: string; label: string | null };
export type SourceReference = { id: string; title: string | null; occurredAt: string };
export type AssertionView = {
  id: string;
  recordId: string;
  object: string;
  recordLabel: string | null;
  field: string;
  value: unknown;
  currentValue: unknown;
  status: 'active' | 'superseded' | 'pending_review' | 'rejected' | 'retracted';
  reason: 'outranked' | 'low_confidence' | 'unique_conflict' | null;
  actor: Actor;
  confidence: number;
  sourceInteractionId: string | null;
  observedAt: string;
  createdAt: string;
  source: SourceReference | null;
  conflictingRecord: RecordReference | null;
  relationReferences?: Record<string, RecordReference>;
  reviewedBy: Actor | null;
  reviewedAt: string | null;
};
export type Provenance = {
  pendingAssertion?: AssertionView | null;
  assertion: AssertionView | null;
  pendingAssertionIds: string[];
};
export type PresentedRecord = {
  id: string;
  object: string;
  label: string | null;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  updatedBy: Actor;
  provenance?: Record<string, Provenance>;
  relationReferences?: Record<string, RecordReference>;
};
export type WriteResponse = {
  id: string;
  created: boolean;
  fields: Record<string, 'applied' | 'pending_review' | 'superseded'>;
  record: PresentedRecord;
};
export type QueryInput = {
  search?: string;
  filter?: Record<string, unknown>;
  sort?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  cursor?: string;
  include?: string[];
};
export type RecordPage = {
  records: PresentedRecord[];
  nextCursor: string | null;
  relationReferences?: Record<string, RecordReference>;
};
export type DecisionResult = {
  assertionId: string;
  status: 'accepted' | 'rejected';
  fields?: WriteResponse['fields'];
  record: PresentedRecord;
};
export type UnresolvedParticipant = {
  interactionId: string;
  position: number;
  handle: string | null;
  role: string | null;
  occurredAt: string;
  title: string | null;
  deletedRecordIds: string[];
};
export type MergeSuggestion = {
  id: string;
  recordIds: [string, string];
  /** The two records' object and label, for live records only (7.2, rule 3). */
  records: RecordReference[];
  reason: string;
  createdAt: string;
};
/** `POST /v1/records/:id/merge` (4.2). */
export type MergeResult = {
  /** The surviving record. */
  id: string;
  /** The record merged into it; reads of it now return the survivor. */
  mergedId: string;
  /** False when it was already merged into the survivor (idempotent by state). */
  merged: boolean;
  /** Other records whose relations to the merged record now point at the survivor. */
  recomputedRecordIds: string[];
  record: PresentedRecord;
};
/** `GET /v1/records/:id/delete-impact`: the other records a delete would take with it. */
export type DeleteImpact = {
  id: string;
  /** Records deleted through cascading relations, at any depth, counted by object. */
  records: { object: string; count: number }[];
};
/** `POST /v1/records/delete-impact`: the same for several records deleted together. */
export type BulkDeleteImpact = {
  /** The records asked about, after following merges. */
  ids: string[];
  /** Other records the deletes would take with them, counted by object. */
  records: { object: string; count: number }[];
};
/** `POST /v1/review/merges/:id/dismiss`. */
export type MergeSuggestionDecision = {
  id: string;
  status: 'dismissed';
};
/** `POST /v1/records/:id/forget` (2.1): counts only, never erased content. */
export type ForgetResult = {
  id: string;
  forgotten: true;
  counts: {
    records: number;
    interactions: number;
    facts: number;
    assertions: number;
    inboundRelations: number;
    suppressedHandles: number;
  };
  /** Records whose values were recomputed after their claims or links were removed. */
  recomputedRecordIds: string[];
  /**
   * Live rows that may still mention the person, found by name and handle
   * search before deletion. Not a guarantee: a person reviews them.
   */
  reviewCandidates: { records: string[]; facts: string[]; interactions: string[] };
};
export type ReviewCollection = 'pendingAssertions' | 'unresolvedParticipants' | 'mergeSuggestions';
export type ReviewQueue = {
  pendingAssertions: AssertionView[];
  unresolvedParticipants: UnresolvedParticipant[];
  mergeSuggestions: MergeSuggestion[];
  totals: Record<ReviewCollection, number>;
  nextCursors: Record<ReviewCollection, string | null>;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PresentedFact = {
  status?: 'current' | 'retracted' | 'superseded' | 'ended';
  id: string;
  record: string;
  content: string;
  kind: 'stated' | 'inferred';
  validFrom: string;
  validTo: string | null;
  writtenBy: Actor;
  sources: { interaction: string; quote: string | null }[];
};
export type InteractionKind = 'meeting' | 'call' | 'email' | 'message' | 'note';
export type UnmatchedReason =
  | 'no_match'
  | 'phone_only'
  | 'deleted_record'
  | 'ambiguous'
  | 'suppressed';
export type MatchedParticipant = {
  /** The participant link's ID, for `DELETE /v1/interactions/:id/participants/:participantId`. */
  id: string;
  handle: string | null;
  role: string | null;
  recordId: string;
};
export type UnmatchedParticipant = {
  id: string;
  handle: string | null;
  role: string | null;
  reason: UnmatchedReason;
  candidates?: string[];
};
export type Participant = MatchedParticipant | UnmatchedParticipant;
export type Participants = { matched: MatchedParticipant[]; unmatched: UnmatchedParticipant[] };
export type PresentedInteraction = {
  id: string;
  kind: InteractionKind;
  channel: string;
  externalId: string | null;
  occurredAt: string;
  title: string | null;
  summary: string | null;
  /** Who took part. */
  participants: Participants;
  /** Records the interaction concerns, e.g. a meeting's company or project (1.3). */
  about: string[];
  createdBy: Actor;
  createdAt: string;
};
/** `POST /v1/interactions/query` input (5): filters on the interaction log. */
export type InteractionQueryInput = {
  filter?: {
    kind?: InteractionKind | InteractionKind[];
    channel?: string | string[];
    externalId?: string;
    occurredAt?: { gt?: string; gte?: string; lt?: string; lte?: string };
    /** Interactions linked to this record, as a participant or `about` it. */
    record?: string;
    /** With `record`: only that kind of link. */
    link?: 'participant' | 'about';
  };
  order?: 'newest' | 'oldest';
  /** Also count every matching interaction by kind or channel. */
  countBy?: 'kind' | 'channel';
  limit?: number;
  cursor?: string;
};
export type InteractionQueryResult = {
  items: PresentedInteraction[];
  nextCursor: string | null;
  /** All matching interactions, not only this page. */
  total: number;
  counts?: Record<string, number>;
};
/** What a write added to an interaction's participants and `about` records. */
export type AddedLinks = { participants: Participants; about: string[] };
/** `POST /v1/interactions` result (6.2); `added` is set when it was logged before. */
export type LogInteractionResult = {
  id: string;
  created: boolean;
  participants: Participants;
  about: string[];
  added?: AddedLinks;
};
export type RetractInteractionResult = {
  id: string;
  deleted: true;
  retractedAssertions: number;
  recomputedRecordIds: string[];
  hiddenFactIds: string[];
};
export type SchemaChange = {
  id: string;
  status: SchemaChangeStatus;
  operations: { kind: string; [key: string]: unknown }[];
  request: SchemaOperation[];
  isDestructive: boolean;
  reason: string | null;
  requestedBy: Actor;
  decidedBy: Actor | null;
  appliedVersion: number | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
};
/** Public request operations; the schema engine remains the validator. */
export type SchemaOperation =
  | { op: 'create_object'; object: ObjectDefinition }
  | {
      op: 'update_object';
      object: string;
      labelSingular?: string;
      labelPlural?: string;
      description?: string | null;
      labelField?: string;
    }
  | { op: 'rename_object'; object: string; nameSingular: string; namePlural: string }
  | { op: 'delete_object'; object: string }
  | { op: 'create_field'; object: string; field: FieldDefinition }
  | ({ op: 'update_field'; object: string; field: string; description?: string | null } & Partial<
      Pick<
        FieldDefinition,
        'label' | 'isNullable' | 'isUnique' | 'isFilterable' | 'isSearchable' | 'type'
      >
    >)
  | { op: 'rename_field'; object: string; field: string; name: string }
  | { op: 'delete_field'; object: string; field: string }
  | { op: 'add_option'; object: string; field: string; option: SelectOption }
  | { op: 'update_option'; object: string; field: string; value: string; label: string }
  | { op: 'remove_option'; object: string; field: string; value: string };
export type SchemaChangeResult = {
  status: SchemaChangeStatus | 'unchanged';
  change: SchemaChange | null;
  schemaVersion: number;
  recordIds?: string[];
  alreadyApplied?: boolean;
};
export type TemplateView = {
  name: string;
  version: number;
  label: string;
  description: string;
  applied: boolean;
  adds: {
    objects: { name: string; fields: string[] }[];
    fields: { object: string; field: string }[];
  };
};
/** `POST /v1/search` input (5.1), in Postgres `websearch_to_tsquery` syntax. */
export type SearchInput = { query: string; limit?: number };
export type RecordHit = {
  id: string;
  object: string;
  label: string | null;
  /** `text`: a full-text match. `similar_label`: the fuzzy fallback on the label. */
  match: 'text' | 'similar_label';
};
export type FactHit = { id: string; record: string; content: string; validFrom: string };
export type InteractionHit = {
  id: string;
  kind: string;
  occurredAt: string;
  title: string | null;
  summary: string | null;
  /** Live records linked to it, as participants or `about`; possibly none or several. */
  records: string[];
};
/** Each list is ranked on its own; scores are not comparable across lists. */
export type SearchResult = {
  records: RecordHit[];
  facts: FactHit[];
  interactions: InteractionHit[];
};
/** `GET /v1/records/:id/context` input (6.2). */
export type ContextInput = { tokenBudget?: number };
/** A current field value with who wrote it and when it was true at the source. */
export type ContextField = { value: unknown; writtenBy: Actor; observedAt: string };
export type OpenTask = {
  id: string;
  title: string | null;
  status: unknown;
  dueDate: unknown;
};
export type ContextFact = {
  id: string;
  content: string;
  validFrom: string;
  writtenBy: Actor;
  /** Live interactions the fact rests on. */
  sources: string[];
};
export type ContextInteraction = {
  id: string;
  kind: string;
  occurredAt: string;
  title: string | null;
  summary: string | null;
  /** How the record is linked: it took part, or the interaction is about it. */
  via: 'participant' | 'about';
};
export type ContextPack = {
  record: {
    id: string;
    object: string;
    label: string | null;
    fields: Record<string, ContextField>;
  };
  openTasks: OpenTask[];
  facts: ContextFact[];
  recentInteractions: ContextInteraction[];
  /** Items of each section left out to fit the budget. */
  omitted: { openTasks: number; facts: number; recentInteractions: number };
  tokenEstimate: number;
};
/** `POST /v1/records/:id/merge` input (4.2). */
export type MergeInput = {
  /** The record merged into the one in the path; it is soft-deleted. */
  recordId: string;
  /** Values the survivor should end with, by field name. */
  values?: Record<string, unknown>;
};
/**
 * What a list footer can compute over the records a filter matches. Counts
 * and percentages work on every field a record holds; the rest depend on the
 * type (`aggregateOps`).
 */
export const AGGREGATE_OPS = [
  'countEmpty',
  'countNotEmpty',
  'percentEmpty',
  'percentNotEmpty',
  'countUnique',
  'sum',
  'avg',
  'min',
  'max',
] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];
const EMPTINESS: AggregateOp[] = ['countEmpty', 'countNotEmpty', 'percentEmpty', 'percentNotEmpty'];
/** The aggregates a field supports; none for an inverse (one-to-many) relation. */
export function aggregateOps(field: {
  type: FieldType;
  settings: { relationCardinality?: string };
}): AggregateOp[] {
  if (field.settings.relationCardinality === 'one_to_many') return [];
  const ops = [...EMPTINESS];
  if (field.type === 'relation' || SORTABLE_TYPES.includes(field.type)) ops.push('countUnique');
  if (field.type === 'number' || field.type === 'money') ops.push('sum', 'avg');
  // The ordered types, which take `gt` and `lt` filters.
  if (FILTER_OPERATORS[field.type].includes('gt')) ops.push('min', 'max');
  return ops;
}
/** `POST /v1/objects/:object/aggregate`. */
export type AggregateInput = {
  search?: string;
  filter?: Record<string, unknown>;
  aggregates?: { field: string; op: AggregateOp }[];
};
export type AggregateValue = {
  field: string;
  op: AggregateOp;
  /**
   * A count; a percentage from 0 to 100; a number; a `money` value; or a date
   * or date-time string for `min` and `max` of dates. Null when there is
   * nothing to compute over, or for money in more than one currency.
   */
  value: number | string | MoneyValue | null;
  /** Money values in several currencies are not added up. */
  mixedCurrencies?: true;
};
export type AggregateResult = { total: number; values: AggregateValue[] };

export const SORTABLE_TYPES: readonly FieldType[] = [
  'text',
  'number',
  'boolean',
  'date',
  'date_time',
  'select',
];
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'isNull';
export const FILTER_OPERATORS: Record<FieldType, readonly FilterOperator[]> = {
  text: ['eq', 'neq', 'in', 'contains'],
  number: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['eq', 'neq'],
  date: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
  date_time: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  select: ['eq', 'neq', 'in'],
  multi_select: ['contains'],
  money: ['gt', 'gte', 'lt', 'lte'],
  emails: ['eq'],
  phones: ['eq'],
  links: ['eq'],
  full_name: ['contains'],
  address: ['contains'],
  relation: ['eq', 'in'],
  json: [],
};
