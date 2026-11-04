# Schema expressiveness, event types and record history: merged spec

Status: **proposed; not implemented**. Written November 4, 2026.

This is the consolidated implementation proposal for
[event types and history](event-types-and-history-spec.md) and the priorities
identified by the [schema coverage assessment](schema-expressiveness-coverage.md).
It supersedes the earlier event proposal as a plan. The coverage assessment
remains the research record; its candidate additions are not all commitments.
[ARCHITECTURE.md](../ARCHITECTURE.md) describes implemented behavior until each
phase updates it. This document makes no new claims about vendor coverage.

## 1. Goal and scope

Agents should be able to define useful CRM structures, log typed evidence and
retrieve a record's history through a coherent schema and API.

The committed scope is:

- Extensible event types stored as records, replacing fixed interactions.
- Protection of schema elements that server behavior depends on.
- Native multi-record relation fields, followed by polymorphic references.
- Explicit event links and opt-in, one-hop event rollups.
- A unified record timeline through REST, MCP, SDK and the web app.

List-scoped fields, configurable composites, association labels, one-to-one
constraints, optional base objects and assertion premises have explicit
dispositions below. They do not block this scope.

Retainer is in early exploration. The original proposal assumes no deployed
user data needs preserving; verify that assumption before implementation.
Under that assumption, storage and API changes need no compatibility shims or
backfills. This does not waive the product guarantee that a workspace's own
schema edits preserve its data under the existing schema evolution rules.

## 2. Current implementation baseline

The source documents assessed the implementation on November 4, 2026:

- Objects have runtime-defined fields, but no entity/event class.
- Writable relations are many-to-one, target one object type and hold one
  record ID. Their one-to-many inverses are read-only.
- `record_links` is derived from relation assertions. Its unique index permits
  one edge per source record and field.
- Interactions have separate storage, fixed fields and special participant
  and `about` links. Those links can connect to multiple records.
- Facts cite interactions. `remember` creates an internal note when the agent
  supplies no source. Field writes can also be direct, without an interaction.
- Person, company and task cannot be deleted. Most base fields can be altered,
  including fields the context builder depends on.
- REST exposes assertion history; MCP has no equivalent record timeline.
- The consolidator deduplicates facts and suggests record merges. It does not
  infer facts or repair links through a model.

Implementation anchors: [relation metadata](../packages/shared/src/schema.ts),
[database tables](../packages/server/src/db/schema.ts),
[schema engine](../packages/server/src/schema-engine/apply.ts),
[assertion ranking](../packages/server/src/records/winner.ts) and
[context retrieval](../packages/server/src/retrieval/context.ts).

## 3. Design decisions

| Decision | Result |
| --- | --- |
| Objects have immutable class `entity` or `event` | Events share the field, assertion, query and view machinery. |
| Evidence is an event record | An entity's current state is not a versioned source. |
| Relations support independent target multiplicity and allowed object types | Multi-record and polymorphic references compose. |
| Ordinary relations remain assertion-backed | Conflict resolution and provenance apply to whole relation values. |
| Event links remain specialized | Matching, unresolved handles, additive logging and privacy keep their existing semantics. |
| Shared reference rules apply to both link mechanisms | Workspace isolation, live-target checks, merge resolution and reference presentation stay consistent. |
| Rollups follow current relations; explicit links retain their logged association | Historical attachment and current grouping are distinguishable. |
| The timeline is assembled on read | No separate timeline store or promise of exact historical belief snapshots. |
| Base identities remain required in this scope | Empty schemas require a separate redesign of built-in dependencies. |

An event and a managed workflow record are distinct. An appointment record can
be rescheduled; an email confirming it is something that happened. Link them.
Likewise, explicit business relationship objects such as an opportunity contact
role remain useful objects even after native collection relations exist.

## 4. Schema protection

Add engine-controlled `object_types.is_protected`, `fields.is_protected` and
an event core role on fields (`title` or `summary`). Clients cannot assign or
clear protection or core roles.

- Protect person, company, task and the internal-note event type.
- Protect `task.status`, `task.dueDate` and each event type's core fields.
- Protected objects cannot be deleted. Their API names and display labels may
  change because server code resolves them through universal IDs.
- Protected fields cannot be deleted or reshaped. Permit API-name renames,
  labels and descriptions; reject changes to type, settings, nullability,
  uniqueness, searchability and filterability.
- The event title remains the label field. Reject changes that detach the
  label role from it. Core roles are unique within an event type.
