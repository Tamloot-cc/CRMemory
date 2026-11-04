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

Retainer is in early exploration and has not been released, so no deployed
user data needs preserving. Storage and API changes need no compatibility
shims or backfills. If a release ships before a phase lands, that phase must
add its own migration plan first. This does not waive the product guarantee
that a workspace's own schema edits preserve its data under the existing
schema evolution rules.

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
| An event's own relation fields attach it to their targets | Events modeled with typed relations appear in their targets' history, like `about` links. |
| `remember` notes are a hidden object type | One resolution check hides them everywhere, instead of a channel filter on every path. |
| Every attached event carries one tagged `via` | Participant, about, field and rollup attachment share one shape. |
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
  labels and descriptions; reject changes to type, nullability, uniqueness,
  searchability and filterability.
- Protect only the select option values server code reads. `task.status`
  keeps its `done` option: it cannot be removed and its value cannot change,
  though its label can. Other options on a protected select field can be
  added, relabeled and removed, so a workspace can add statuses such as
  `blocked`.
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

Cardinality alone no longer identifies the read-only side: today the engine
treats `one_to_many` as "inverse" (`schema-engine/apply.ts`), but the inverse
of a `many_to_many` field is also many-to-many. Add an engine-set
`settings.isInverse` to every inverse field and replace the cardinality checks
with it. The inverse of a `many_to_one` field stays `one_to_many`; the inverse
of a `many_to_many` field is `many_to_many` with `isInverse: true`.
`describe_schema` shows `isInverse` so agents know which side to write.

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
row per resolved target. Add an `is_collection` column copied from the field's
multiplicity. Make `(workspace, source, field, target)` unique, and keep a
partial unique index on `(source, field)` where `is_collection` is false, so
the database itself enforces the single-target maximum. The locked
recomputation transaction still validates it first, for a clear error.
An insert/update trigger derives `is_collection` from the referenced field in
the same workspace, overriding any supplied flag and rejecting non-relation
or inverse fields. Runtime writers cannot disable the trigger. Multiplicity
is immutable on an existing field (below), so edges cannot drift after a
schema edit. The flag plus index is a database guarantee only with this
consistency enforcement; the partial index alone is insufficient.
Retraction recomputes the entire winning relation value and its edges.

Keep assertions out of `records.data` for relation fields, as today. New
foreign keys include the workspace. Keep indexed incoming-edge lookup.

`set_null` behavior carries over to each target: soft-deleted targets
disappear from readable membership while their assertions remain. Reject
`onDelete: cascade` on collection fields. Cascades follow links at any depth
(`cascadeSet` in `records/write.ts`), so deleting one contact would delete
every deal that lists it. Revisit only with a concrete need and a guarded
semantics, such as cascading when the last member goes. Single-record fields
keep `cascade`, including multi-target ones. Merges redirect targets and
deduplicate membership without merging event records.
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

Deleting an object type keeps today's behavior for relations that target it
(`delete_object` in `schema-engine/apply.ts`), extended to multiple targets:

- A relation whose only allowed target is the deleted type is deprecated with
  it, as today.
- A multi-target relation that also allows other types is rejected: the
  deletion fails and names the field. The caller first replaces that field
  under the evolution rules above. The engine never silently narrows allowed
  targets, because that would reinterpret existing assertions.
- Deleting an object deprecates it and hides its records. Event `about` and
  participant links to those records are kept but drop out of reads, like
  links to deleted records.
- Deleting an event type also follows the retraction lifecycle in 6.4.

These rules apply equally to unused base event types (6.1).

### 5.4 Why event links remain separate

Event `participants` and `about` links have collection and polymorphic
characteristics, but are not ordinary relation field values:

- Participants may have unresolved email/phone handles, roles and unmatched
  reasons. A valid unresolved participant is not a dangling record reference.
- Re-logging adds missing links rather than replacing a ranked collection.
- Only `user` actors can remove links, and removal follows event-specific
  privacy rules.
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
with universal IDs. None of them is protected; unused ones can be deleted
under normal object deletion rules (5.3). The engine also creates a hidden,
protected internal-note event type in every workspace for `remember` (6.4).
Industry templates may add types and custom fields such as duration or
payment amount.

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
- The assertions written by the logging transaction are the event's initial
  values. Mark them `is_initial`. They cite the event itself as source, and
  their `observed_at` is the event's `occurred_at`. Retries compare against
  these rows, rather than current winning fields, so later edits do not break
  retries. No separate payload copy is stored, so erasure has one place to
  clean. A retry that names a field deleted since logging is a validation
  error, as for any write. A field added since logging is compared as absent
  from the original, so a retry supplying it conflicts.
