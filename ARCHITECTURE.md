# Retainer architecture

Retainer is an open-source memory layer for AI agents that work with customer
relationships. Agents and apps use it through a REST API and an MCP server.
An optional web app in `packages/web` gives people review, records and
provenance screens; see `FRONTEND.md` for its scope.

It combines two ideas:

- **Schema as data** (from [Twenty](https://github.com/twentyhq/twenty)): the
  shape of the CRM (objects, fields, relations) is stored as rows, so a
  workspace, or an agent working in it, can extend the model at runtime.
- **Memory with provenance** (inspired by
  [Honcho](https://github.com/plastic-labs/honcho), but agent-written):
  agents read conversations with their own models and write typed field
  values, plain-language facts and a log of events (meetings, calls,
  emails and anything else that happens). Every value records who wrote it
  and which event it came from.

Retainer never calls a language model. Agents decide what to remember;
Retainer validates it, resolves conflicts, keeps its history and makes it
searchable. Full conversations stay with the agent.

---

## 1. Data model

Three layers, stored in SurrealDB: a catalog database for workspaces and API
keys, and one database per workspace (7). This document describes the
design as of the first release (0.1.0). Section 11 lists the fixed tables;
[docs/surrealdb-migration-spec.md](docs/surrealdb-migration-spec.md)
describes the storage design in detail (sections 4-9, with the recorded
deviations in section 13).

### 1.1 Schema (metadata)

| Table            | Holds                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `object_types`   | The kinds of things tracked: `person`, `company`, `task` and the base event types in every workspace, more from templates (3.1), plus custom objects. `class` is `entity` or `event` (1.3) |
| `fields`         | The fields of each object: type, settings, flags (`is_nullable`, `is_unique`, `is_filterable`, `is_searchable`), and `core_role` (`title` or `summary`) on an event type's core fields     |
| `schema_changes` | Every applied, proposed, rejected or failed change, with its operations and actor                                                                                                          |

Every schema row carries:

- `universal_id`: a stable UUID that is the same for a standard object or
  field in every workspace, so upgrades can find it.
- `owner`: `system` (shipped with Retainer), `workspace` (added by a user or
  integration), or `agent` (added by an agent).
- `status`: `active` or `deprecated`. A proposed change lives only in
  `schema_changes` until it is approved; nothing half-exists in the live
  schema.
- `key` (fields only): a short, permanent ID that names the field's column
  in its object's table (`f_<key>`, 1.2). Renaming a field changes `name`,
  never `key`, so a rename never touches the data. Keys are never reused,
  even after a field is deleted.

- `is_protected`: set by the schema engine, never by a client, on objects and
  fields that server code depends on (below).

#### Protection

Server code finds the schema elements it depends on by universal ID, never
by API name, and the engine protects each of them. Today these are the base
objects `person`, `company` and `task`, the fields `task.status` and
`task.dueDate` (open tasks in context packs, 6.2), and the hidden
internal-note event type (1.3). The list lives in
`schema-engine/protection.ts`; any new server dependency on a schema
element protects it in the same change. The core `title` and `summary`
fields of every event type are protected the same way. The base event types
themselves are not: an unused one can be deleted like any object.

- A protected object cannot be deleted. Its API names and labels can change.
- A protected field cannot be deleted or reshaped: renames, labels and
  descriptions are allowed; changes to type, `is_nullable`, `is_unique`,
  `is_filterable` and `is_searchable` are rejected.
- Only the select option values server code reads are protected:
  `task.status` keeps its `done` option, whose label can change. Other
  options can be added, relabeled and removed, so a workspace can add
  statuses such as `blocked`.
- Protection does not freeze record values.

`describe_schema` shows `isProtected` on objects and fields and
`protectedOptions` on fields, and marks base elements with `baseObject`
(`person`, `company`, `task`) or `baseField` (`taskStatus`,
`taskDueDate`), so a client finds them after a rename without reading
universal IDs.

Workspaces carry a `schema_version` that increments on every applied change.
API and MCP schemas are cached per `(workspace, schema_version)`.

#### Field types

| Type                                                     | Value                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `text`, `number`, `boolean`, `date`, `date_time`, `json` | Plain values; `date_time` is a native datetime column            |
| `select`, `multi_select`                                 | Option value(s); options live in `fields.settings`               |
| `money`                                                  | `{ amountMicros, currency }`                                     |
| `emails`                                                 | `{ primary, additional[] }`                                      |
| `phones`                                                 | `{ primary: { number, countryCode }, additional[] }`             |
| `links`                                                  | `{ primary: { url, label }, additional[] }`                      |
| `full_name`                                              | `{ first, last }`                                                |
| `address`                                                | `{ street1, street2, city, state, postcode, country, lat, lng }` |
| `relation`                                               | Not a column; a native edge table (1.2)                          |

Composite shapes are defined once in `@retainer/shared`, so every object that
has emails stores them the same way. Each non-relation field is a typed
column of its object's table, `option<T | null>`, so a missing value (no
eligible assertion) and an explicit `null` stay apart; `json` fields are
`any`, the only untyped columns. Native values are converted at the API
boundary: responses keep the JSON shapes above.

#### Built-in columns on every record

`id`, `created_at`, `updated_at`, `deleted_at` (soft delete), `created_by`,
`updated_by`, `merged_into` (set when the record was merged into another,
so IDs that agents kept still resolve). These are columns of every object
table, not schema fields; `record_directory` (1.2) repeats the liveness and
merge columns so a public ID resolves without knowing its object.

#### Relations

A `relation` field is defined on its owning side: `many_to_one` for one
record (`person.company`) or `many_to_many` for a set of records
(`deal.contacts`). The other side, if named with `inverseField`, is its
inverse, read from the same edges: `one_to_many` for a
many-to-one field (`company.people`), `many_to_many` for a many-to-many
one (`person.contactDeals`). The engine marks every inverse
`settings.isInverse`, and only the owning side is written; `describe_schema`
shows inverses as `readOnly`. Cardinality and targets cannot change on an
existing field: create a new field instead.

A relation may also be polymorphic: `targetObjects` names two or more
objects it may point at (a deal's `customer`, a company or a person),
instead of `targetObject`. Either multiplicity works. Stored settings hold
the objects' universal IDs, so renames keep it. A polymorphic relation has
no inverse field (per-target inverses are deferred); the records pointing at
one target are found by filtering on the field. Deleting an object that a
polymorphic relation may also point at is refused and names the field: the
engine never narrows its targets, which would reinterpret existing values,
so the field is replaced first. A relation whose only target is deleted is
deprecated with it, as before.

Setting a link is a field assertion whose value is the target record's ID,
or for a set the whole array of IDs, so links follow the same write rules as
other fields; the field's edges are derived from the winning assertion, one
edge per target, like the record's columns. A set is normalized before it is compared
or stored: duplicates dropped, ordered by ID, `[]` to clear it, `null`
refused; a required set needs at least one member. A write replaces the
whole set as one assertion, ranked like any other; there is no implicit
union, so two writers replacing a set do not each keep their members, and
a pending set changes no edges. Every member must be a live record of an
allowed target object in the same workspace, or the whole write fails.

The field's `onDelete` setting is applied by the application when the target
is soft-deleted: `cascade` soft-deletes the source records too; `set_null`
(the default) keeps the edge and the assertion, and reads skip the deleted
target. `cascade` is refused on many-to-many fields, since cascades follow
links at any depth and deleting one contact would delete every deal listing
it.

Every owning relation field has its own native relation table,
`r_<field universal ID>`, declared `ENFORCED` from the owning object's
table to the tables of its allowed targets. Each edge records the assertion
it derives from. A unique `(in, out)` index keeps each edge once, a unique
`in` index holds a single-record field to one edge, and an `out` index
serves inverses. So the database itself refuses a missing or wrong-type
target, a duplicate pair, a second edge on a single-record field and a plain
`CREATE` into the table, even from a writer that bypasses the application.
Inverse fields have no table of their own. Merges point sets at the survivor, once.
Hard deletion deletes single-record assertions that point at the deleted
record and removes it from every set assertion, current or past (2.1,
step 3), so a rebuild cannot recreate dangling links.

Sets filter with `containsAny` and `containsAll` (lists of record IDs) and
`isEmpty`; they take no comparisons and cannot be sorted.

#### Actor

Every write carries an actor: `{ type, id, name? }` where `type` is `user`,
`agent`, `integration`, or `system`. The API key decides the actor; callers
cannot claim to be someone else. The server's own `system` actor
(`retainer`) seeds base objects and applies a template chosen at workspace
creation; merges are attributed to the merging user, and the consolidator
writes no actor-stamped rows.

### 1.2 Records

| Storage                                   | Holds                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object table per type (`o_<object ID>`)   | One schemafull row per record: a typed `f_<key>` column per non-relation field, `label` (5.1) and the built-in columns; event types add `occurred_at` |
| `record_directory`                        | One row per record, keyed by its public ID: object, object table, whether it is an event, `deleted_at`, `merged_into`, `updated_at`                   |
| Relation table per field (`r_<field ID>`) | Native edges of one owning relation field, from source to target, each with the assertion it derives from (1.1)                                       |
| `record_identifiers`                      | Normalized lookup entries pointing at a record: every email, phone and website domain, plus the value of every `is_unique` field                      |
| `unique_claims`                           | Only actual uniqueness reservations: one row per held unique value, unique on `(field_id, value)`                                                     |

Table names come from immutable IDs (the object's and the field's universal
IDs, the field's key), never from business names, so renaming Company or
one of its fields changes metadata, not tables or columns.

A record's columns and edges are a **projection computed from
`field_assertions`** (below). If the layout ever needs to change, records
are rebuilt from assertions. Edges, identifiers, unique claims, the
directory entry, event attachments and the search document change in the
same transaction that recomputes the columns.

`record_identifiers` exists because composite fields (`emails`, `phones`,
`links`) keep extra values in an array that a column index cannot see or
enforce. It is used for participant matching and for finding duplicates.
A lookup entry is not always a reservation (a secondary email of a
non-unique field, for example), so reservations live apart in
`unique_claims`, and its unique index is what stops two concurrent writes
from creating the same person twice. One fixed index enforces uniqueness
for every field, with no per-field index. Null values create no claim.
Normalization is shared by writes and lookup; a claim stores its value
JSON-encoded, so number `1` and text `"1"` do not collide. Only `text`,
`number`, `date` and `emails` fields can be unique; the schema engine
rejects the rest.

Only an exact identifier declared unique can automatically select a record.
Non-unique phones, shared inboxes, domains and name similarity produce
candidates. If supplied identifiers point to different records, return a
conflict with candidate IDs; never pick the first match or merge implicitly.
A losing concurrent create rolls back the entire provisional record and
retries lookup. Soft-deleted records retain uniqueness claims until purged
with `forget` (restoring a record is not in v1), so writes cannot silently
recreate them. A match on a
soft-deleted record follows `merged_into` when set; otherwise the
participant stays unresolved and is listed in `GET /v1/review`, rather than
attaching new events to a hidden record.

#### Why a table per object

Like Twenty, Retainer gives every object its own table, here inside the
workspace's own database. Metadata stays authoritative: the schema engine
compiles it into the tables (3), and agents never submit definitions.

- **Typed storage with database constraints.** A schemafull table refuses
  undeclared fields and wrongly typed values; an enforced relation table
  refuses invalid edges (1.1). These hold even for a writer that bypasses
  the application.
- **Native graph reads.** Inverses, history and traversal (6.2) read edges
  through their indexes instead of filtering one shared table.
- **Agents add fields without a pause.** Definitions are transactional on
  the pinned SurrealDB release, so a new field, object or relation table
  commits with its metadata in one transaction. Indexes are the exception:
  each is defined alone and verified before the change publishes (3).

What it keeps from a single shared table:

1. **Rename safety**: physical names come from universal IDs and field
   keys, not names.
2. **Uniqueness without per-field indexes**: `is_unique` is enforced
   through `unique_claims`.
3. **No eager destructive changes**: deprecating a field or object keeps
   its column or table and its assertions.
4. **Shared indexes in v1**: object tables are indexed on `created_at`,
   `merged_into` and, for event types, `occurred_at`. `is_filterable`
   exposes a field to structured filters; it does not create an index.
   Filters compile to a condition over the object's table, with every value
   a parameter. Add field indexes later only for measured workloads.

### 1.3 Memory

| Table                       | Holds                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event_identity`            | One row per event record: `occurred_at`, `channel` and `external_id`, unique on `(channel, external_id)` when set, so logging the same source twice is a no-op. Immutable once logged, except that erasure clears `channel` and `external_id` (2.1)                                                   |
| `event_links`               | The canonical links of an event, in the order logged. `link = 'participant'`: who took part, as a normalized `handle` (email or phone) and/or a `record`, a free-text `role`, and an `unmatched_reason` when no record was matched. `link = 'about'`: a record it concerns (only `record`)            |
| `event_attachments`         | The resolved ways an event is attached to a record (participant, about, or one of the event's relation fields), with the event's type and `occurred_at`, indexed by target and time                                                                                                                   |
| `rollup_attachments`        | Derived one-hop rollup entries: target record, event, event type, `occurred_at`, rollup field and source record, indexed by target and time (Rollups, below)                                                                                                                                          |
| `event_identity_tombstones` | Keyed HMACs of erased event identities, with the ID of the key that made each (2.1). No raw channel, external ID, text or record ID                                                                                                                                                                   |
| `field_assertions`          | A claimed value for one field of one record: value, actor, source event (`source`), `is_initial`, confidence, `observed_at` (when the claim was true at the source), `status` (`active`, `superseded`, `pending_review`, `rejected`, `retracted`), and `refs`, the records a relation value points at |
| `facts`                     | Plain-language claims about a record: `content`, `kind` (`stated` or `inferred`), confidence, `valid_from` / `valid_to` (when it was true in the world), `superseded_by`                                                                                                                              |
| `fact_sources`              | What a fact rests on: an event (`source`, with an optional quote the agent chose) or other facts (`premise_fact`, for inferences)                                                                                                                                                                     |

`occurred_at` is also copied onto the event's row in its object table and
onto its attachment rows, so a history page is one index scan.
`field_assertions.refs` is indexed per element, so merge and `forget` find
every claim pointing at a record, current or historical.

`field_assertions.observed_at` and `facts.valid_from` come from the source
(rules 2.2 and 2.6); `valid_from` has no `now()` default, so backfilled
facts do not appear newly true. No v1 write path creates `inferred` facts,
premise-fact sources or `valid_to`; those columns are reserved.

Retainer stores what the agent chose to record, not the conversation itself.
A summary or quote is stored like any other value, so an agent should not put
in it what the workspace should not keep.

#### Events

An object type has a class. `entity` is the default: people, companies,
deals, anything with a lifecycle. `event` is something that happened at a
point in time and is logged from a source: a meeting, call, email, message
or note, or a type the workspace adds, such as a payment or a site visit.
Events are records: they have fields, assertions, relation fields, views and
search like any other record, plus the built-in columns `occurredAt`,
`channel` and `externalId` from `event_identity`, which `query_records` can
filter and sort by and a calendar view can use as its date.

Every workspace has the base event types `meeting`, `call`, `email`,
`message` and `note`, with universal IDs (3.1). Creating an object with
`class: "event"` gives it two core fields, with roles `title` and
`summary`: searchable text, protected (1.1), and `title` is the label
field. The rest of an event type's fields are ordinary fields. The names
`type`, `occurredAt`, `channel`, `externalId`, `participants`, `about`,
`event` and `via` are reserved on event types.

Only logging creates events. `log_event` (`POST /v1/events`) takes `type`,
`occurredAt`, `channel`, `externalId`, `title`, `summary`, `fields` (the
type's other fields, by name), `participants` and `about`, and writes the
record, its `event_identity` row, its initial field values and its links in
one transaction. `upsert_record` and record creation refuse event types
(`422 use_log_event`), but can correct an existing event's fields: later
edits are ordinary assertions with no source and the write time as
`observed_at`, ranked as usual. Events cannot be merged or suggested as
duplicates: each is something that happened, logged from its own source.

The values logging writes are the event's initial values: their assertions
are marked `is_initial`, cite the event itself as their source, and have
the event's `occurred_at` as `observed_at`. No other copy of the payload is
kept, so erasure has one place to clean (2.1).

Logging again with the same `(channel, external_id)` in a workspace returns
the existing event when its type, `occurred_at` instant and initial values
are the same. A retry is compared with the initial assertions, not the
current values, so later edits never break it. Relation values are compared
after resolving merged record IDs to their survivors on both sides. A field
added since logging counts as absent from the original, so a retry that
supplies it conflicts; one that names a field deleted since logging fails
validation, like any write. Participants and `about` records the event does
not have yet are added, after the existing ones, and the response lists them
in `added`; nothing is removed this way, so retries, and syncs that log the
original list again, are no-ops. A participant is the same one when its role
and handle match, or its role and record (after merges) when it has no
handle; an erased handle (2.1) matches another erased handle with the same
role. Adding a participant changes no field value or fact, only which
records list the event. A different payload returns `event_conflict`; it is
never silently ignored. Logging the identity of a deleted event, or one
erased by `forget`, returns `event_retracted`; restoring a source is not in
v1. Concurrent logs of one source create one event: they are serialized by
the write protocol (2, rule 5), and the unique `(channel, external_id)`
index refuses a second identity even across processes, so the loser replans
and finds the event. `channel` must distinguish
source accounts when their external IDs can overlap. Without `external_id`,
callers do not get deduplication. An edited source needs a new
`external_id`; creating it does not retract the old source's claims; a
person deletes the old event (`DELETE /v1/events/:id`).

Participants are who took part. `about` lists the records an event
concerns, of any object, entities or other events, but not the event
itself: the company, project or tasks of a meeting with Dana about the Acme
pilot. The agent names `about` records explicitly. Retainer does not infer
them, for example from a participant's company, since that would move old
meetings when a person changes jobs. A record is linked once per event:
`about` skips a record already linked, a record added as a participant
replaces its `about` link, and a merge drops the `about` link that would
repeat another. Adding links and merging are both workspace writes under
the write protocol (2, rule 5), so a concurrent merge either commits first
and the link goes to the survivor, or commits after it and moves the new
link with the rest.

A relation field on an event type, such as a call's `deal` or a payment's
`invoice`, also attaches the event to the record it points at. It follows
the current value: unlike `about`, a corrected relation moves the event.
Agents are told to prefer `about` for what an event concerns and to keep
relation fields for structure the type owns.

An event is attached directly to a record in three ways, and every list of
a record's events says which, as `via`: `{ kind: 'participant' }`,
`{ kind: 'about' }` or `{ kind: 'field', field }`. An event attached in
several ways appears once, with that precedence. Each resolved link and
each edge of an event's relation field is stored as an `event_attachments`
row, written in the transaction that changes the link or edge; an
unresolved participant stays an `event_links` entry without one until it
is resolved. `query_records` on an event
type takes `linked: { record, link? }` for these events, and
`GET /v1/records/:id/events` and context packs (6.2) list them across types,
newest first.

#### Rollups

An owning relation field of an entity can set `rollUpEvents`. Then the
events attached directly to a record (any of the three ways) also appear in
the history of the records it points at through that field, with
`via: { kind: 'rollup', field, record }` naming the field and the record
they came from: a company sees the calls about its deals. It works for
single-record, `many_to_many` and polymorphic fields and needs no inverse.

- It is stored: `rollup_attachments` holds one entry per target, event,
  field and source record. The transaction that attaches an event to a
  source, or creates, removes or merges an edge of a rollup field, writes or
  removes the matching entries, so a changed relation regroups the events
  at once. `update_field` turns it on or off at any time, as an additive
  change (no review); the same transaction rebuilds the field's entries
  from its edges and the sources' attachments. `via` describes the current
  grouping, never who took part back then; explicit participants and
  `about` are unaffected.
- One hop. What a record has only by rollup does not roll up again, and
  direction is always source to target. An event's own relation field
  attaches it (above) and does not use up the hop: a payment attached to an
  invoice through `payment.invoice` rolls up once through `invoice.company`,
  never onward through the company's `parent`.
- Events only: facts and field values stay on their record.
- An event appears once. A direct attachment wins over a rollup, and among
  several rollup paths the one with the smallest field ID, then source
  record ID, so the same `via` comes back on every read. Pages, counts and
  context budgets see each event once.
- It cannot be set on an inverse field, nor on an event type's fields.

A company with thousands of deals is a wide fan-out, so the read never
gathers it. A record's history is two indexed streams, its
`event_attachments` and its `rollup_attachments`, each read newest first
by target and `occurred_at` in bounded keyset batches, one top-level
statement per stream. They are merged and deduplicated into one keyset page
on (`occurred_at`, ID); another batch is read when deduplication needs it.
Liveness, visibility and event-type filters apply as rows arrive, so a
deleted source or a hidden type needs no rewrite of stored entries. Moving
a source record to another target rewrites its events' entries in one
transaction, a cost bounded by that record's events. Context packs and
`GET /v1/records/:id/events` share this read.

On the pinned SurrealDB release, an indexed `WHERE … ORDER BY … LIMIT`
stops at the limit only when the filter value is a literal or a top-level
parameter. The same statement inside a closure or a `FOR` loop becomes a
table scan, and one with an `IN` list of sources never stops at the limit.
So every read is a point lookup or
a top-level indexed statement per value (spec section 8).

The engine cannot prove a relation is stable, so the setting says nothing
about permanence. Template defaults leave it off on affiliations, ownership
and contact assignments (`person.company`, `deal.company`,
`deal.pointOfContact`, `property.owner`, `project.company`,
`project.primaryContact`, `proposal.company`, `job.company`, the task
relations), where reassigning should not regroup old events. They turn it
on only where a record belongs to its target and a change is a correction:
`appointment.person`, `viewing.property`, `viewing.person`,
`application.person`, `application.job` and `proposal.project`.

`POST /v1/events/:id/links` adds participants and `about` records to a
logged event by ID, with the same matching. Removing one
(`DELETE /v1/events/:id/participants/:participantId` or
`/about/:recordId`) is a person's decision, like other changes that hide
data: an agent's key gets 403.

#### Internal notes

Every fact cites an event (rule 2.1). When `remember` gets no `source`, it
logs an internal note: the fact's text as its summary, the record as its
one `about` link, channel `retainer` (which `log_event` rejects). Internal
notes are records of their own hidden, protected event type with a fixed
universal ID, not of the user-visible `note` type, so hiding them is one
check in object resolution rather than one on every path: `describe_schema`
omits the type; query, view, search, record and write routes resolve it as
not found; context packs and event lists never include it. Its records
change only through `remember` and the fact and privacy lifecycle. A fact
presents such a source as `{ event: null, internal: true }` instead of an ID
callers cannot read. Notes a person or agent logs as `note` events are
ordinary events.

### 1.4 Views

A view is a saved way of looking at one object's records: a table, a board
grouped by a select field, or a calendar on a date field. Views are display
settings, not CRM data. They have no provenance, are not assertions and do
not go through the schema engine; changing one never changes a record.

| Table   | Holds                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `views` | Object, name, `kind` (`table`, `board`, `calendar`), `visibility` (`workspace`, `private`), `position` in the object's list, `config`, actors |

`config` is JSON validated on every write:

| Key              | Holds                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `filter`         | A query filter (5), as `POST /v1/objects/:object/query` takes it                |
| `sort`           | Up to three sort keys                                                           |
| `columns`        | Visible fields in order, their widths and each column's footer calculation      |
| `groupBy`        | Board: the `select` field whose options are the columns                         |
| `hiddenGroups`   | Board: option values (or `null` for "no value") whose columns are hidden        |
| `groupAggregate` | Board: one calculation shown in every column's header, e.g. the sum of `amount` |
| `dateField`      | Calendar: the `date` or `date_time` field records are placed by                 |

Rules:

1. **Fields by key.** Stored config names fields by `fields.key`, like
   the object tables' columns, so renaming a field never breaks a view. The API reads
   and writes field names and translates both ways.
2. **Repaired by the schema change.** Board columns are the group field's
   options as they are when the view is read, so adding or relabelling an
   option needs no change to any view. A schema change that removes a
   field, stops a field being filterable, or removes an option rewrites the
   object's views in the same transaction: the field leaves columns and
   sort, a filter condition that no longer compiles goes, a removed option
   leaves `in` lists (a condition naming nothing else goes), hidden columns
   lose removed options, and a `groupBy` or `dateField` that no longer fits
   is cleared. The view stays, so a board or calendar left without its field
   asks for a new one. Every record has a board column, because the engine
   refuses to remove an option records hold or make a field required while
   records lack it. Reads apply the same repair as a safety net, listing
   anything they drop in the view's `issues`.
3. **Validated like queries.** `filter` and `sort` must compile against the
   current schema, as a query would. `groupBy` must be a filterable `select`
   field and `dateField` a filterable `date` or `date_time` field, because
   each board column and calendar month is a filtered query.
4. **Visibility.** A `workspace` view is visible to every key in the
   workspace and editable by any key with `write`. A `private` view is
   visible and editable only by the actor that created it; to anyone else it
   does not exist (404). Only the creator can change a view's visibility.
5. **Card order is not stored.** Cards in a board column and records on a
   calendar day follow the view's `sort`. Manual ordering would need a
   position that is not a fact about the record, so it is not a field value
   and is not in v1.
6. **Moving a card is a record write.** Dropping a card on another column
   (or a calendar day) is a normal `PATCH /v1/records/:id` of the group (or
   date) field by the person who moved it. It follows every write rule (2),
   so it can come back `pending_review` or `superseded` rather than applied.

Deleting a view removes its row; there is nothing to retract. Deleting an
object deletes its views with it.

---

## 2. Write rules

1. **Nothing is written without an actor and, for derived data, a source.**
   A field write may cite an event as its source (`source` on
   `upsert_record`); without one, the actor is the source. Every fact cites
   an event: the agent passes one, or `remember` creates an internal note
   for it (1.3). A source must be a live event record of a visible type in
   the same workspace: an entity is refused (`invalid_source`), a deleted
   event too (`source_retracted`).
2. **Precedence decides a field's value**:
   `user` > `integration` > `agent` > `system`. Within the same precedence,
   the assertion with the latest
   `observed_at` wins (the source event's `occurred_at`, or the write
   time for direct writes), then server-assigned `created_at`, then assertion
   ID as a deterministic tie-breaker. This prevents an old email from
   overwriting a newer claim at the same precedence. Higher-precedence claims
   remain authoritative until explicitly changed. Clearing a nullable field
   is an assertion with a `null` value; missing keys mean no change. Composite
   fields are replaced as a whole in v1, including their additional values.
   `observed_at` is set by the server: the cited event's `occurred_at`,
   or the write time when no event is cited. Callers cannot set it
   directly.
3. **Agents never silently overwrite people, and are never silently
   ignored.** If the winning assertion is a `user` or `integration` one and
   an agent asserts a different value with a newer `observed_at`, the agent's
   value is stored as `pending_review` and does not change the record's value.
   (Otherwise "Dana moved to Globex" from last week's email would lose to a
   months-old CRM sync and vanish into `superseded`.) An older or equal agent
   value is simply `superseded`. An agent assertion below the workspace's
   confidence threshold is also `pending_review`. Accepting a pending
   assertion re-asserts it with the reviewing user as actor and retaining its source provenance
   and `observed_at`, so a value a person set after the source still stands. Acceptance
   requires a `user` actor with write permission, not an agent choosing a
   reviewer identity.
4. **The value is always recomputable.** For each field, the winner among
   `active` and `superseded` assertions is `active`, the rest `superseded`;
   the field's column holds the winner's value (relation winners instead
   produce edges). With no eligible assertion the column (`NONE`) or edge is
   absent; a winning `null` is stored as an explicit `null`.
   `pending_review` and `rejected` assertions never count. Source retraction
   makes its derived assertions ineligible and recomputes affected fields;
   it cannot let an older `superseded` claim from that source win again.
   Retraction sets every `active`, `superseded` or `pending_review`
   assertion citing the source to `retracted`, which never counts again,
   and recomputes the fields where one of them was winning. If the value
   that would win again is now claimed by another record (1.2), it becomes
   `pending_review` (reason `unique_conflict`) and the next one wins, so a
   retraction always takes effect.
5. **Writes to one workspace are serialized.** Every workspace mutation,
   including review, merge, retraction, `forget`, schema changes and the
   consolidator, is one operation under the write protocol (`mutate()` in
   `db/protocol.ts`); nothing writes around it:
   1. It waits in the process-local queue of its workspace. Other
      workspaces and reads proceed. Only database work happens while the
      queue is held. A caller that waits longer than
      `RETAINER_WRITE_QUEUE_LIMIT_MS` (default 10 s) gets a retryable
      `503 workspace_busy`.
   2. It reads the workspace revision (`workspace_state`), then only what
      the operation needs: the published schema, the records, sources and
      identifier candidates involved. It computes the change in TypeScript,
      recomputing only the touched fields. A domain error found while
      planning (not found, ambiguous, failed precondition) is reported only
      if the revision is still the one it read; otherwise it replans.
   3. It commits one explicit transaction: check that the revision and mode
      are unchanged, increment the revision, write the assertions and every
      projection they touch (columns, edges, identifiers, claims, directory,
      attachments, rollups, search) and the operation receipt (6.2). Every
      write statement checks how many records it affected and throws on a
      mismatch, because the database answers a refused write with an empty
      result, not an error.
   4. A changed revision or a database write conflict rolls the whole
      transaction back, and the operation replans from fresh reads, at most
      five attempts with short jittered backoff. Then it fails with a
      retryable `409 write_conflict`. A partly observed plan is never
      replayed.

   Every writer touches the same revision, so a plan built on a stale read,
   including an identifier's absence, never commits, and two agents
   writing the same record never lose each other's values. The revision
   check holds across processes too; the queue only avoids conflicts in
   one. An optional expected `updated_at` precondition rejects stale direct
   edits and is checked again on every attempt; serialization alone does
   not detect a stale agent's intent. Allocated IDs and server-assigned
   observation times stay the same across an operation's attempts.
6. **Facts are never deleted by the system, only superseded.** Two times are
   kept apart: `valid_from` / `valid_to` say when a fact was true in the
   world; `created_at` says when it was recorded. `valid_from` is the cited
   event's `occurred_at`, or the write time for the internal note that
   `remember` creates; v1 takes no separate effective date. Supersession
   records a correction and preserves provenance. A person can retract a
   fact (soft delete) or hard-delete data for privacy (2.1). Exact historical
   belief snapshots are deferred: the schema has no supersession-event
   timestamp or append-only history of validity edits.

### 2.1 Deletion and privacy

Soft delete (`deleted_at`) is the default for records, events included,
and facts. Reads exclude deleted parents as well as deleted rows: a
record's facts are hidden with it, and links to a deleted record drop out
of an event's participants and `about`. Deleting an event
(`DELETE /v1/events/:id`, or `DELETE /v1/records/:id` on one) also retracts
the claims that cite it and recomputes field winners, and returns how far
that reached; the event's own initial values are not retracted. Facts with
other live sources may remain; a fact with no live source is hidden on
read. Deleting an event type deletes its records through the same
lifecycle, in the same transaction.
A write citing an event (including accepting a pending claim from it)
checks in its plan that the source is live, and the commit's revision check
(2, rule 5) keeps that decision valid, so a claim either commits before the
deletion (and is retracted with the rest) or replans after it, sees the
source deleted and fails.
Restoring a source is not in v1; when added, it must revalidate its derived
claims before exposing them.

`forget` (admin scope) is the hard delete for privacy requests. First collect
the record's identifiers, participant events, dependent facts,
assertions and inbound relation assertions, before any of them is removed.
Then, in one operation that commits as one transaction:

1. add normalized emails and phones to a workspace suppression list using a
   keyed HMAC (a plain hash of a guessable email/phone is insufficient);
2. hard-delete events it took part in and the internal notes `remember`
   wrote about it, with their source quotes, and remove their assertions and
   facts that have no live source. An event that is only `about` the record
   (a meeting about a company) is someone else's conversation: it stays, and
   only the link is deleted. An erased event's identity is replaced by a
   tombstone (below);
3. invalidate inbound relation assertions (removing the record from sets)
   and recompute surviving records'
   field values, links, identifiers and search text. A surviving event whose
   initial values this erases loses its `channel` and `external_id`, which
   are caller-chosen strings that may identify the person, and gets a
   tombstone when it had an external ID;
4. hard-delete the record, its assertions, facts, links and identifiers;
5. write a minimal audit entry (actor ID, time, counts), without copied names,
   handles, summaries, quotes or field values.

Writes coordinate with deletion: creating a record or resolving a
participant checks suppression under the same write protocol as `forget`,
so a suppressed email or phone cannot come back. Background work carries
IDs only, and must not resurrect deleted content. Operation receipts and
error text must not keep erased content either.

How this is built:

- **Who.** `forget` needs the `admin` scope and a `user` actor; an agent
  with an admin key cannot erase a person.
- **What it covers.** The record and every record merged into it. Its
  handles are its current email and phone identifiers, every email or
  phone it was ever claimed to have, and the handles of events it was
  matched in. It "took part in" an event when a participant link points at
  it or carries one of those handles. A forgotten event record is erased
  as an event.
- **Boundary.** The write protocol (2, rule 5). `forget` gathers everything
  in its plan and commits one transaction; a write planned before it
  commits fails its revision check, replans and sees the suppression.
  Primary rows (directory entry, object row, event identity, the claims it
  removes) are deleted by ID with exact effect checks; derived rows
  (assertions, identifiers, links, attachments, rollups, edges, search
  documents, fact sources) are swept by indexed deletes. A failure leaves
  nothing half-erased. A record
  write with a suppressed email or phone fails with `409 suppressed`,
  naming the field but not the value. A suppressed participant handle is
  stored as `null` with the reason `suppressed`.
- **Key.** The HMAC key is `RETAINER_SUPPRESSION_KEY` (at least 32
  characters), kept outside the database so a dump alone does not reveal
  the handles. The HMAC covers the workspace ID, kind and normalized
  handle. Without the key, `forget` fails with `503 not_configured`; if a
  workspace already has suppressions, writes that could add a handle fail
  closed. To rotate the key, set the new one and list the old ones in
  `RETAINER_SUPPRESSION_PREVIOUS_KEYS`: lookups try every key, so earlier
  suppressions keep matching. Dropping an old key without listing it
  forgets the handles it suppressed.
- **Event identities.** A tombstone stores the workspace, the key's ID and
  a keyed HMAC of the JSON encoding of `(workspace_id, channel,
  external_id)` under a domain separator of its own, so it never equals a
  handle's HMAC. It is a retained suppression token, not anonymization.
  `log_event` checks it in its plan, under the write protocol, before
  creating an event or adding retry links, and returns
  `event_retracted` on a match. A tombstone made with a key that is no
  longer configured cannot be checked, so logging in that workspace fails
  closed with `503 not_configured` until the key is listed again. Events
  without an external ID get no tombstone and no deduplication guarantee.
- **Receipts.** Each operation receipt lists the public IDs its result
  mentions (`operations.refs`, indexed per element). `forget` marks every
  receipt that mentions an erased record, event or fact `erased` and clears
  its result, so a replay answers `410 result_erased` and `get_operation`
  answers `erased` (6.2).
- **Response.** IDs and counts only: records, events, facts and assertions
  deleted, inbound relations removed, handles suppressed, the records
  recomputed, and review candidates (other live records, facts and events
  matching the name by phrase search or a handle by text).
- **Shared phones.** The check skips handles the written record already
  holds, so another live record that shares a suppressed phone keeps it
  and can still be edited, but no other record can add it.

Facts on other records that mention the person but rest on other sources
("Acme's champion is Dana") cannot be found reliably. Collect candidates by
name and identifier search before deletion and return their IDs for human
review. This is a deletion workflow, not a guarantee that every mention is
found. Backup retention and deletion after restore are the operator's
responsibility. Suppression entries remain personal data with restricted
access and a documented retention policy.

Shared events are deleted whole (step 2), even when other people took
part. This is the simpler rule and fully removes the person's words, at the
cost of losing what that event said about the others. Redacting only
the person, or keeping other people's facts with a "deleted for privacy"
source, is a possible later refinement.

A workspace's data lives in its own database, so removing that database
removes everything. The operator CLI has no command for it in v1.

---

## 3. Schema engine

One entry point for every schema change, whoever makes it (seed, upgrade,
person or agent). Same pattern as Twenty's migration engine:

1. **Load** the workspace's current published schema, as the plan of an
   operation under the write protocol (2, rule 5), so schema changes and
   writes in one workspace commit one at a time against the revision they
   read.
2. **Apply** the requested operations in memory to get the desired schema.
3. **Validate**: name collisions, reserved names, relation targets, option
   values, type rules.
4. **Diff** current against desired into a list of operations.
5. **Classify** each operation:
   - Additive: create object, create an optional non-unique field, add or
     relabel a select option, change a label, description or label field,
     mark a field filterable/searchable.
   - Destructive: everything else: rename, remove option, delete field or
     object, add a required or unique field, change a field's required or
     unique flag either way, unmark filterable/searchable.
   - Not supported in the first release: changing a field's type. Create a
     new field and deprecate the old one instead.
6. **Apply or propose** (any change needs the `schema:write` scope):
   - All additive: apply at once, as one transaction (below). No per-field
     index jobs in v1.
   - Destructive, requested by a `user` actor with `admin` scope: apply
     directly; the request is the approval.
   - Destructive, requested by anyone else (including an agent holding an
     `admin` key; scope alone is not human approval): store as `proposed`
     in `schema_changes` for such a user to approve or reject. Seed/upgrade
     operations use an explicit trusted administrative path and cannot
     bypass this rule on an agent's behalf.
   - Approving re-runs the engine against the schema as it is then, since it
     may have changed since the proposal. If it no longer validates, the
     change is marked `failed` with the error.

Making a field unique or required first checks existing records; if any
violate it, the change fails with the offending record IDs. Adding a
required or unique field is subject to the same check and approval, not an
additive shortcut. The check runs in the change's plan, against the
revision its commit verifies, so a write cannot race the check or commit
against stale schema. Unique claims for existing values are written in the
same transaction that enables uniqueness.

**Physical definitions.** The engine compiles published metadata into
SurrealDB definitions (`db/physical.ts`): a schemafull table per object, a
typed column per non-relation field and an enforced relation table per
owning relation field (1.1, 1.2). Agents never submit definitions. An
applied change commits in two steps:

1. The new tables, their fields and their indexes are defined first. Each
   index is its own statement, outside any transaction, and is verified
   before anything relies on it: it reports ready, and a unique index
   refuses a duplicate probe inside a cancelled transaction. Nothing writes
   to these tables yet, because they are not in published metadata, so no
   pause is needed.
2. One administrative transaction checks and advances the revision,
   applies the remaining field definitions, writes the metadata and the
   follow-ups the change needs (unique claims, rollup entries, search
   documents, rewritten views) and increments `schema_version`. Definitions
   are transactional on the pinned release, so a failure rolls all of it
   back.

A unique index defined inside a transaction is not trusted: on SurrealDB
Cloud one accepted duplicates. New indexes only ever cover new, empty
tables, since uniqueness lives in `unique_claims`, so no business change
needs to pause writes while an index builds over existing records.

In v1, deleting schema metadata means deprecating it and hiding it from new
writes, not cascading away assertions; its columns and tables stay.
Deleting an object also deprecates
relations that point at it; protected objects and fields (1.1) and an
object's label field cannot be deleted. Removing an option needs approval
and fails while live records use it. A relation's target, cardinality and `onDelete` are fixed once
created; there is no operation to change them.

Standard objects ship as code (definitions with fixed `universal_id`s) and
are applied through the same engine, on its trusted path, when a workspace
is created.

**Upgrading existing workspaces.** At start, under the process lease (4),
the server brings every active workspace up to date, one at a time: first
its fixed tables (11), then its signing-key access methods (7), then the
definitions of its release: the seed (base objects, base event types, the
internal-note type) and each template the workspace applied. A request for
a workspace the server has not reached yet upgrades that workspace first. Elements are matched by `universal_id` whatever their status, so a
renamed element is found and one the workspace deleted is not re-created.
Only what the workspace never had is added: objects with their fields, and
fields of objects it still has. Options, labels, flags and settings of
existing elements are left as they are. The trusted path also protects every
element the protection lists (1.1) name, which workspaces created before
protection lack. An element the workspace's schema cannot take, such as a
base type whose name its own object already uses, is skipped and logged as a
conflict; everything else still applies. Each upgrade is one schema change by
`system:retainer`, an operation under the write protocol, so a concurrent
run replans and finds the workspace current.
`workspace_state.definitions_digest` records the definitions a workspace was last
fully upgraded to, so a run skips current workspaces without loading their
schema and retries conflicted or failed ones. A workspace whose definitions
upgrade fails is reported and keeps its schema; the others still run
(`docs/workspace-upgrade-spec.md`). A failed fixed-table or access-method
upgrade is reported too, and that workspace answers retryable
`503 workspace_upgrading` until it succeeds, because the code expects the
new tables and keys.

### 3.1 Base objects and templates

Every workspace is created with three base objects: `person` (name, emails,
phones, address, job title, company), `company` (name, domain, address,
people) and `task` (title, status, due date, assignee, person, company),
the base event types `meeting`, `call`, `email`, `message` and `note`, and
the hidden internal-note type (1.3). Nobody builds a workspace from scratch.

Templates add the objects and fields a kind of business needs. They ship
as code in `packages/server/src/templates/`, with fixed `universal_id`s
like the base objects, and are applied through the schema engine as owner
`system`. Every template operation is additive, so applying one never needs
approval.

| Template      | For                                     | Adds                                                                                                                                |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sales`       | B2B sales teams, founders selling       | `deal` (stage, amount, close date, company, point of contact); `company` gets industry and employee count                           |
| `services`    | Agencies, consultants, freelancers      | `project` (status, budget, start and end dates, company, primary contact); `proposal` (status, amount, sent date, company, project) |
| `clinic`      | Clinics, therapists, wellness practices | `appointment` (date and time, type, status, person); `person` gets date of birth and preferred channel                              |
| `real_estate` | Agents and brokers                      | `property` (address, type, price, status, owner); `viewing` (date, status, property, person, feedback)                              |
| `recruiting`  | Recruiters, hiring teams                | `job` (title, status, company); `application` (person, job, stage, source)                                                          |
| `blank`       | Anything else                           | Nothing; the agent extends the base objects itself                                                                                  |

**Choosing a template on init.** A new workspace has no template applied
unless the operator passed `--template` (7.1), and `describe_schema` says so (`initialized: false`). An agent that sees this
follows the `discover_schema` guide (6.2): it looks at its user's data,
proposes the closest template plus any additions, and applies them once the
user agrees. Without that, it calls `list_templates`, picks the closest one
from what it knows about the business, or asks its user when it is unsure,
and calls `apply_template`. Choosing `blank` marks the workspace initialized without
adding anything. An agent that cannot decide should not guess: base objects
work without a template, and a template can be applied later.

**Later.** Templates are additive, so a workspace can apply a second one
later (a consultancy that starts recruiting). If a template's object or field
name collides with an existing custom one, applying it fails validation and
the error lists the collisions; nothing is half-applied. Applying a template
the workspace already has is a no-op, whatever its version; a release that
changes a template adds its new objects and fields to workspaces that applied
it when they are upgraded (3), and records the new version.

The workspace records which templates it has applied, with their versions
(`workspace_state.templates`).

---

## 4. Runtime

```
 AI agents ── MCP ───┐       one Retainer process
 Apps / SDK ── REST ─┤──► API · MCP · web app ──────► SurrealDB
 Integrations ───────┘    workers                     catalog database
                          └─ consolidate (scheduled)  one database per workspace
```

One Docker image runs one process per deployment: the REST API, the MCP
endpoint, the web app and the background workers. SurrealDB 4.0.0
(Community, single node, persistent SurrealKV) is the only dependency;
`docker/compose.yml` and CI pin the tested image digest. Retainer calls no
language model and needs no model API key. Separate API and worker
processes, replicas and serverless deployments are not supported:
`RETAINER_ROLE` accepts only `all`.

**Process lease.** At start, the server writes a lease to the catalog: its
holder ID, a heartbeat every 10 s and an expiry 30 s ahead. It refuses to
start while another live lease exists, and it releases the lease at
shutdown. A process that cannot renew its lease stops admitting writes
(`/health` answers 503) and exits. The lease only detects a mistaken second
process, such as an overlapping deploy; it is not coordination. Correctness
across processes still rests on the revision check (2, rule 5).

**Boot order.** The catalog's fixed tables, the lease, interrupted
workspace provisioning, the first-boot workspace and key (7), workspace
upgrades (3), then serving and the worker.

**Transport.** One module (`db/surreal.ts`) talks to SurrealDB, over HTTP
`/rpc` with CBOR encoding and token authentication. Every caller value is a
CBOR parameter, never text in a statement; identifiers in statements come
only from validated metadata, through `ident()`. JSON-RPC parameters are
not used: they turn strings such as `INV:2026` or `2026-11-05` into record
IDs and datetimes. The module checks the HTTP status and every statement's
result, and classifies the conflicts the write protocol retries. A commit
whose response is lost has an unknown outcome, not a rollback (6.2).

### 4.1 How memory gets written

The agent reads the conversation with its own model and decides what is
worth keeping. Retainer only stores, validates and resolves. After a
meeting, call or email thread, an agent typically:

1. **Logs the event** with `log_event`: its type, channel, time, title, its
   own short summary, the type's other fields, the source's external ID, the
   participants as handles (emails, phones) and/or record IDs, and in
   `about` the records it concerns (1.3).
2. **Updates records** with `upsert_record`, citing the event as `source`
   so the values carry its date and provenance (rule 2.2).
3. **Stores facts** with `remember`, citing the same event and an optional
   quote.
4. **Creates tasks** someone committed to, as `task` records.

Participants are resolved synchronously when the event is logged:
handles are normalized (lowercased email, E.164 phone) and matched against
unique identifiers (1.2). Matched participants are linked;
the response lists the unmatched ones so the agent can create those people
itself or leave them. Retainer never creates records on its own. Phones are
not unique (numbers are shared and reassigned), so a participant known only
by phone stays unresolved unless the agent passes its record ID. Matching a
phone held by exactly one live record is a later option.

A record ID the agent passes, as a participant or in `about`, is used as
given, after following merges; an unknown or deleted one fails the call,
since the agent named it explicitly.
An email claimed by several live records (two unique email fields on
different objects) is not matched to any of them: it comes back `ambiguous`
with the candidates (1.2). `occurred_at` must carry a UTC offset and may not
be in the future (beyond a few minutes of clock skew): it decides precedence
(rule 2.2), so a time-zone slip would otherwise let a claim win for hours.

Each write is its own operation (2, rule 5), and each follows the write
rules, so an agent that stops halfway leaves consistent data; it can
resume, and `external_id` and idempotency keys (6.2) make retries safe. A
write whose response was lost is checked with `get_operation` (6.2) before
it is retried.

### 4.2 Consolidator (scheduled per workspace)

- Supersede exact duplicate facts (same record, same normalized text and
  validity interval) with a canonical fact, retaining the originals and all
  source links. Identical text at different effective times may describe
  separate events and is not an exact duplicate.
- Near-duplicates are never superseded in v1; they stay separate claims,
  each with its own wording, dates and citations.
- Contradictions remain separate, cited claims unless a user or an explicit
  correction in the source resolves them; model confidence alone cannot
  silently supersede a claim.
- Suggest merges of duplicate records (same person, two records), found
  through shared identifiers and similar names. Suggestions only; a `user`
  actor performs the merge (an agent's key scope is not human approval, as
  in 3). Suggestions are stored as rows (`merge_suggestions`: the two
  record IDs, reason, status) so `GET /v1/review` can list them.

Flagging stale field values is deferred: "stale" has no definition yet and
nothing reads the flag.

How this is built:

- **Scheduling.** The worker runs inside the server process. Every minute
  it goes through the active workspaces, consolidates each one whose last
  run started longer ago than `RETAINER_CONSOLIDATE_INTERVAL_MINUTES`
  (default 60), and deletes its expired operation receipts (6.2). Each run
  is one operation under the write protocol (2, rule 5), without a receipt,
  so it queues behind that workspace's writes and never interleaves with
  them or with `forget`. `consolidator_runs` holds the last start, the
  stats, and `compared_until`.
- **Exact duplicate facts.** Duplicates are current facts of the same live
  record with equal text after trimming, collapsing whitespace and
  lowercasing, and equal `valid_from` and `valid_to`. The oldest is the
  canonical fact. It gains each duplicate's source links; the duplicates
  keep theirs and get `superseded_by`. A fact retracted while the run plans
  fails its revision check, and the run replans without it.
- **Merge suggestions.** Two live records of the same object are suggested
  when they share an email, phone or website domain identifier
  (`shared email`, `shared phone`, `shared domain`), or when their labels
  are at least three characters long and similar (`similar names`): up to
  20 candidates per changed record come from the trigram label index
  (5.1), and a pair is kept when the Jaro-Winkler similarity of the folded
  labels is at least 0.9. "Dana Cohen" and "Dana Coheen" pass; "Dana Cohen"
  and "Ron Peretz" do not. The reason never copies values. Only
  records updated since the last run's `compared_until` (its start minus
  five minutes, read from the directory's indexed `updated_at`) are probed,
  and each kind adds at most 500 new suggestions
  per run; pairs that already have a row don't count toward that. A run
  that reaches the cap keeps the previous `compared_until`, so the next
  run picks up the pairs it left. A pair keeps one row, so a dismissed or accepted pair is never
  suggested again. When a record is merged away or deleted, its other
  pending suggestions are closed as `dismissed` in the same transaction,
  so review only lists live pairs. The facts pass likewise compares only
  records that gained a fact or changed since `compared_until`.
- **Dismissing.** `POST /v1/review/merges/:id/dismiss`, as a `user`.
- **Merging.** `POST /v1/records/:id/merge` with `{ "recordId": "<B>",
  "values"?: {…} }`, as a `user` with the `write` scope; `values` overrides
  any field. It takes an `Idempotency-Key`. Merging the record in the path
  into itself is `422`. If B is already merged into A it is a no-op
  (`merged: false`); if A was merged into B it is `409 record_merged`. On
  success the pair's pending suggestion becomes `accepted`, and records
  previously merged into B now point at A, so every merge chain is one hop.
  Only the fields B had claims for are recomputed.
- **Concurrency.** A merge, a relation write and logging are each one
  operation under the write protocol (2, rule 5). So a link to B written
  during a merge either commits first and is rewritten by the merge, or
  replans after it and points at A. A merge that loses a race to another
  merge replans and sees the result.
- **Self-links.** No field disallows them in v1, so a relation from A to B
  becomes a link from A to A.

**Merging** record B into A moves B's assertions, facts, links, identifiers
and participant matches to A, recomputes A's values with the normal write
rules, and soft-deletes B with `merged_into = A`. Reads of B return A.
The merge is one transaction over two records of the same object. Rewrite
inbound relation assertions (found through `field_assertions.refs`) as well as
edges, preserving their provenance; reject self-links where disallowed.
Resolve canonical IDs before merging, prevent cycles, and revalidate unique
claims before committing. Otherwise a later cache rebuild undoes the merge.
Because composite assertions replace whole values, merely moving B's
identifiers would lose them on recomputation. For `emails`, `phones` and
`links`, the merge writes a composite assertion as the merging user: combine
the two current winners, deduplicate, keep A's primary if present (otherwise
B's), and place the remaining values in `additional`. The request may
override these defaults. Exceeding a field's `maxValues` fails for explicit
resolution; nothing is silently truncated. Other composites (`money`,
`full_name`, `address`) have no `additional` array and follow normal
whole-value precedence unless the request explicitly overrides them.
Identifiers are rebuilt from the resulting winners. Only current winners
are combined, never the full assertion history.

Not in the first release: inferring facts from other facts
(`kind = inferred`). The fixed tables keep the `kind` column and premise
links so it can be added without changing them.

### 4.3 No language model inside Retainer

Retainer never calls a language model or an embedding provider. Every
judgment about what a conversation means is made by the agent, with the
agent's own model. This keeps self-hosting free of model keys and LLM cost,
keeps full conversations with the agent, and keeps Retainer's behavior
deterministic and testable.

---

## 5. Read paths

| Operation                          | What it returns                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `describe_schema`                  | The workspace (ID, name, applied templates, `initialized`), its objects and fields, and `builtIns`                 |
| `query_records`                    | Structured filter, sort and pagination over one object; for an event type, its built-in columns and `linked` (1.3) |
| `get_record`                       | One record with its fields and links; an event also with its built-in columns, participants and `about`            |
| `search`                           | Keyword search (SurrealDB full-text) across records, events and facts                                              |
| `get_context(record, tokenBudget)` | A ready-to-use pack: key fields, current facts, open tasks, recent events, fitted to the budget                    |
| `get_timeline(record, filters)`    | The record's history, newest first: events, asserted field values and facts (6.2)                                  |

`builtIns` lists facts, apart from `objects`, so a person reading the
schema sees that the workspace keeps them and no client mistakes them for
something `upsert_record` writes. Event types are objects of class `event`
(1.3); the internal-note type is never listed.

Every read hides soft-deleted parents/rows and superseded facts by default.
An explicit history mode can list retained assertions and facts with their
source and validity dates; exact `as_of` snapshots are deferred. Context
packs distinguish stated facts from current field values and show who wrote
each. They are assembled by rules (recency, precedence, the token budget),
not summarized by a model; summarizing is the agent's job.

### 5.1 Search

Search is SurrealDB full-text search with BM25 ranking, over one
rebuildable projection, plus explicit normalized identifier lookup (1.2).
No embeddings, no semantic search and no model.

#### What is indexed

`search_documents` holds one row per live, visible record (events
included) and one per live fact. Each fact carries its `record`, and each
event hit its linked record IDs (possibly none or several), so a hit on a
fact or event also points to records.

| Column       | Holds                                                                                                                    | Full-text index    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `all_text`   | A record's label plus the values of its `is_searchable` fields and the domain of each email and link; a fact's `content` | `rt_prefix`, BM25  |
| `folded`     | The same text, lowercased with accents removed                                                                           | `rt_exact`, BM25   |
| `label_text` | The label field as plain text (usually the name, an event's title)                                                       | `rt_prefix`, BM25  |
| `grams`      | The label again, for fuzzy candidates                                                                                    | `rt_trigram`, BM25 |

The three analyzers split text on blanks, changes of character class and
punctuation, and fold it to lowercase without accents ("José" matches
"jose"). No stemming and no language-specific rules: it behaves the same
for every language.

- `rt_prefix` adds edge n-grams, so a word matches every prefix of
  itself: "Dan" finds "Dana" and "meet" finds "meetings", for people typing
  in the web app and for agents alike. Punctuation splits an email or a
  host into words, so "acme" also finds "dana@acme.com".
- `rt_exact` keeps words as typed, so hits that match the words exactly
  rank above hits that only match a longer word.
- `rt_trigram` splits the label into three-letter grams for fuzzy matching
  ("Dana Levy" finds "Dana Levi") and for the consolidator's similar-name
  suggestions (4.2).

The server writes a record's or fact's document in the same transaction
that writes the values it indexes. A schema change that changes the label
field, a searchable flag or an option label, or deprecates a field,
rewrites the documents of that object's live records in the same
transaction. Events are records, so they share the records' documents; an
event's title and summary are always searchable (1.3). Every read still
checks liveness and visibility, so a stale document never surfaces a
hidden record. Merged-away and deleted records keep no document.

#### How a search runs

1. The server parses the query itself: words are all required, `OR`
   between two terms makes either one enough, `-word` excludes, and a
   quoted phrase needs its words in order. The query is folded like the
   stored text.
2. Every word matches through the prefix index on `all_text`.
   SurrealDB has no native phrase match, so a phrase's words match through
   the index and the phrase is then checked against `folded` with a
   whole-word pattern.
3. The server runs one query each on entity records, events and facts,
   each a top-level statement over the index. Liveness and visibility
   filters (and, for facts, "current, not superseded") apply before the
   limit. The internal notes `remember` creates are left out: their text is
   the fact's, so it is found with the fact, or hidden with it once the
   fact is retracted.
4. Each list is ranked by its BM25 score, with the exact-word score first,
   so words matched as typed rank above prefix-only matches.
5. If the records query finds nothing, even by prefix, trigram candidates
   of the label (`@OR@` over `grams`) are reranked by Jaro-Winkler
   similarity, so "Dana Levy" finds "Dana Levi".
6. Results come back grouped by type. Each hit carries its record IDs and
   its text as stored: a record's label, a fact's content, an event's type,
   time, title and summary. A record hit says whether it matched the text or only
   a similar label. Scores from the three lists are not comparable and are
   not merged.

Prefixes cover endings ("meeting" finds "meetings"); agents cover other
word forms themselves: the `search` tool description tells them to add
variants with `OR` ("ran OR run").

`query_records` takes keywords too (`search`, within one object, as the web
app's record pickers use it): every word required, each matched as a
prefix, accents folded.

#### Ranking

BM25 weighs a rare word above one that appears everywhere in a workspace.
Scores are relative to one index and one query; they are not a confidence.
Label and exact-identifier precedence is kept through the exact-word score
and identifier lookup, not by matching a particular numeric score.
Tokenization differences (what splits a word, what a prefix matches) are
fixed with contract fixtures and documented with examples, not hidden
behind embeddings or a model fallback.

There is no `ask` endpoint: answering questions is the agent's job. It
composes `search`, `query_records` and `get_context` with its own model.

---

## 6. Interfaces

### 6.1 REST (`/v1`)

| Route                                             | Purpose                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`                                      | Caller workspace, actor and scopes                                                                                                      |
| `GET /v1/schema/changes` · `/:id`                 | Paginated change history or one change                                                                                                  |
| `GET /v1/schema`                                  | Current schema                                                                                                                          |
| `POST /v1/schema/changes`                         | Request a schema change (applied or proposed)                                                                                           |
| `POST /v1/schema/changes/:id/approve` · `/reject` | Decide a proposed change                                                                                                                |
| `GET /v1/templates`                               | Templates and what each adds (3.1)                                                                                                      |
| `POST /v1/templates/:name/apply`                  | Apply a template (needs `schema:write`)                                                                                                 |
| `POST /v1/objects/:object/records`                | Create a record                                                                                                                         |
| `POST /v1/objects/:object/query`                  | Filter, sort and page records; optional object-scoped keyword lookup                                                                    |
| `POST /v1/objects/:object/aggregate`              | Count and per-field totals (empty, unique, sum, average, min, max) over a filter, optionally per option of a `select` field (`groupBy`) |
| `GET` · `POST /v1/objects/:object/views`          | The object's saved views (1.4), or save a new one                                                                                       |
| `GET` · `PATCH` · `DELETE /v1/views/:id`          | One saved view                                                                                                                          |
| `POST /v1/objects/:object/upsert`                 | Update or create a record found by `id` or `match`, with `ifMissing` (6.2)                                                              |
| `GET` · `PATCH` · `DELETE /v1/records/:id`        | One record                                                                                                                              |
| `GET /v1/records/:id/delete-impact`               | Records a delete would cascade to, at any depth, counted by object                                                                      |
| `POST /v1/records/delete-impact`                  | The same for several records deleted together, overlaps counted once                                                                    |
| `GET /v1/records/:id/assertions`                  | Paginated per-field assertion history                                                                                                   |
| `GET /v1/records/:id/events`                      | Paginated events attached to a record, newest first, each with `via`; `link` narrows to participant, about or field (1.3)               |
| `GET /v1/assertions/:id`                          | One assertion, including status and review details                                                                                      |
| `GET /v1/events/:id/claims`                       | Paginated assertions and facts citing an event                                                                                          |
| `GET /v1/records/:id/context`                     | Context pack                                                                                                                            |
| `GET /v1/records/:id/timeline`                    | The record's timeline (6.2): `types`, `fields`, `eventTypes` (comma-separated), `from`, `to`, `limit`, `cursor`                         |
| `POST /v1/records/traverse`                       | Bounded walk from start records along relation fields and event links (6.2)                                                             |
| `GET /v1/operations/:id`                          | What became of a write, by its operation ID (6.2)                                                                                       |
| `GET /v1/operations?kind=&idempotencyKey=`        | The same, by the operation kind and the idempotency key the write was sent with                                                         |
| `POST /v1/records/:id/merge`                      | Merge another record into this one                                                                                                      |
| `POST /v1/records/:id/forget`                     | Hard delete for privacy requests (2.1)                                                                                                  |
| `GET` · `POST /v1/records/:id/facts`              | Facts about a record                                                                                                                    |
| `DELETE /v1/facts/:id`                            | Retract a fact (soft delete)                                                                                                            |
| `GET /v1/review`                                  | Pending assertions, suggested merges, participants matching deleted records                                                             |
| `POST /v1/review/merges/:id/dismiss`              | Dismiss a suggested merge (4.2)                                                                                                         |
| `POST /v1/assertions/:id/accept` · `/reject`      | Decide a pending assertion                                                                                                              |
| `POST /v1/events`                                 | Log an event: 201 when created, 200 for a retry; returns matched and unmatched participants (4.1)                                       |
| `GET` · `DELETE /v1/events/:id`                   | Read an event, or delete it and retract what cites it (2.1)                                                                             |
| `POST /v1/events/:id/links`                       | Add participants and `about` records (1.3)                                                                                              |
| `DELETE /v1/events/:id/participants/:pid`         | Remove a participant (a person only)                                                                                                    |
| `DELETE /v1/events/:id/about/:recordId`           | Remove an `about` record (a person only)                                                                                                |
| `POST /v1/search`                                 | Keyword search (5.1)                                                                                                                    |

Web sign-in and sign-out use `POST` and `DELETE /auth/session`, outside
`/v1`; see section 7 for cookie and CSRF rules. `GET /health`, also outside
`/v1` and needing no key, reports the version and database status (503
when the database is unreachable, or after the process lost its lease, 4).
Every `/v1` response that ran a write carries a `Retainer-Operation-Id`
header (6.2); bodies keep their shapes. Record reads optionally include
winning provenance, pending previews and relation references. Review responses
include totals and separate cursors for each collection (FRONTEND.md 9.1).

An OpenAPI document generated per workspace from its schema is planned but
not built yet; docs/rest-api.md lists every route.

### 6.2 MCP

Hosted on the API server at `/mcp` (Streamable HTTP). `@retainer/mcp` is a
small stdio bridge for local clients that only speak stdio.

Tools are generic, not one per object. Custom objects would otherwise grow
the tool list without limit and break clients' tool caching.

`describe_schema`, `list_templates`, `apply_template`, `get_guide`,
`query_records`, `get_record`, `traverse_records`, `get_operation`, `search`,
`get_context`, `get_timeline`, `upsert_record`, `log_event`, `remember`,
`propose_schema_change`. Events are listed with `query_records` on their
type, so no tool is needed per event type.

**Guides.** `get_guide(name)` returns step-by-step instructions, as
markdown, for a task an agent does rarely. Each guide is also an MCP prompt
of the same name, so a person can start it from their client (a slash
command in Claude Code); tools reach every agent, prompts only the clients
that show them. `discover_schema` has the agent
find and sample its user's sources on its own (an existing CRM first, then
spreadsheets, email and calendar), asking its user only for what it cannot
find, propose a template and additions tied to that evidence, wait for
the user's approval, then apply them with `apply_template` and
`propose_schema_change`. It changes only the schema;
importing data is a separate step. Guides are static text in
`packages/server/src/mcp/guides.ts`: Retainer reads none of the user's
sources and calls no model (4.3). The server instructions point an agent
at `discover_schema` when the workspace is not initialized.

`schema_design` holds the rules for growing or reviewing a schema in use;
`discover_schema` includes the same rules. Agents change the schema
mid-task, long after setup, so the `propose_schema_change` description
carries the short form and the server instructions point to the guide.
Each reserved object name carries its reason, so an object named
`interaction`, `event` or `fact` fails with the feature to use instead
(`log_event`, or an event type; `remember`).

In v1 an agent is connected to exactly one workspace through one API key.
Every call acts on that workspace, so no tool takes a workspace parameter.
`describe_schema` still returns the workspace's ID and name for logs and
for the agent's own context. Agents that work across several workspaces,
and any search or query across workspaces, are out of scope for v1.

Inputs are validated at runtime against the workspace schema, and validation
errors name the field and the allowed values so the agent can retry.

`remember(record, text, source?, quote?)` writes one `stated` fact at once,
citing `source` (an event ID) with an optional quote. Without `source`, it
creates an internal note for the fact to cite (1.3).

`upsert_record` accepts an optional `source` (an event ID). Values from a
conversation should cite it, so they carry the event's date as
`observed_at` (rule 2.2) and an older email cannot overwrite a newer claim.

The tool descriptions spell out the workflow in 4.1, so an agent knows to
log the event first and cite it in the writes that follow.

#### Finding the record to update

`upsert_record` finds its record in one of two ways:

- `id`: an explicit record ID. An ID merged into another record resolves to
  the surviving one.
- `match`: one unique field and its value, for example
  `{ "emails": "dana@acme.com" }`, looked up in `record_identifiers` with the
  conflict rules in 1.2. Only `is_unique` fields are accepted. Names and
  phones are rejected with an error that points the agent to `search` or
  `query_records`.

With neither, the call creates a new record.

`ifMissing` decides what happens when `id` or `match` finds nothing:
`"fail"` (the default) or `"create"`. The default is `"fail"` so that "update
Dana's address" can never create a new person by accident. With `"create"`,
the `match` value is written to the new record.

```
→ upsert_record {
    "object": "person",
    "match":  { "emails": "dana@acme.com" },
    "values": { "address": { "street1": "12 Rothschild Blvd", "city": "Tel Aviv" } } }
← { "id": "rec_9f2…", "created": false, "fields": { "address": "applied" }, "record": { … } }
```

The response reports each field as `applied`, `pending_review` or
`superseded` (rule 2.3), so an agent can tell its user that an update is
waiting for approval rather than claim it is done. `record` is the record
after the write, as `get_record` returns it.

An agent that knows only a name or a phone number searches first
(`search` or `query_records`), then updates by `id`. With several
candidates, it tells them apart by company, email or recent events, or
asks its user.

Create-style writes (`remember`, record creation and merge requests) accept
a caller idempotency key scoped by workspace and operation kind
(`remember`, `create_record`, `merge`), so a retry after a key rotation or
from another of the workspace's keys still deduplicates. Every public
mutation gets an operation ID and commits an operation receipt
(`operations`: kind, idempotency key, request hash, result, the IDs the
result mentions, expiry) in the same transaction as its effects; a unique
`(kind, idempotency_key)` index holds one receipt per key. A retry finds
the receipt before planning and returns the original result; reuse with a
different payload fails with `422 idempotency_key_reused`. Identifier
matching alone does not make note creation or assertion history
idempotent. A merge request is already idempotent by state (B already
merged into A is a no-op). `event_identity.external_id` covers logging
events.

A record write's receipt keeps only `{ id, created, fields }`, and the
record is presented from a fresh read, so a replay shows the record as it
is now, with the original per-field statuses. `log_event`, `remember`,
merges and deletions keep their whole result. Receipts are kept for 24
hours; the worker deletes expired ones (4.2).

#### Unknown outcomes and `get_operation`

A lost response is an unknown outcome, not a rollback: the write may have
committed. When the database does not answer a commit in time, the call
fails with `503 unknown_outcome`, and `details.operationId` names the
operation. Every `/v1` response that ran a write also carries that ID in
the `Retainer-Operation-Id` header.

`get_operation` (`GET /v1/operations/:id`, or
`GET /v1/operations?kind=&idempotencyKey=`; SDK `getOperation`) says what
became of a write, by its operation ID or by the kind and idempotency key it
was sent with. It is a read, scoped to the key's workspace like every
other:

```
→ get_operation { "kind": "remember", "idempotencyKey": "call-8812-fact-1" }
← { "operationId": "op_3c9…", "kind": "remember", "status": "completed",
    "result": { "fact": { … } },
    "createdAt": "2026-10-29T12:00:03Z", "expiresAt": "2026-10-30T12:00:03Z" }
```

`status` is `completed` (with the original result), `erased` (a `forget`
erased what the result mentioned; `result` is `null`, 2.1) or
`not_observed`: no receipt, or one past its 24 hours. `not_observed` does
not mean rolled back: the original request may still commit, so retry only
with the same idempotency key, which stays safe. An agent therefore keeps
its idempotency key before a write that takes one. Requests sent without a
key are not deduplicated across client retries.

Other errors that are safe to retry say so with `details.retryable: true`:
`503 workspace_busy` (the workspace's write queue, 2), `503 schema_busy`,
`409 write_conflict` (the protocol's retries ran out), `503
workspace_upgrading` (3, 7) and `503 not_accepting_writes` (the server is
shutting down).

#### Traversal

`traverse_records` (`POST /v1/records/traverse`, SDK `traverseRecords`)
walks from a few start records along an explicit path and returns the
paths it found, each hop with its evidence. It answers questions such as
who connects a deal's decision-maker to someone we have met:

```
→ traverse_records {
    "starts": [ "rec_d31…" ],
    "path": [ { "field": "decisionMaker" },
              { "link": "participant", "direction": "in" },
              { "link": "participant", "direction": "out" } ] }
← { "schemaVersion": 42,
    "paths": [ { "records": [ { "id": "rec_d31…", "type": "deal", "label": "Acme pilot" },
                             { "id": "rec_9f2…", "type": "person", "label": "Dana Levi" },
                             { "id": "evt_51b…", "type": "meeting", "label": "Acme pilot review" },
                             { "id": "rec_5a1…", "type": "person", "label": "Noa Shapira" } ],
                 "steps": [ { "field": "decisionMaker", "direction": "out", "assertionId": "as_11…" },
                            { "link": "participant", "direction": "in", "eventId": "evt_51b…", "linkId": "ip_1…" },
                            { "link": "participant", "direction": "out", "eventId": "evt_51b…", "linkId": "ip_2…" } ] } ],
    "examinedEdges": 7,
    "limits": { "starts": 20, "steps": 3, "examinedEdges": 500, "paths": 50 },
    "truncated": null }
```

- A step is a relation field, `{ field, direction }`, or a built-in event
  link, `{ link: "participant" | "about", direction }`. For a field, `out`
  (the default) follows it from the current records, and an inverse name
  follows its owning field backwards; `in` finds the records whose field of
  that name points at the current ones. For a link, `in` goes from records
  to their events, `out` from events to their records.
- Start IDs follow merges. An unknown, deleted or hidden start fails with
  `422 invalid_starts`, a name that is no visible relation field with
  `422 invalid_path`. Paths are validated against the visible schema and
  never revisit a record.
- Evidence is the assertion an edge derives from, or the event and link
  ID of an event link.
- Hard caps: 20 start records, 3 steps, 500 examined edges in total and 50
  returned paths. Every edge read counts, including those then discarded
  (a deleted or hidden record, a link of the other kind). Each expansion
  reads an indexed window per frontier record, one top-level statement
  each, never more than the budget left. When a window would exceed the
  budget the result says `truncated: "edge_budget"`; more than 50 complete
  paths say `"path_limit"`. A capped result does not claim completeness.
- Ordering is deterministic. There is no traversal cursor, no recursion
  and no filter beyond the path: select the start records with
  `query_records`. Traversal does not change rollup depth (1.3).

Several agents can share a workspace. Each uses its own API key, so every
write is attributed to the agent that made it; between agents the latest
`observed_at` wins and the full history stays in `field_assertions`.

#### Responses of the memory tools

Record writes return the shape shown above. `log_event`, `remember`
and `get_context` return the following. IDs are UUIDs; the examples shorten
them and add a type prefix for readability.

```
→ log_event {
    "type": "call", "channel": "zoom", "externalId": "zoom-8812-3390",
    "occurredAt": "2026-10-29T14:00:00+02:00", "title": "Acme renewal call",
    "summary": "…", "fields": {},
    "participants": [ { "handle": "dana@acme.com", "role": "customer" },
                      { "handle": "ron.peretz@acme.com", "role": "customer" } ],
    "about": [ "rec_a11…" ] }
← { "id": "evt_51b…", "type": "call", "created": true,
    "participants": {
      "matched":   [ { "id": "ip_1…", "handle": "dana@acme.com", "role": "customer", "recordId": "rec_9f2…" } ],
      "unmatched": [ { "id": "ip_2…", "handle": "ron.peretz@acme.com", "role": "customer", "reason": "no_match" } ] },
    "about": [ "rec_a11…" ] }
```

`created` is `false` when the same `(channel, externalId)` was already
logged with the same type, time and initial values (1.3); the response then
also has `added`, the participants and `about` records this call added, in
the same shapes. Handles come back normalized, in the order logged; `handle`
or `role` is `null` when not given. Each participant's `id` names the link,
for removing it. An unmatched
participant's `reason` is `no_match`, `phone_only` (phones never resolve a
participant on their own, 4.1), `deleted_record` (the handle belongs to a
soft-deleted record that was not merged; it is also listed in
`GET /v1/review`, 1.2), `ambiguous` (several live records claim the
handle; `candidates` lists their IDs, 1.2) or `suppressed` (the handle was
erased by `forget`; it is not stored, and `handle` is `null`, 2.1).

`DELETE /v1/events/:id` returns how far the retraction reached:
`{ id, deleted: true, retractedAssertions, recomputedRecordIds,
hiddenFactIds }`, the last being facts whose only live source it was.
`DELETE /v1/records/:id` returns the same counts when what it deletes
includes events.

```
→ remember {
    "record": "rec_9f2…", "text": "Legal review at Acme usually takes two weeks.",
    "source": "evt_51b…", "quote": "legal usually needs two weeks with these" }
← { "fact": {
      "id": "fct_77a…", "record": "rec_9f2…",
      "content": "Legal review at Acme usually takes two weeks.",
      "kind": "stated", "validFrom": "2026-10-29T12:00:00Z", "validTo": null,
      "writtenBy": { "type": "agent", "id": "…", "name": "Inbox agent" },
      "sources": [ { "event": "evt_51b…", "quote": "legal usually needs two weeks with these" } ] } }
```

`validFrom` is the cited event's `occurred_at` (rule 2.6). Without
`source`, the fact rests on an internal note (1.3), `validFrom` is the
write time, and its source is presented as
`{ "event": null, "internal": true, "quote": null }`. A `quote` needs a `source`. A retry with the
same idempotency key returns the same response.
`GET /v1/records/:id/facts` returns `{ record, facts, nextCursor }` with facts
in this shape, newest `validFrom` first, listing only live sources. It pages
with `limit` (default 100, at most 500) and `cursor`.

```
→ get_context { "record": "rec_5a1…", "tokenBudget": 1500 }
← { "record": {
      "id": "rec_5a1…", "object": "person", "label": "Noa Shapira",
      "fields": {
        "jobTitle": { "value": "Head of Data", "writtenBy": { "type": "user", … }, "observedAt": "…" },
        … } },
    "openTasks": [ { "id": "rec_c40…", "title": "Send SSO docs to Noa", "status": "todo", "dueDate": "2026-11-04" } ],
    "facts": [ { "id": "fct_1e2…", "content": "Needs SSO before agreeing to a pilot",
                 "validFrom": "2026-10-21T09:00:00Z", "writtenBy": { "type": "agent", … },
                 "sources": [ "evt_9d0…" ] } ],
    "recentEvents": [ { "id": "evt_9d0…", "type": "meeting", "occurredAt": "2026-10-21T09:00:00Z",
                        "title": "Globex data-platform demo", "summary": "…",
                        "via": { "kind": "participant" } } ],
    "omitted": { "openTasks": 0, "facts": 4, "recentEvents": 11 },
    "tokenEstimate": 1380 }
```

A context pack is assembled by fixed rules (5):

- The record's current field values are always included, each with who
  wrote it and when it was observed, so a value is never mistaken for a
  stated fact. The budget applies to the sections after it.
- The other sections fill in this order until the budget is spent: open
  tasks (tasks linked to the record through an active relation field whose
  status is not `done`, earliest due date first, undated last), current facts (not superseded or retracted,
  newest `validFrom` first; a fact resting only on an internal note is
  marked `internal: true`), then recent events in the record's history
  (attached directly or rolled up, newest first, each once with `via`, 1.3,
  without internal notes, whose text is already a fact). Items
  are never cut mid-text; a section stops at the last whole item that fits.
- `omitted` counts the items left out of each section, so the agent knows
  to read more with `search` or the REST routes.
- Tokens are estimated from characters, at about four per token. Retainer
  runs no tokenizer or model, so the budget is approximate. `tokenBudget`
  defaults to 2000 and is capped at 16000.
- The budget covers the whole response, keys, commas and `omitted` included:
  once the record's values fit, the pack's JSON is never longer than
  `tokenBudget × 4` characters. `tokenEstimate` is that length in tokens. No
  fixed row limit applies; the budget alone decides what is left out.

#### Timeline

`get_timeline` and `GET /v1/records/:id/timeline` show how a record got to
where it is. They return `{ record, items, nextCursor }`, assembled from the
source tables at read time:

| Item           | What is included                                                                     | `at`                     |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| `event`        | The record's event history: direct and rolled-up events, each once with `via` (1.3)  | The event's `occurredAt` |
| `field_change` | Each `active` or `superseded` assertion for one of its active fields                 | `observedAt`             |
| `fact`         | Its facts, current, superseded or ended; never retracted or resting on no live event | `validFrom`              |

A `field_change` is a value someone asserted, not proof the record ever
held it: `superseded` only means another assertion won later, or won
already. It carries the assertion ID, `status`, `current` (whether it is the
value the record holds now), the actor, confidence and the event it cites,
and the asserted value, never a diff. For a set that is the whole asserted
membership. A client wanting "added" or "removed" compares against the
winning value at that time, which the API does not claim to know. Pending
and rejected assertions stay in review and the assertion routes. Internal
notes never appear as events; a fact resting on one says `internal: true`.

Items are ordered by `at` descending, then kind (`event`, `field_change`,
`fact`), then ID descending. Each kind is read by keyset from its own table,
at most a page of each, and the server merges them, so equal times page
exactly; the event branch is the deduplicated rollup query (1.3), so an
event counts once before the limit. The opaque cursor holds the whole sort
key and a digest of the record and filters, and is refused (`invalid_cursor`)
for another record or other filters. Filters: `types`, `fields` (field
names, matched by field identity, so a rename keeps a cursor valid),
`eventTypes`, and `from` (inclusive) to `to` (exclusive). `fields` or
`eventTypes` alone narrows the page to its kind; with `types`, each filter
applies to its own kind and the others come back too.

Pages reflect current visibility and relations, not a snapshot: a backdated
event or a changed relation can change later pages. Exact intervals during
which a value was the winner, and an audit stream of retractions, are not
part of it.

---

## 7. Tenancy and auth

The optional web app signs in at `POST /auth/session`, which turns a person's
API key into an HTTP-only `retainer_session` cookie (`SameSite=Strict`, path
`/`, 30-day max age, Secure except on localhost). The cookie contains the key;
revocation is checked on every request. `DELETE /auth/session` clears it.
`GET /v1/me` returns the workspace, actor and scopes. Explicit bearer headers
win over cookies, including when the header is invalid. Cookie-authenticated
mutations require `X-Retainer-Client: web` and reject a mismatched Origin;
this applies to the shared REST/MCP authentication middleware. Sign-in and
sign-out also require the header. The browser stores no key in local storage.

For TLS termination at a reverse proxy, set `RETAINER_PUBLIC_ORIGIN` to the
external origin (for example `https://retainer.example`). CSRF checks compare
the browser Origin to this configured value; forwarded headers are not trusted.
The setting also controls the cookie's public host and Secure handling.

Web read routes add paginated assertion history, record events, event
claims, review totals/cursors, and optional winning provenance
and batched relation references. Object queries accept an optional `search`
keyword string for full-text lookup within one object; workspace-wide search
is `POST /v1/search` (5.1). All use the same runtime sessions as other
routes. They do not change the assertion-backed write rules.

- **Catalog and workspace databases.** Everything lives in one SurrealDB
  namespace (`RETAINER_SURREAL_NAMESPACE`, default `retainer`). The
  `catalog` database holds the workspaces with their database routes and
  provisioning state, the hashed API keys with their scopes, actors and
  revocation, and the process lease (4). CRM records never live there. Each
  workspace has its own database, `ws_<workspace ID without dashes>`, with
  every table of section 1. A workspace's route comes from the
  authenticated key's lookup, never from anything in the request.
- **Runtime sessions.** Requests and background work reach a database with
  record-access JWTs that Retainer signs itself (RS256), confined to that
  database: the token's database claim overrides any request header,
  `USE DB` is refused, and definitions, `REMOVE` and `INFO` are refused.
  Tokens last 15 minutes, are refreshed before they expire, and never leave
  the server. In a workspace database every table grants the runtime
  principal `FULL` permissions; the isolation boundary is the token's
  database. In the catalog, the runtime session can read keys and routes
  and maintain the lease, but not create, change or delete keys or
  workspaces. A refused data operation returns an empty result with status
  OK rather than an error, which is why every write checks its effect (2,
  rule 5). The server never falls back to the system credential after a
  runtime permission error.
- **System credential.** `RETAINER_SURREAL_USER` and
  `RETAINER_SURREAL_PASS` (a root user, or a namespace user with
  `RETAINER_SURREAL_AUTH_LEVEL=namespace`) are used only for definitions,
  provisioning and upgrades (3), the administrative transaction of a schema
  change, and the operator CLI's workspace and key management (7.1).
- **Signing keys.** `RETAINER_SIGNING_KEY` is `<id>:<base64 PKCS#8 PEM>`;
  `retainer signing-key generate` prints a new one. Each workspace database
  defines one access method per accepted key, `backend_<key id>`, and the
  catalog mirrors which keys each workspace accepts
  (`workspaces.access_keys`), so routing needs no visit to every database.
  A request uses the first configured key its workspace accepts, the
  current key first; when none matches yet it gets a retryable
  `503 workspace_upgrading`. To rotate:
  1. Set the new key as `RETAINER_SIGNING_KEY` and move the old one to
     `RETAINER_SIGNING_PREVIOUS_KEYS`, then restart.
  2. The upgrade runner (3) defines the new key's access method in every
     workspace, at start or on the workspace's first request, and records
     it in `workspace_state` and the catalog.
  3. Once every workspace has been upgraded, drop the old key from
     configuration and restart: its access methods are removed.

  For a compromised key, list its ID in `RETAINER_SIGNING_REVOKED_KEY_IDS`.
  It is no longer accepted, and each workspace's upgrade removes its access
  method in the same step that adds the new one, rather than after every
  workspace has moved. The current key cannot be revoked.
- **Provisioning.** Creating a workspace is a short resumable sequence: the
  catalog entry (`provisioning`), the database with its fixed tables,
  access methods and `workspace_state`, the base objects and template, then
  `active`. Only active workspaces receive requests. Every step checks what
  already exists, and the server finishes interrupted provisioning at boot.
- **Key lookup.** A request's key is looked up before its workspace is
  known: the runtime catalog session finds it by its SHA-256 hash and
  returns the workspace, scopes and actor. Revoked keys are rejected, and
  revocation is checked on every request. Short-lived database sessions do
  not replace that check.
- API keys are stored hashed, belong to one workspace, and carry scopes
  (`read`, `write`, `schema:write`, `admin`; `admin` implies the other
  three) and the actor they write as.
  Key provisioning/rotation is a trusted administrative operation; agent
  credentials cannot mint a key claiming a `user` actor to bypass approval.
- A self-hosted install starts with one default workspace and an admin key
  printed on first boot. Billing, quotas and SSO live outside this
  repository.

### 7.1 Managing workspaces and keys

Workspaces and keys are managed by an operator, never by an agent: no
workspace key can create another workspace. The server image includes a
CLI that connects to SurrealDB with the system credential:

```sh
docker compose exec retainer retainer workspace create --name "Acme Clinic" --template clinic
docker compose exec retainer retainer workspace list
docker compose exec retainer retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
docker compose exec retainer retainer key list --workspace acme-clinic
docker compose exec retainer retainer key revoke <key-id>
docker compose exec retainer retainer signing-key generate
```

`--template` is optional; without it, the first agent chooses one (3.1).
`--slug` overrides the slug made from the name; `--json` prints JSON.
`key create` prints the key once and stores only its hash in the catalog.
`signing-key generate [--id <key-id>]` prints a new `RETAINER_SIGNING_KEY`
value and needs no configuration, so it also makes the first key (7).
There is no instance-wide admin HTTP API in v1.

### 7.2 Per-record access (not in v1)

v1 isolates workspaces only: every key sees every record in its workspace.
Per-record audiences, principals and roles may come later. They would be
rules stored in the workspace and applied on every read and write path.
Until then, new code keeps that path open:

1. Every read and write runs through the workspace's runtime session (7);
   no read takes a shortcut around it, including search, context and
   traversal.
2. A request's database route and session are chosen in one place
   (`Backend.route`).
3. A response mentions another record (conflict errors, merge candidates,
   relation labels, review items, context) only through one shared
   function, `references()`, so a visibility check can be added there
   later. The records a response is about, such as search hits or the
   record under review, come from their own queries.
4. Identifier claims are unique per workspace. If audiences arrive, claims
   become per audience and promoting a record becomes a merge. That cost is
   accepted.

---

## 8. Repository layout

| Path              | License  | Contents                                                     |
| ----------------- | -------- | ------------------------------------------------------------ |
| `packages/shared` | MIT      | Field types, composite shapes, actor, schema types           |
| `packages/server` | AGPL-3.0 | API, MCP endpoint, workers, schema engine, SurrealDB backend |
| `packages/sdk`    | MIT      | TypeScript client                                            |
| `packages/web`    | MIT      | Optional static React app for people                         |
| `packages/mcp`    | MIT      | stdio bridge to the hosted MCP endpoint                      |
| `docker/`         | AGPL-3.0 | Dockerfile and Compose file (SurrealDB and Retainer)         |
| `docs/`           | AGPL-3.0 | Guides: self-hosting, agents, SDK, REST, releasing; specs    |

In `packages/server/src/db`: `surreal.ts` and `cbor.ts` (transport),
`backend.ts` (routes and sessions), `access.ts` (signing keys),
`protocol.ts` and `queue.ts` (the write protocol), `definitions.ts` (fixed
tables), `physical.ts` (object and relation tables), `provision.ts`
(provisioning and upgrades) and `lease.ts` (the process lease).

## 9. Stack

TypeScript on Node 22, pnpm workspaces, Hono, Zod, and the official MCP
TypeScript SDK. The database is SurrealDB 4.0.0, reached through Retainer's
own small HTTP `/rpc` client with CBOR encoding (4); there is no database
driver, ORM or migration tool. Fixed tables are defined in code with a
revision (11), and object and relation tables are compiled from metadata
(3). Background work runs in the server process (4.2), with no queue
library. No LLM SDK.
The optional web package uses Vite, React 19, TanStack Router/Query, Tailwind
CSS 4 and shadcn-style UI primitives. Static files are served by Hono at
`/app` when `RETAINER_WEB_DIR` is set; the Docker image includes the build.

## 10. Build order

The order the first release was built in, kept as a record. Interactions
were later replaced by events (1.3,
[docs/schema-events-and-history-spec.md](docs/schema-events-and-history-spec.md)).

1. Schema engine with base objects and templates, assertion-backed records
   CRUD, REST, API keys and the workspace/key CLI (including direct-write
   precedence and review).
2. MCP endpoint with the tools whose data exists after step 1:
   `describe_schema`, `list_templates`, `apply_template`, `query_records`,
   `get_record`, `upsert_record` and `propose_schema_change`.
   `upsert_record` has no `source` yet, and its description covers direct
   writes only.
3. Interaction log, participant matching and facts: `log_interaction`,
   `remember`, and `source` on `upsert_record`. `source` waits for this step
   because nothing can be cited before interactions can be logged. The tool
   descriptions gain the workflow in 4.1.
4. Keyword search and context packs (`search`, `get_context`).
5. Consolidator (fact dedupe and supersession, merge suggestions), review
   queue, `forget`.
6. SDK, stdio bridge, docs, first release.

All six steps are merged. The 0.1.0 release tooling is in place
(`.github/workflows/release.yml`, docs/releasing.md); the release itself is
not cut yet.

Each step lands with its tests (12). Step 1 also sets up the test harness:
fresh data per test file, a helper that starts the server, and the CI
workflow.

Not planned: embeddings and semantic search, and any language model inside
Retainer (server-side extraction, generated summaries, an `ask` endpoint).
Search is SurrealDB full-text only (5.1).

Left out of the first release: phone-based participant matching,
per-field index automation, field type changes, inferred facts,
automatic record merges, stale-field flags, exact historical belief
snapshots, versioned re-logging of edited sources, partial redaction on
`forget`, and agents connected to more than one workspace.

## 11. Fixed tables

The tables every database has, whatever its schema, are defined in code in
`packages/server/src/db/definitions.ts`. Object and relation tables are
not: the schema engine compiles them from metadata (3).

| Database  | Tables                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog   | `catalog_state`, `workspaces`, `api_keys`, `process_lease`                                                                                                                                                                                                                                                                                                                                                        |
| Workspace | `workspace_state`, `object_types`, `fields`, `schema_changes`, `record_directory`, `field_assertions`, `record_identifiers`, `unique_claims`, `event_identity`, `event_links`, `event_attachments`, `rollup_attachments`, `event_identity_tombstones`, `facts`, `fact_sources`, `merge_suggestions`, `views`, `operations`, `suppressions`, `deletion_audit_log`, `consolidator_runs`, `jobs`, `search_documents` |

- Every table is schemafull: an undeclared field is refused, not dropped.
  Optional columns are `option<T | null>`, so missing and `null` stay
  apart.
- `workspace_state:current` is the one row every writer touches: the
  revision, the published `schema_version`, the mode, the fixed-table
  revision, the definitions digest (3), the accepted signing keys (7), the
  settings and the applied templates.
- The definitions carry a revision (`CATALOG_REVISION`,
  `WORKSPACE_REVISION`); bump it when they change. The catalog's fixed
  tables are brought up to date on every start; each workspace records its
  `fixed_revision`, and the upgrade runner (3) compares actual and desired
  definitions, applies the difference and advances the workspace's
  revision, so a write planned against the old tables fails its commit
  check.
- Tables and fields are defined in one transaction. Every index is defined
  as its own statement, outside a transaction, then verified: it reports
  ready, and a unique index refuses a duplicate probe.
- The search analyzers (`rt_prefix`, `rt_exact`, `rt_trigram`, 5.1) are
  defined with the workspace's fixed tables.

## 12. Testing

Every build step lands with its tests. Nothing is "done" until the layers
below that apply to it pass locally and in CI. Retainer has no language
model inside it, so every layer except 5 is deterministic.

| Layer                   | What it proves                                                                                                                                                                                                                       | How                                                                                                 | Runs                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------- |
| 1. Unit                 | Pure logic: the field-winner rules (2), schema validate/diff/classify (3), identifier normalization (emails, E.164 phones), value validation                                                                                         | Vitest, no database                                                                                 | Every PR               |
| 2. Database integration | Rules only the database can prove: concurrent creates with one email make one record, revision conflicts and retries, effect checks, unique claims and relation constraints, isolation between workspace databases, merges, `forget` | Vitest against real SurrealDB; each test file gets a fresh namespace                                | Every PR               |
| 3. API                  | Every REST route: auth, scopes, validation errors, response shapes                                                                                                                                                                   | The Hono app called in-process against a real database                                              | Every PR               |
| 4. Agent scenarios      | End-to-end flows as an agent sees them: apply a template, create a person, update by `match`, log an event and cite it, review a conflict, search, get context                                                                       | The MCP client, directly and through the stdio bridge, and REST, against the app and real SurrealDB | Every PR (from step 2) |
| 5. Live agent           | Whether a real agent understands the tools and follows the workflow in 4.1: names, descriptions, error messages, what it chooses to write from a sample conversation                                                                 | A separate Claude Code or Codex session connected to Retainer's MCP endpoint, given realistic tasks | By hand, per milestone |

`packages/server/test/surreal/` holds the backend suites: `foundation`
(provisioning, serialized writes and revision retries), `records` (records,
events, facts, retraction, merge and `forget`), `operations`
(`get_operation` and `traverse_records`), `gates` (isolation between
workspaces, the process lease, signing-key rotation, competing writes from
two processes, query plans) and `baseline` (a 200-event ingestion burst
that records write latency and queue wait without asserting a timing).

Browser tests use Playwright against the built app and real SurrealDB, with
a fresh namespace per test. Run `pnpm build` then `pnpm test:web`
(`RETAINER_SURREAL_URL` required); CI runs these after the existing test
layers.

### Rules

- **Fresh namespace per test file.** `useTestBackend()` creates a namespace
  of its own, with its own catalog and workspace databases, and removes it
  after. Files never share rows, so they run in parallel without flaking.
  One run's signing keys are generated once and shared.
- **Real SurrealDB, never a mock,** for anything that touches the
  database. The revision check, effect checks, unique indexes, relation
  constraints and record-access isolation are the point of layers 2 and 3.
  A refused operation can return no rows, so tests check effects, not only
  transport success.
- **Concurrency is tested, not assumed.** Every rule in 2 that says
  "serialized", "atomic" or "idempotent" gets a test that runs the
  competing operations at the same time, including from a second backend
  (`backend.another()`), so the process-local queue cannot hide a conflict
  the revision check must catch.
- **Plans are tested.** A read that must use an index gets a test that
  asserts its `EXPLAIN` operator, so a planner change or a rewritten query
  cannot silently fall back to a table scan.
- **Scenarios follow the docs.** Each scenario in layer 4 matches a flow
  described here, so a change to the design shows up as a failing scenario.

### CI

A GitHub Actions workflow runs on every PR and on `main`: lint, build,
typecheck, layers 1–4, then the browser tests, against SurrealDB 4.0.0 at
the pinned image digest, started as a container with persistent SurrealKV.
Pushing a `v*` tag runs the release workflow, which reruns CI before
publishing (docs/releasing.md). Retainer calls no model, so CI needs no API
keys or cloud credentials.