- Any future server dependency on a schema element must protect it in the
  same change. Protection does not freeze record values.

The earlier proposal's permission to rename protected fields is made explicit:
renaming is allowed; arbitrary `update_field` changes are not.

## 5. Relationship model

### 5.1 Ordinary relation definitions

Keep the existing single-target relation syntax for existing many-to-one
fields. Extend it with `many_to_many` for writable collection fields, and
`targetObjects` for an explicit nonempty set of allowed object types:

```json
{
  "name": "contacts",
  "type": "relation",
  "settings": {
    "relationCardinality": "many_to_many",
    "targetObject": "person",
    "inverseField": "deals"
  }
}
```

```json
{
  "name": "customer",
  "type": "relation",
  "settings": {
    "relationCardinality": "many_to_one",
    "targetObjects": ["company", "person"]
  }
}
```

`targetObject` and `targetObjects` are mutually exclusive input forms. The
engine resolves names to stable object IDs, retaining the current API's
name-based presentation. Renames must preserve references. A multi-target field
can also use `many_to_many`. No unrestricted wildcard target is introduced.

One side owns assertions and writes. Derived inverses remain read-only, also
for many-to-many relations. This avoids two independently ranked values for
the same relationship. A single-target field may declare `inverseField`.
Multi-target fields initially have no declared inverse field; callers query
incoming links instead. Per-target inverse declarations are deferred.

### 5.2 Values and conflict resolution

- A single-record relation takes a record ID, or `null` if nullable.
- A multi-record relation takes a set represented by a JSON array of record
  IDs. `[]` clears it. `null` is rejected; `isNullable: false` requires at
  least one member. Omitted fields leave their value unchanged.
- Normalize duplicates and order by stable record ID before comparison.
  Relation membership is unordered. UI ordering is presentation only.
- Validate every target's workspace, liveness and allowed object type.
  Polymorphic values remain record IDs; the server resolves their types.
- A collection write replaces the entire set as one assertion. Existing
  actor precedence, confidence review and observed-time ranking apply to
  the whole set. There is no implicit union or per-member precedence.
- Concurrent updates serialize and rank like scalar assertions. Two writers
  replacing a collection do not each get an additive membership guarantee.
  Member-level add/remove operations and concurrency semantics are deferred.

Relation changes use normal record writes and return their normal review and
application statuses. An agent must not mistake a pending assertion for an
applied membership change.

### 5.3 Storage, lifecycle and queries

`record_links` remains derived from the winning relation assertion, with one
row per resolved target. Replace source/field uniqueness with uniqueness on
workspace, source, field and target. Enforce the single-target maximum in the
same locked recomputation transaction; never rely on callers to enforce it.
Retraction recomputes the entire winning relation value and its edges.

Keep assertions out of `records.data` for relation fields, as today. New
foreign keys include the workspace. Keep indexed incoming-edge lookup.

Existing `set_null` and `cascade` deletion behavior carries over to each
target: soft-deleted targets disappear from readable membership while their
assertions remain; `cascade` deletes the owning source when a referenced
target is deleted. Document that consequence for collection fields. Merges
redirect targets and deduplicate membership without merging event records.
Hard erasure removes a forgotten target from every historical collection
assertion as well as from live edges, so recomputation cannot restore it.

Add typed collection filters `containsAny`, `containsAll` and `isEmpty`.
Reject ordering comparisons on collection values and direct sorting by the
collection itself. Existing single-record filters retain their meaning.
Incoming-link queries, reference hydration and UI pickers must support every
allowed target type without N+1 reads. Views store field keys as today.

Changing multiplicity or allowed target types is a schema evolution operation,
not a reinterpretation of existing assertions. Initially reject these edits on
an existing field; introduce a new field under the normal evolution rules.
Reject deletion of an object still named by another active relation until its
dependencies are handled through the schema engine.

### 5.4 Why event links remain separate

Event `participants` and `about` links have collection and polymorphic
characteristics, but are not ordinary relation field values:

- Participants may have unresolved email/phone handles, roles and unmatched
  reasons. A valid unresolved participant is not a dangling record reference.
- Re-logging adds missing links rather than replacing a ranked collection.
- Removing links has person-only permissions and event-specific privacy rules.
- These built-ins are not custom fields and cannot be deleted or reshaped.

Preserve a dedicated `event_links` table and lifecycle. Share target validation,
merge resolution, RLS-bound reference rendering and batched hydration with
ordinary relations. Do not force unmatched handles into `record_links` or
pretend their mutations are field assertions.