- Before comparing relation values on a retry, resolve merged record IDs to
  their live survivors on both the incoming and initial-assertion sides.
  Normalize collection sets again after resolution, because distinct original
  IDs may now identify one survivor. An unchanged original request and one
  using the equivalent survivor IDs both remain valid retries. A different
  resolved membership still conflicts. This accommodates merges that rewrite
  relation assertions without storing a second copy of their original values.
- Later edits through `upsert_record` are ordinary assertions with no source
  and server time as `observed_at`, and they rank as usual.
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

### 6.3 Relation fields on event types

An event type may have its own relation fields, such as `call.deal` or
`payment.invoice`. The event is then the source of a `record_links` edge, and
the target counts as related to the event. Without this rule, an agent that
records "this call was about this deal" as a relation field would find the
call missing from the deal's history.

- Every live edge from an event-class record to a target attaches that event
  to the target's event history: `linked`, `recentEvents` and the timeline.
  The attachment shows as `via: { kind: 'field', field }` (7.1).
- This is direct attachment and needs no opt-in. It may feed one subsequent
  opted-in rollup, just like participant/about attachment. For example,
  `payment.invoice` attaches the payment event to its invoice; an opted-in
  `invoice.company` then includes it on the company. The company cannot pass
  that rolled-up payment onward through another relation.
- It follows the current relation value. Unlike `about`, a corrected or
  reassigned relation moves the event.
- Guides prefer `about` for "what this event concerns" and keep relation
  fields for typed structure the event type owns, such as the invoice a
  payment settles.

### 6.4 Evidence, notes and privacy

Replace assertion and fact interaction-source references with
`source_record_id`. Sources must be live event records in the same workspace;
an entity record cannot be a source. Source time continues to determine
`observed_at` and fact `valid_from` under the existing rules.

Facts still require event evidence. Without `source`, `remember` creates an
internal note with reserved channel `retainer`, the fact text as summary and
the subject as its `about` link. Public logging rejects that channel.

Internal notes are records of their own hidden, protected event type with a
fixed universal ID, not of the user-visible `note` type. Filtering them by
channel inside `note` would need a check on every read and write path: query,
views, search, record reads by ID, the web app's lists, counts, `upsert_record`
and record deletion. One missed path would leak a note or let a caller edit
the text behind a fact. Hiding the whole object type puts the check in one
place, object resolution:

- `describe_schema` omits the type. Query, view, search, record and write
  routes resolve it as not found. Context event lists and timeline event
  items never include it; the fact represents the note.
- Its records change only through `remember` and the fact and privacy
  lifecycle (this section). They cannot be edited or deleted as records.
- Fact presentation marks such a source as internal instead of exposing a
  record ID that callers cannot read.
- User-logged notes, of the base `note` type, remain ordinary events.

Deleting an event retracts citing assertions, recomputes affected records and
hides facts with no remaining live source. Preserve current permissions and
return the retraction counts. Deleting an event object type must apply this
same retraction lifecycle to its records atomically; it cannot bypass it.

`forget` retains the current participant-versus-about policy, including
keeping events only about the forgotten record. Apply erasure to event fields,
links, initial assertions and collection assertions. When erasure removes an
event's initial values, remove its raw identity and keep a suppression
tombstone only when it had an external ID. Raw `channel` and `external_id`
are caller-controlled strings and may contain identifying information; they
are not content-free.

The tombstone stores the workspace and a keyed HMAC of an unambiguous encoding
of `(workspace_id, channel, external_id)`, with a domain separator specific to
event identity suppression. Use the existing suppression-key facility, not
an unkeyed hash. Store no raw channel, external ID, event text or original
record ID in the tombstone. This digest is a retained suppression token,
not a claim that the identity has been anonymized.