This is a deliberate boundary: event core data and custom fields use the
ordinary schema, while event attachment remains a built-in facility. Event
links do not establish support for arbitrary labeled association fields.

## 6. Event records

### 6.1 Types and core

Add immutable `object_types.class`, defaulting to `entity`. Creating an event
type adds protected, searchable text fields for title and summary. Find them
by core role, never by API name. Title is the label field. Other fields use
normal schema operations, including the relation capabilities above as they
land. Entity-to-event conversion requires a new object type.

Event records live in `records`. Add `event_records`, a one-to-one extension
with `workspace_id`, `record_id`, `occurred_at`, `channel` and `external_id`.
The latter three are immutable built-in columns, filterable and sortable in
queries and views. Enforce that only event-class records have this extension
and that every event record has one within its creation transaction.

Keep unique `(workspace_id, channel, external_id)` where external ID is not
null, including deleted events, and an index on workspace and occurrence time.
Identity is across event types: changing type under an existing identity is
a conflict. Channel must distinguish source accounts with overlapping IDs.

The base template adds meeting, call, email, message and note event types
with universal IDs. Only note is protected; unused other event types can be
deleted under normal object deletion rules. Industry templates may add types
and custom fields such as duration or payment amount.

### 6.2 Logging and editing

`log_event` and `POST /v1/events` accept `type`, `occurredAt`, `channel`,
`externalId`, `title`, `summary`, `fields`, `participants` and `about`.
Core text is supplied only through top-level title/summary, not duplicated in
`fields`. The server obtains the actor from authentication.

- Only logging creates events. `upsert_record` rejects event creation, but
  can update an existing event's text and custom fields as assertions.
- Logging is atomic across identity, initial field assertions and links.
- Matching identity and the same normalized initial type, occurrence time,
  title, summary and custom values returns the event and adds missing links.
  A differing payload returns `event_conflict`; deleted identity returns
  `event_retracted`. Without external ID, there is no source deduplication.
- Store an immutable normalized initial logging payload for retry comparison,
  keyed by stable field/object identities. Compare against this payload,
  rather than current winning fields, so later edits do not break retries.
  This payload is covered by erasure rules; it must not retain forgotten data.
- Editing the displayed summary does not revise downstream claims or their
  observation times. Claims cite the event, not a snapshot of all its fields.
  A changed external source is logged with a new external ID; retract the old
  source explicitly if its claims must cease to apply.
- Events cannot merge or appear as merge suggestions. Entity merges still
  resolve their linked records.

Port the existing link matching, ordering, concurrent addition and removal
rules to `event_links`. `about` may target any live entity or event. A record
linked directly appears once, with participant taking precedence over about.
No implicit company link is inferred from a person's current employer.

### 6.3 Evidence, notes and privacy

Replace assertion and fact interaction-source references with
`source_record_id`. Sources must be live event records in the same workspace;
an entity record cannot be a source. Source time continues to determine
`observed_at` and fact `valid_from` under the existing rules.

Facts still require event evidence. Without `source`, `remember` creates a
note with reserved channel `retainer`, the fact text as summary and the subject
as its `about` link. Public logging rejects that channel. Exclude these
internal notes from ordinary search, queries, context event lists and timeline
event items; the fact represents them. User-logged notes remain visible.

Deleting an event retracts citing assertions, recomputes affected records and
hides facts with no remaining live source. Preserve current permissions and
return the retraction counts. Deleting an event object type must apply this
same retraction lifecycle to its records atomically; it cannot bypass it.

`forget` retains the current participant-versus-about policy, including
keeping events only about the forgotten record. Apply erasure to event fields,
links, initial logging payloads and collection assertions. If retaining a
logging payload would retain erased content, replace it with a content-free
retracted-identity tombstone and reject later retries. Never use deduplication
storage as a second copy of erased data. Port the existing privacy tests.

## 7. Event retrieval and rollups

### 7.1 Direct retrieval

`query_records` supports event types, their built-in columns and
`linked: { record, link? }` for direct event links. Cross-type record history
uses the timeline. Search uses event searchable fields through the existing
Postgres full-text machinery.

`describe_schema` includes object class, core roles, protection and new relation
settings. Interaction ceases to be a separate built-in; fact remains one.
SDK and web views support event types and built-in identity columns. Board and
calendar capabilities still require suitable fields; class alone does not
create a useful dashboard. Calendar views may select `occurredAt`.

### 7.2 Rollup semantics

An owning relation field can set `settings.rollUpEvents`, default false.
For each current edge `source --field--> target`, events directly linked to
source appear in target's event history. This works for single-record,
multi-record and polymorphic fields. It does not depend on an inverse field.

- Read-time, exactly one relation hop. Do not copy links or recursively roll
  up events that source itself received by rollup.
- Direction is always source to target. No automatic reverse propagation.
- Rollups apply only to events, not facts or related-record field assertions.
- Deduplicate by event ID before pagination, counts and context budgeting.
  Direct attachment takes precedence. For multiple rollup paths, return one
  deterministic `via: { field, record }`, chosen by stable field and source IDs.
- A changed relation changes the rollup. `via` describes present grouping,
  never historical participation. Explicit event links are unaffected.
- The engine cannot prove a relation is stable. Guides and templates must
  explain this distinction rather than promise immutability.

Default to false on mutable affiliations, ownership and contact assignments,
including `person.company`, `property.owner`, `deal.pointOfContact` and
`project.primaryContact`. This narrows the earlier proposal's defaults.
Enable template defaults only after reviewing whether reassignment should
regroup old events. Appointment-to-patient and invoice-to-company are candidate
defaults, not blanket guarantees; the implementing PR records each choice.

`get_context.recentInteractions` becomes `recentEvents`, including direct and
rolled-up items with `via`. Preserve task/fact/event priority, whole-item
budgeting, omitted counts and the current approximate token budget. Open-task
discovery handles collection and polymorphic relations in either direction,
deduplicates tasks and retains the protected task status/due-date behavior.

## 8. Unified record timeline

Expose `GET /v1/records/:id/timeline`, MCP `get_timeline`, an SDK method and a
web timeline tab. Assemble it from source tables at read time:

| Item | Membership | Time |
| --- | --- | --- |
| `event` | Direct and rolled-up events, excluding internal fact notes | Event `occurred_at` |
| `field_change` | Subject record's eligible assertions (`active`, `superseded`) | Assertion `observed_at` |
| `fact` | Subject record's facts, including superseded facts but excluding retracted/source-less facts | Fact `valid_from` |

`field_change` means an asserted value in the record's history. It does not
prove that the assertion was ever the winner. Existing `superseded` status
does not establish that fact. Include assertion ID, current status, actor,
source and current-winner indication; the UI must label nonwinning claims
accordingly. Pending/rejected assertions remain in review/assertion APIs.

Order by descending item time, then a fixed item-kind order, then item ID.
Use the entire tuple in an opaque cursor bound to the record and filters.
Apply event deduplication before the merged limit. Expose item-type, field,
event-type and time-range filters; a branch-specific filter excludes unrelated
item types unless the caller explicitly includes them. Resolve stored field
references by key so renames do not alter identity.

Pages reflect current visibility and relationships, not a snapshot across
requests. Backdated inserts and relation edits may change later results; do
not promise stable historical snapshots. Exact historical winner intervals
and retraction audit streams require separate design.

## 9. Interfaces removed and changed

The event replacement removes `interactions`, `interactions.metadata`, the
separate interaction query route/tool and `log_interaction`.
`interaction_participants` becomes `event_links`.

Replace interaction logging, detail, link mutation, deletion and claims reads
with event equivalents in the same phase. Update all REST routes, MCP tools,
SDK types/methods, guides, web screens and tests together. Replace
`recentInteractions` with `recentEvents`; old interaction queries become
object queries or timeline requests. Preserve source-claim inspection and
unmatched-participant review rather than losing them during the rename.

## 10. Disposition of the other coverage recommendations

| Capability | Decision and trigger |
| --- | --- |
| Native multi-record relations | Included, immediately after event replacement and before rollups. |
| Polymorphic references | Included after multi-record relations; compose with either multiplicity. |
| Association labels/metadata | Deferred. Participant roles are not a general association schema. A follow-up must define directed label vocabularies, per-edge provenance and mutation rules. |
| One-to-one relations | Deferred. A follow-up must enforce target uniqueness transactionally under concurrent writes; writer-side checking is insufficient. |
| List-scoped entry fields | Deferred until a concrete Attio/Affinity-style workflow requires native list ownership. Entry objects remain an acknowledged structural substitution. |
| Configurable typed composites/collections | Deferred until concrete nested shapes establish validation and evolution requirements. JSON and child objects do not count as direct typed-shape coverage. |
| Optional base inventory | Deferred. Person matching, task context and internal notes currently depend on base identities. Removing them needs capability configuration or replacement behavior first. |
| Per-target inverses and member-level relation mutations | Deferred. Included relations have one owning write side and whole-value assertions. |
| Assertion premises and inferred facts | Deferred until a real agent workflow needs them and invalidation/erasure rules are decided. |