Logging checks the digest before creating an event or adding retry links and
returns `event_retracted` on a match. Check/reservation and erasure must
serialize on the same identity so concurrent logging cannot recreate the
erased event. Without external ID there is no identity tombstone or identity
deduplication guarantee. Key rotation must preserve matching against existing
tombstones; key management must not silently clear suppression.
Never use deduplication storage as a second copy of erased data. Port the
existing privacy tests and extend them for suppression.

## 7. Event retrieval and rollups

### 7.1 Direct retrieval

`query_records` supports event types, their built-in columns and
`linked: { record, link? }` for direct attachment, where `link` is
`participant`, `about` or `field` (6.3). Cross-type record history uses the
timeline. Search uses event searchable fields through the existing Postgres
full-text machinery.

Every event item in an event list, context pack or timeline says how it is
attached to the record, as one tagged shape:

```ts
type Via =
  | { kind: 'participant' }
  | { kind: 'about' }
  | { kind: 'field'; field: string }                   // event's own relation (6.3)
  | { kind: 'rollup'; field: string; record: string }; // 7.2
```

This replaces today's `via: 'participant' | 'about'` string
(`packages/shared/src/api.ts`, ARCHITECTURE.md section 6). An event attached
in several ways appears once, with precedence `participant`, `about`,
`field`, `rollup`. Event items carry `type` (the event type's API name) where
interaction items carried `kind`.

`describe_schema` includes object class, core roles, protection and new relation
settings. Interaction ceases to be a separate built-in; fact remains one.
SDK and web views support event types and built-in identity columns. Board and
calendar capabilities still require suitable fields; class alone does not
create a useful dashboard. Calendar views may select `occurredAt`.

### 7.2 Rollup semantics

An owning relation field can set `settings.rollUpEvents`, default false.
For each current edge `source --field--> target`, events directly attached to
source appear in target's event history. This works for single-record,
multi-record and polymorphic fields. It does not depend on an inverse field.

`rollUpEvents` can be changed after the field is created, because nothing is
stored and turning it off restores the earlier reads. `update_field` gains a
`rollUpEvents` parameter, which is not a destructive change and needs no
review. Protected fields accept it.

- Read-time, at most one relation hop after direct attachment. All direct
  attachment kinds (participant, about and field) can feed that hop. Do not
  copy links or recursively roll up events that source itself received by
  rollup. An event's own relation field establishes attachment; it does not
  consume the permitted rollup hop.
- Direction is always source to target. No automatic reverse propagation.
- Rollups apply only to events, not facts or related-record field assertions.
- Deduplicate by event ID before pagination, counts and context budgeting.
  Direct attachment takes precedence. For multiple rollup paths, return one
  deterministic `via: { kind: 'rollup', field, record }`, chosen by stable
  field and source IDs.
- Rollups can fan out widely: a company with thousands of deals, each with
  events. The phase that adds them defines the query as a keyset-paginated
  merge over `occurred_at` that never materializes the full set. It adds the
  indexes the merge needs: `event_links (workspace, record_id, link)`,
  covering occurrence time through `event_records`, and incoming
  `record_links` by target and field. Context packs and the timeline share
  this query, and an integration test checks its plan on a seeded large
  fan-out.
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
| `event` | Directly attached (participant, about, the event's own relation field) and rolled-up events, each with `via` (7.1); never internal notes | Event `occurred_at` |
| `field_change` | Subject record's eligible assertions (`active`, `superseded`) | Assertion `observed_at` |
| `fact` | Subject record's facts, including superseded facts but excluding retracted/source-less facts | Fact `valid_from` |

`field_change` means an asserted value in the record's history. It does not
prove that the assertion was ever the winner. Existing `superseded` status
does not establish that fact. Include assertion ID, current status, actor,
source and current-winner indication; the UI must label nonwinning claims
accordingly. Pending/rejected assertions remain in review/assertion APIs.

A `field_change` carries the asserted value, not a diff. For a collection
relation, that value is the whole asserted set. The previous item in the
timeline need not be the previous winner, since nonwinning claims appear too,
so a diff against it would be misleading. A client that wants "added/removed"
compares against the winning value at that point, and the API does not claim
to know it (see the last paragraph of this section).

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
| 0 | Protection for current base identities and server-dependent task fields, including the `done` option rule | None |
| 1 | Complete event replacement: class/core schema, templates, the hidden internal-note type, storage, logging, edits, sources, initial-assertion retries, links, attachment through event relation fields, the `via` shape, retraction, privacy, queries/search/context, SDK/MCP/web and removal of old interaction paths | 0 |
| 2 | Native multi-record relations: schema, `isInverse`, whole-set assertions, edge derivation with the database single-target index, inverses, filters, `cascade` rejection, merge/erase behavior, task discovery and UI | 0 |
| 3 | Polymorphic references for single and collection relations: allowed targets, validation, incoming queries, schema evolution and object-deletion checks, and UI | 2 |
| 4 | One-hop rollups over the completed relation model, the bounded rollup query and its indexes, explicit template-default review and context integration | 1, 3 |
| 5 | Unified timeline through REST, MCP, SDK and web, including assertion-history semantics and pagination | 4 |

Phase 2 does not depend on the event replacement, so phases 1 and 2 can be
built in parallel. Whichever lands second extends the other: if phase 2 lands
first, phase 1 shares its target validation and hydration with `event_links`
(5.4). If phase 1 lands first, phase 2 applies attachment through event
relation fields (6.3) to collection fields too.

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
  `task.status` accepts new options but refuses removing or revaluing `done`.
- **Events:** custom types and fields work end to end; event creation cannot
  bypass logging; identities remain reserved after deletion; retries compare
  the initial assertions even after field edits, and after fields are added
  or deleted. Source references reject entities and other tenants. An event's
  own relation field attaches it to the target, and reassigning the field
  moves it. After merging relation targets, retries using original IDs or
  survivor IDs both succeed for unchanged single-record and collection
  values; collapsing multiple members to one survivor does not conflict.
  Different resolved membership still conflicts.
- **Internal notes:** every route (query, views, search, record read by ID,
  `upsert_record`, record deletion, describe, counts, context, timeline)
  treats the internal-note type as absent, and user-logged notes stay visible.
- **Object deletion:** deleting a single-target relation's only target
  deprecates the field; deleting one of a multi-target field's types is
  rejected and names the field; event links to hidden records drop out of
  reads.
- **Concurrency:** competing logs land once; concurrent link additions each
  land once; retraction racing a citing write cannot leave live orphaned
  claims. Retain existing merge/link locking and erasure race coverage.
- **Relations:** sets normalize, replace and clear correctly; invalid members
  roll back the whole write; single-target limits survive concurrent writes;
  pending collections do not change edges. Source retraction recomputes them.
  Polymorphic values validate against all allowed types. Inverses and incoming
  reads agree with owning fields, and `isInverse` fields of many-to-many
  relations refuse writes. `onDelete: cascade` is rejected on collection
  fields. The database index rejects a second edge on a single-target field
  even when application checks are bypassed, including when an insert or
  update attempts to spoof `is_collection: true`. Merge and hard-erasure
  recomputation cannot recreate duplicates or forgotten targets.
- **Rollups:** test single, collection and polymorphic fields, disabled fields,
  toggling `rollUpEvents` on and off, direction, one-hop limits, relation
  changes, `via` precedence across all four kinds, multiple-path
  deduplication, source deletion, counts, context budgets and the query plan
  on a large fan-out. A payment attached through `payment.invoice` rolls up
  once through `invoice.company`, but never onward from the company; explicit
  participant/about attachments follow the same one-hop rule.
- **Timeline:** test equal timestamps across kinds, cursor/filter binding,
  backdated observations, historical collection assertions, never-winning
  superseded claims, superseded facts and internal-note exclusion.
- **Privacy and isolation:** port interaction privacy tests; cover initial
  event assertions and tombstones, collection history, RLS and cross-workspace
  references on every new path. Erase an event whose channel/external ID
  contains identifying strings and verify neither raw string remains in
  tombstones. The same workspace/identity stays suppressed, while another
  workspace does not inherit that suppression. Test logging racing erasure
  and matching across supported suppression-key rotation. MIT packages must
  not import server code.
- **Agent scenarios:** define person organizations as a native collection,
  define a company-or-person customer, log an event with custom fields, cite
  it, retrieve rolled-up context and inspect the unified timeline. Scenarios
  must distinguish applied writes from pending review and current grouping
  from explicit historical attachment.

Completion means these behaviors work through the public interfaces and the
affected UI. It does not establish exact reproduction of any complete vendor
schema; the remaining structural gaps stay documented in the coverage report.