Premises, when designed, cite immutable assertion IDs rather than whole entity
records. The earlier `assertion_premises` / `premise_assertion_id` proposal is
a direction, not a shipped write path. Do not remove reserved premise storage
as if an implemented replacement already existed. Superseded and retracted
premises need explicit downstream behavior before this work starts.

Background link repair, schema evolution and enrichment remain agent work
through public APIs. The consolidator stays deterministic. No language model,
embedding provider or semantic search is added.

## 11. Implementation order and release boundaries

Every phase leaves `main` working and updates architecture, guides, API/SDK
contracts and relevant web behavior together. Generate migrations from the
database schema; never hand-edit generated migrations.

| Phase | Deliverable | Dependency |
| --- | --- | --- |
| 0 | Protection for current base identities and server-dependent task fields | None |
| 1 | Complete event replacement: class/core schema, templates, storage, logging, edits, sources, retry payloads, links, retraction, privacy, queries/search/context, SDK/MCP/web and removal of old interaction paths | 0 |
| 2 | Native multi-record relations: schema, whole-set assertions, edge derivation, inverses, filters, merge/erase behavior, task discovery and UI | 1 |
| 3 | Polymorphic references for single and collection relations: allowed targets, validation, incoming queries, schema evolution checks and UI | 2 |
| 4 | One-hop rollups over the completed relation model, explicit template-default review and context integration | 3 |
| 5 | Unified timeline through REST, MCP, SDK and web, including assertion-history semantics and pagination | 4 |

Phase 1 is intentionally a complete replacement. Do not merge a write-only
conversion that drops storage still used by readers. It may be developed as
several commits on one branch; if it must span PRs, first amend this plan with
a working intermediate state that retains old readers/storage until cutover.
Preparation PRs must not expose partially supported event types.

Direct assertion-history access does not inherently require rollups. A narrow
MCP history tool can land earlier if needed, but it must not claim to be the
complete timeline in phase 5. Deferred capabilities are separate follow-ups,
not prerequisites silently added to these phases.

## 12. Acceptance and verification

Apply ARCHITECTURE.md section 12: unit, real-Postgres integration, API, agent
scenario and browser checks as applicable, plus a manual live-agent milestone.
Each database test file uses its own fresh database. Never mock Postgres.

- **Protection:** reject deletion/reshaping and caller-controlled protection;
  allow renames without breaking context, event roles, relations or views.
- **Events:** custom types and fields work end to end; event creation cannot
  bypass logging; identities remain reserved after deletion; retries compare
  the initial payload even after field edits; no internal notes leak through
  ordinary event retrieval. Source references reject entities and other tenants.
- **Concurrency:** competing logs land once; concurrent link additions each
  land once; retraction racing a citing write cannot leave live orphaned
  claims. Retain existing merge/link locking and erasure race coverage.
- **Relations:** sets normalize, replace and clear correctly; invalid members
  roll back the whole write; single-target limits survive concurrent writes;
  pending collections do not change edges. Source retraction recomputes them.
  Polymorphic values validate against all allowed types. Inverses and incoming
  reads agree with owning fields. Merge and hard-erasure recomputation cannot
  recreate duplicates or forgotten targets.
- **Rollups:** test single, collection and polymorphic fields, disabled fields,
  direction, one-hop limits, relation changes, direct precedence, multiple-path
  deduplication, source deletion, counts and context budgets.
- **Timeline:** test equal timestamps across kinds, cursor/filter binding,
  backdated observations, historical collection assertions, never-winning
  superseded claims, superseded facts and internal-note exclusion.
- **Privacy and isolation:** port interaction privacy tests; cover event
  payloads, collection history, RLS and cross-workspace references on every
  new path. MIT packages must not import server code.
- **Agent scenarios:** define person organizations as a native collection,
  define a company-or-person customer, log an event with custom fields, cite
  it, retrieve rolled-up context and inspect the unified timeline. Scenarios
  must distinguish applied writes from pending review and current grouping
  from explicit historical attachment.

Completion means these behaviors work through the public interfaces and the
affected UI. It does not establish exact reproduction of any complete vendor
schema; the remaining structural gaps stay documented in the coverage report.
