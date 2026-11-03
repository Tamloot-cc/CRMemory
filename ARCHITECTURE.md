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
  values, plain-language facts and a log of interactions. Every value records
  who wrote it and which interaction it came from.

Retainer never calls a language model. Agents decide what to remember;
Retainer validates it, resolves conflicts, keeps its history and makes it
searchable. Full conversations stay with the agent.

---

## 1. Data model

Three layers, all in one Postgres database. This document describes the
design as of the first release (0.1.0). Section 11 records the schema
checklist that build step 1 completed.

### 1.1 Schema (metadata)

| Table            | Holds                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `object_types`   | The kinds of things tracked: `person`, `company`, `task` in every workspace, more from templates (3.1), plus custom objects |
| `fields`         | The fields of each object: type, settings, flags (`is_nullable`, `is_unique`, `is_filterable`, `is_searchable`)             |
| `schema_changes` | Every applied, proposed, rejected or failed change, with its operations and actor                                           |

Every schema row carries:

- `universal_id`: a stable UUID that is the same for a standard object or
  field in every workspace, so upgrades can find it.
- `owner`: `system` (shipped with Retainer), `workspace` (added by a user or
  integration), or `agent` (added by an agent).
- `status`: `active` or `deprecated`. A proposed change lives only in
  `schema_changes` until it is approved; nothing half-exists in the live
  schema.
- `key` (fields only): a short, permanent ID used as the JSON key in
  `records.data`. Renaming a field changes `name`, never `key`, so a rename
  never touches the data. Keys are never reused, even after a field is
  deleted.

Workspaces carry a `schema_version` that increments on every applied change.
API and MCP schemas are cached per `(workspace, schema_version)`.

#### Field types

| Type                                                     | Stored as                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `text`, `number`, `boolean`, `date`, `date_time`, `json` | Plain JSON values                                                |
| `select`, `multi_select`                                 | Option value(s); options live in `fields.settings`               |
| `money`                                                  | `{ amountMicros, currency }`                                     |
| `emails`                                                 | `{ primary, additional[] }`                                      |
| `phones`                                                 | `{ primary: { number, countryCode }, additional[] }`             |
| `links`                                                  | `{ primary: { url, label }, additional[] }`                      |
| `full_name`                                              | `{ first, last }`                                                |
| `address`                                                | `{ street1, street2, city, state, postcode, country, lat, lng }` |
| `relation`                                               | Not in `records.data`; see `record_links`                        |

Composite shapes are defined once in `@retainer/shared`, so every object that
has emails stores them the same way.

#### Built-in columns on every record

`id`, `created_at`, `updated_at`, `deleted_at` (soft delete), `created_by`,
`updated_by`, `merged_into_id` (set when the record was merged into another,
so IDs that agents kept still resolve). These are real columns on `records`,
not schema fields.

#### Relations

A `relation` field is defined on the many-to-one side (`person.company`).
The one-to-many side (`company.people`) is its inverse, read from the same
`record_links` rows. Setting a link is a field assertion whose value is the
target record's ID, so links follow the same write rules as other fields;
`record_links` is derived from those assertions, like `records.data`. The
field's `onDelete` setting is applied by the application when the target is
soft-deleted: `cascade` soft-deletes the source records too; `set_null` (the
default) keeps the edge and the assertion, and reads skip the deleted
target. The database cascade only covers hard deletes of edges, not the
asserted relation values. A many-to-one field permits at most one edge per
`(source_record_id, field_id)`, enforced by a unique index on `record_links
(source_record_id, field_id)`; inverse fields are read-only. A relation
assertion is accepted only when the target is a live record of the target
object in the same workspace. Hard deletion deletes relation assertions that
point at the deleted record (2.1, step 3), so a rebuild cannot recreate
dangling links.

#### Actor

Every write carries an actor: `{ type, id, name? }` where `type` is `user`,
`agent`, `integration`, or `system`. The API key decides the actor; callers
cannot claim to be someone else. The server's own `system` actor
(`retainer`) seeds base objects and applies a template chosen at workspace
creation; merges are attributed to the merging user, and the consolidator
writes no actor-stamped rows.

### 1.2 Records

| Table                | Holds                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records`            | One row per entity: `workspace_id`, `object_type_id`, `data jsonb` (keyed by field `key`), `search tsvector` and `label` (5.1), built-in columns                                                                                        |
| `record_links`       | Relations as edges: `field_id`, `source_record_id`, `target_record_id`. Real foreign keys with cascade delete                                                                                                                           |
| `record_identifiers` | Normalized identifiers pointing at a record: every email, phone and website domain, plus the value of every `is_unique` field. `(workspace_id, field_id, value)` is unique for `is_unique` fields (the standard `person.emails` is one) |

`records.data` is a **cache computed from `field_assertions`** (below). If the
layout ever needs to change, records are rebuilt from assertions.
`record_links` and `record_identifiers` are maintained in the same
transaction that recomputes `records.data`.

`record_identifiers` exists because composite fields (`emails`, `phones`,
`links`) keep extra values in an array that an expression index on
`data->>'<key>'` cannot see or enforce. It is used for participant matching,
for uniqueness, and for finding duplicates, and its unique constraint is what
stops two concurrent writes from creating the same person twice.
Each identifier row stores a canonical value and an explicit uniqueness
claim (`is_claim`); a fixed partial unique index over claims enforces `(workspace_id, field_id, value)` without
per-field DDL. Null values create no claim. Normalization is shared by
writes and lookup; generic unique values retain their JSON type so number
`1` and text `"1"` do not collide. Only `text`, `number`, `date` and
`emails` fields can be unique; the schema engine rejects the rest.

Only an exact identifier declared unique can automatically select a record.
Non-unique phones, shared inboxes, domains and name similarity produce
candidates. If supplied identifiers point to different records, return a
conflict with candidate IDs; never pick the first match or merge implicitly.
A losing concurrent create rolls back the entire provisional record and
retries lookup. Soft-deleted records retain uniqueness claims until purged
with `forget` (restoring a record is not in v1), so writes cannot silently
recreate them. A match on a
soft-deleted record follows `merged_into_id` when set; otherwise the
participant stays unresolved and is listed in `GET /v1/review`, rather than
attaching new interactions to a hidden record.

#### Why JSONB and not a table per object

Twenty creates a real Postgres table for every object in every workspace. We
store all records in one table instead, because:

- Agents add fields automatically. With JSONB that is one metadata row, with
  no DDL, locks or partial failures.
- Self-hosted upgrades stay simple: one fixed schema with normal migrations,
  not a migration per workspace.
- The hosted cloud can hold many workspaces without bloating the Postgres
  catalog.

To keep what real tables give you:

1. **Integrity for relations**: `record_links` has real foreign keys.
2. **Rename safety**: JSON keys are field `key`s, not names.
3. **Uniqueness without DDL**: `is_unique` is enforced through
   `record_identifiers`, not a per-field unique index.
4. **Shared indexes in v1**: equality filters use JSONB containment (`data
   @> …`) with the existing GIN index, scoped by workspace and object.
   `is_filterable` exposes a field to structured filters; it does not create
   an index. Range filters and sorts scan that object's rows with typed
   comparisons. Add expression indexes later only for measured workloads.
5. **Escape hatch**: a field that gets very hot can be promoted to a real
   column later.

Not in the first release: typed SQL views per object and workspace
(`crm_views.<workspace>_<object>`) for people and BI tools. They are DDL per
workspace and per schema change, which is exactly what the JSONB design
avoids, and on the hosted cloud they would bloat the catalog. A self-hosted
install can add them later as an opt-in.

### 1.3 Memory

| Table                      | Holds                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interactions`             | A log of what happened, written by the agent: `kind` (meeting, call, email, message, note), `channel`, `occurred_at`, `title`, an agent-written `summary`, `external_id` (unique per workspace and channel, so logging the same source twice is a no-op). No transcripts or message bodies            |
| `interaction_participants` | The records linked to an interaction, in the order logged. `link = 'participant'`: who took part, as a normalized `handle` (email or phone) and/or a `record_id`, a free-text `role`, and an `unmatched_reason` when no record was matched. `link = 'about'`: a record it concerns (only `record_id`) |
| `field_assertions`         | A claimed value for one field of one record: value, actor, source interaction, confidence, `observed_at` (when the claim was true at the source), `status` (`active`, `superseded`, `pending_review`, `rejected`, `retracted`)                                                                        |
| `facts`                    | Plain-language claims about a record: `content`, `kind` (`stated` or `inferred`), confidence, `valid_from` / `valid_to` (when it was true in the world), `superseded_by`                                                                                                                              |
| `fact_sources`             | What a fact rests on: an interaction (with an optional quote the agent chose) or other facts (for inferences)                                                                                                                                                                                         |

`field_assertions.observed_at` and `facts.valid_from` come from the source
(rules 2.2 and 2.6); `valid_from` has no `now()` default, so backfilled
facts do not appear newly true. No v1 write path creates `inferred` facts,
premise-fact sources or `valid_to`; those columns are reserved.

Retainer stores what the agent chose to record, not the conversation itself.
A summary or quote is stored like any other value, so an agent should not put
in it what the workspace should not keep.

Participants are who took part. `about` lists the records an interaction
concerns, of any object: the company, project or tasks of a meeting with Dana
about the Acme pilot. Both make the interaction show in those records'
context packs, searches and interaction queries; only participants are
attendees. The agent names `about` records explicitly. Retainer does not
infer them, for example from a participant's company, since that would move
old meetings when a person changes jobs. A record is linked once per
interaction: `about` skips a record already linked, a record added as a
participant replaces its `about` link, and a merge drops the `about` link
that would repeat another. Adding links locks every record involved
`FOR KEY SHARE`, as relation writes do (4.2), so a concurrent merge either
commits first and the link goes to the survivor, or waits and then moves
the new link with the rest.

Logging an interaction again with the same `(workspace_id, channel,
external_id)` returns the existing one when its kind, `occurred_at` instant,
title and summary are the same. Participants and `about` records it does not
have yet are added, after the existing ones, and the response lists them in
`added`; nothing is removed this way, so retries, and syncs that log the
original list again, are no-ops. A participant is the same one when its role
and handle match, or its role and record (after merges) when it has no
handle; an erased handle (2.1) matches another erased handle with the same
role. Adding a participant changes no field value or fact, only which records
list the interaction. The interaction row is locked while links are added, so
concurrent additions each land once. A different kind, time, title or summary
returns a conflict (`interaction_conflict`); it is never silently ignored.
Logging the identity of a retracted interaction again is also a conflict
(`interaction_retracted`): the unique index still holds the retracted row,
and restoring a source is not in v1. `channel` must distinguish source
accounts when their external IDs can overlap. Without `external_id`, callers
do not get deduplication. An edited source needs a new `external_id` in v1;
creating it does not retract the old source's claims; a person retracts the
old interaction (`DELETE /v1/interactions/:id`).

`POST /v1/interactions/:id/participants` adds participants and `about`
records to a logged interaction by ID, with the same matching. Removing one
(`DELETE /v1/interactions/:id/participants/:participantId` or
`/about/:recordId`) is a person's decision, like other changes that hide
data: an agent's key gets 403.

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
   `records.data`, so renaming a field never breaks a view. The API reads
   and writes field names and translates both ways.
2. **Resolved at read time.** Board columns are the group field's options
   as they are when the view is read, so adding, renaming or removing an
   option needs no change to any view. A view that names a field that is no
   longer active is returned without it: dropped from columns and sort, the
   filter condition removed, `groupBy` or `dateField` returned as null. Each
   dropped reference is listed in the view's `issues`, so the caller can say
   so rather than silently show more records.
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
   A field write may cite an interaction as its source (`source` on
   `upsert_record`); without one, the actor is the source. Every fact cites
   an interaction: the agent passes one, or `remember` creates a `note`
   interaction for it.
2. **Precedence decides a field's value**:
   `user` > `integration` > `agent` > `system`. Within the same precedence,
   the assertion with the latest
   `observed_at` wins (the source interaction's `occurred_at`, or the write
   time for direct writes), then server-assigned `created_at`, then assertion
   ID as a deterministic tie-breaker. This prevents an old email from
   overwriting a newer claim at the same precedence. Higher-precedence claims
   remain authoritative until explicitly changed. Clearing a nullable field
   is an assertion with a `null` value; missing keys mean no change. Composite
   fields are replaced as a whole in v1, including their additional values.
   `observed_at` is set by the server: the cited interaction's `occurred_at`,
   or the write time when no interaction is cited. Callers cannot set it
   directly.
3. **Agents never silently overwrite people, and are never silently
   ignored.** If the winning assertion is a `user` or `integration` one and
   an agent asserts a different value with a newer `observed_at`, the agent's
   value is stored as `pending_review` and does not change `records.data`.
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
   `records.data[key]` is the winner's value (relation winners instead produce
   `record_links`). With no eligible assertion the key/edge is absent.
   `pending_review` and `rejected` assertions never count. Source retraction
   makes its derived assertions ineligible and recomputes affected fields;
   it cannot let an older `superseded` claim from that source win again.
   Retraction sets every `active`, `superseded` or `pending_review`
   assertion citing the source to `retracted`, which never counts again,
   and recomputes the fields where one of them was winning. If the value
   that would win again is now claimed by another record (1.2), it becomes
   `pending_review` (reason `unique_conflict`) and the next one wins, so a
   retraction always takes effect.
5. **Writes to one record are serialized.** A write locks the record row
   (`SELECT … FOR NO KEY UPDATE`; merges, deletes and retraction take
   `FOR UPDATE`), inserts its assertions, recomputes only the
   touched keys, and updates `data`, `record_links` and `record_identifiers`
   in the same short transaction. Nothing does read-modify-write on `data`
   outside that lock, so two agents writing the same record never lose each
   other's values. Multi-record writes lock records in sorted
   ID order. An optional expected `updated_at` precondition rejects stale
   direct edits; serialization alone does not detect a stale agent's intent.
6. **Facts are never deleted by the system, only superseded.** Two times are
   kept apart: `valid_from` / `valid_to` say when a fact was true in the
   world; `created_at` says when it was recorded. `valid_from` is the cited
   interaction's `occurred_at`, or the write time for the `note` that
   `remember` creates; v1 takes no separate effective date. Supersession
   records a correction and preserves provenance. A person can retract a
   fact (soft delete) or hard-delete data for privacy (2.1). Exact historical
   belief snapshots are deferred: the schema has no supersession-event
   timestamp or append-only history of validity edits.

### 2.1 Deletion and privacy

Soft delete (`deleted_at`) is the default for records, facts and
interactions. Reads exclude deleted parents as well as deleted rows: a
record's facts are hidden with it. Retracting an interaction also excludes
the claims that cite it and recomputes field winners. Facts with other live
sources may remain; a fact with no live source is hidden on read.
A write citing an interaction (including accepting a pending claim from it)
locks it in share mode before locking any record, and retraction locks it
exclusively before locking the affected records, so a claim either commits before the retraction (and is retracted
with the rest) or sees the source retracted and fails.
Restoring a source is not in v1; when added, it must revalidate its derived
claims before exposing them.

`forget` (admin scope) is the hard delete for privacy requests. First collect
the record's identifiers, participant interactions, dependent facts,
assertions and inbound relation assertions, before cascades or `SET NULL`
can erase those dependencies. Then, in a coordinated deletion operation:

1. add normalized emails and phones to a workspace suppression list using a
   keyed HMAC (a plain hash of a guessable email/phone is insufficient);
2. hard-delete interactions it took part in and the notes `remember` wrote
   about it, with their source quotes, and remove their assertions and facts
   that have no live source. An interaction that is only `about` the record
   (a meeting about a company) is someone else's conversation: it stays, and
   only the link is deleted;
3. invalidate inbound relation assertions and recompute surviving records'
   field values, links, identifiers and search text;
4. hard-delete the record, its assertions, facts, links and identifiers;
5. write a minimal audit entry (actor ID, time, counts), without copied names,
   handles, summaries, quotes or field values.

Writes coordinate with deletion: creating a record or resolving a
participant checks suppression in the same serialization boundary as
`forget`, so a suppressed email or phone cannot come back. Jobs carry IDs
only, and must not resurrect deleted content. Delete idempotency responses
and error text containing erased content too.

How this is built:

- **Who.** `forget` needs the `admin` scope and a `user` actor; an agent
  with an admin key cannot erase a person.
- **What it covers.** The record and every record merged into it. Its
  handles are its current email and phone identifiers, every email or
  phone it was ever claimed to have, and the handles of interactions it
  was matched in. It "took part in" an interaction when a participant row
  points at it or carries one of those handles.
- **Boundary.** A workspace advisory lock. Every write takes it in shared
  mode after the schema lock; `forget` takes it exclusively, so it waits
  for in-flight writes and blocks new ones until it commits. A record
  write with a suppressed email or phone fails with `409 suppressed`,
  naming the field but not the value. A suppressed participant handle is
  stored as `null` with the reason `suppressed`.
- **Key.** The HMAC key is `RETAINER_SUPPRESSION_KEY` (at least 32
  characters), kept outside the database so a dump alone does not reveal
  the handles. The HMAC covers the workspace ID, kind and normalized
  handle. Without the key, `forget` fails with `503 not_configured`; if a
  workspace already has suppressions, writes that could add a handle fail
  closed. Changing the key forgets earlier suppressions.
- **Idempotency.** Stored responses whose text contains an erased record,
  interaction or fact ID are deleted.
- **Response.** IDs and counts only: records, interactions, facts and
  assertions deleted, inbound relations removed, handles suppressed, the
  records recomputed, and review candidates (other live records, facts and
  interactions matching the name by phrase search or a handle by text).
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

Shared interactions are deleted whole (step 2), even when other people took
part. This is the simpler rule and fully removes the person's words, at the
cost of losing what that interaction said about the others. Redacting only
the person, or keeping other people's facts with a "deleted for privacy"
source, is a possible later refinement.

Workspace deletion cascades through `workspace_id` and removes everything.

---

## 3. Schema engine

One entry point for every schema change, whoever makes it (seed, upgrade,
person or agent). Same pattern as Twenty's migration engine:

1. **Load** the workspace's current schema, holding the workspace's
   exclusive schema lock (below) so schema changes in one workspace run one
   at a time.
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
   - All additive: apply in one transaction (metadata rows and
     `schema_version + 1`). No per-field index jobs in v1.
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
additive shortcut. Record writers take a shared transaction-level advisory
lock keyed on the workspace (`pg_advisory_xact_lock_shared`) before record
locks; schema changes take the exclusive form, so a write cannot race the
check or commit against stale schema. Advisory locks, not `FOR SHARE` on
the workspace row: every write share-locking one hot row creates MultiXact
churn, and schema changes also update that row (`schema_version`). Unique
claims are populated atomically when uniqueness is enabled.

In v1, deleting schema metadata means deprecating it and hiding it from new
writes, not cascading away assertions. Deleting an object also deprecates
relations that point at it; base objects and an object's label field cannot
be deleted. Removing an option needs approval and fails while live records
use it. A relation's target, cardinality and `onDelete` are fixed once
created; there is no operation to change them.

Standard objects ship as code (definitions with fixed `universal_id`s) and
are applied through the same engine, on its trusted path, when a workspace
is created. Upgrading existing workspaces to newer definitions is not built
yet; the fixed `universal_id`s are what such an upgrade will match on.

### 3.1 Base objects and templates

Every workspace is created with three base objects: `person` (name, emails,
phones, address, job title, company), `company` (name, domain, address,
people) and `task` (title, status, due date, assignee, person, company).
Nobody builds a workspace from scratch.

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
the workspace already has is a no-op, whatever its version; template updates
in new releases have no upgrade path yet (3).

The workspace records which templates it has applied, with their versions
(`workspaces.templates`).

---

## 4. Runtime

```
 AI agents ── MCP ───┐
 Apps / SDK ── REST ─┤──► API server ─────────────► Postgres
 Integrations ───────┘                              schema · records ·
                                │                     memory · job queue
                                ▼                          ▲
                            Workers ───────────────────────┘
                            └─ consolidate (scheduled)
```

One Docker image, started with a role: `api`, `worker`, or `all`.
Postgres is the only dependency, with the standard `pg_trgm` and `btree_gin`
extensions for search (5.1); the job queue runs on Postgres too. Retainer
calls no language model and needs no model API key.

### 4.1 How memory gets written

The agent reads the conversation with its own model and decides what is
worth keeping. Retainer only stores, validates and resolves. After a
meeting, call or email thread, an agent typically:

1. **Logs the interaction** with `log_interaction`: kind, channel, time,
   title, its own short summary, the source's external ID, the participants
   as handles (emails, phones) and/or record IDs, and in `about` the records
   it concerns (1.3).
2. **Updates records** with `upsert_record`, citing the interaction as
   `source` so the values carry its date and provenance (rule 2.2).
3. **Stores facts** with `remember`, citing the same interaction and an
   optional quote.
4. **Creates tasks** someone committed to, as `task` records.

Participants are resolved synchronously when the interaction is logged:
handles are normalized (lowercased email, E.164 phone) and matched against
unique identifiers in `record_identifiers`. Matched participants are linked;
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

Each write is its own short transaction, and each follows the write rules,
so an agent that stops halfway leaves consistent data; it can resume, and
`external_id` and idempotency keys (6.2) make retries safe.

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

- **Scheduling.** The queue is Postgres. Every minute, a worker asks the
  `SECURITY DEFINER` function `retainer_workspaces_due(interval)` which
  workspaces last ran longer ago than `RETAINER_CONSOLIDATE_INTERVAL_MINUTES`
  (default 60). It runs each workspace in one transaction, under a
  per-workspace advisory try-lock, so several workers never run the same
  workspace twice. `consolidator_runs` holds the last start, the stats, and
  `compared_until`. A run holds the privacy lock (2.1) in shared mode.
- **Exact duplicate facts.** Duplicates are current facts of the same live
  record with equal text after trimming, collapsing whitespace and
  lowercasing, and equal `valid_from` and `valid_to`. The oldest is the
  canonical fact. It gains each duplicate's source links; the duplicates
  keep theirs and get `superseded_by`. The facts are locked and the groups
  found again before writing, so a fact retracted meanwhile is skipped.
- **Merge suggestions.** Two live records of the same object are suggested
  when they share an email, phone or website domain identifier
  (`shared email`, `shared phone`, `shared domain`), or when their labels
  have a pg_trgm similarity of at least 0.6 and are at least three
  characters long (`similar names`). The reason never copies values. Only
  records updated since the last run's `compared_until` (its start minus
  five minutes) are probed, and each kind adds at most 500 new suggestions
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
- **Locks.** Ordinary writes lock their record `FOR NO KEY UPDATE`, and a
  relation write locks its target `FOR KEY SHARE`, following merges. A
  merge locks A and B `FOR UPDATE`, which waits for both. So a link to B
  written during a merge either commits first and is rewritten, or waits
  and then points at A. A relation write locks source then target, while
  merges and cascading deletes lock targets first, so the two can deadlock;
  any write Postgres aborts for a deadlock is rolled back and run again
  (up to three times). A merge that loses a race to another merge is
  retried too.
- **Self-links.** No field disallows them in v1, so a relation from A to B
  becomes a link from A to A.

**Merging** record B into A moves B's assertions, facts, links, identifiers
and participant matches to A, recomputes A's values with the normal write
rules, and soft-deletes B with `merged_into_id = A`. Reads of B return A.
The merge is one transaction locking both same-workspace, same-object
records in sorted ID order. Rewrite inbound relation assertions as well as
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
(`kind = inferred`). The schema keeps the `kind` column and premise links
so it can be added without a migration.

### 4.3 No language model inside Retainer

Retainer never calls a language model or an embedding provider. Every
judgment about what a conversation means is made by the agent, with the
agent's own model. This keeps self-hosting free of model keys and LLM cost,
keeps full conversations with the agent, and keeps Retainer's behavior
deterministic and testable.

---

## 5. Read paths

| Operation                          | What it returns                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `describe_schema`                  | The workspace (ID, name, applied templates, `initialized`), its objects and fields, and `builtIns`              |
| `query_interactions`               | Interactions by kind, channel, `occurred_at` range and linked record, with totals and counts by kind or channel |
| `query_records`                    | Structured filter, sort and pagination over one object                                                          |
| `get_record`                       | One record with its fields and links                                                                            |
| `search`                           | Keyword search (Postgres full-text) across records, facts and interactions                                      |
| `get_context(record, tokenBudget)` | A ready-to-use pack: key fields, current facts, open tasks, recent interaction summaries, fitted to the budget  |

`builtIns` lists interactions and facts, apart from `objects`, so a person
reading the schema sees that the workspace keeps them and no client mistakes
them for something `upsert_record` writes. They are not objects: an
interaction is a source, not a claim, its participants are many-to-many, and
retraction and `forget` depend on its own table (1.3, 2.1). For the same
reason `query_interactions` reads the `interactions` table directly rather
than through the records query. It leaves out retracted interactions and the
notes `remember` creates, as context packs and search do.

Every read hides soft-deleted parents/rows and superseded facts by default.
An explicit history mode can list retained assertions and facts with their
source and validity dates; exact `as_of` snapshots are deferred. Context
packs distinguish stated facts from current field values and show who wrote
each. They are assembled by rules (recency, precedence, the token budget),
not summarized by a model; summarizing is the agent's job.

### 5.1 Search

Search is Postgres full-text search, plus two standard extensions that ship
with Postgres and are offered by managed services: `pg_trgm` (fuzzy name
matching) and `btree_gin` (combined indexes). No embeddings, no BM25
extension.

#### What is indexed

| Source         | Search text                                                                           | Column and index                                     |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `records`      | Values of `is_searchable` fields; the label field (usually the name) weighted highest | `search tsvector`, GIN on `(workspace_id, search)`   |
| `records`      | The label field as plain text, e.g. "Dana Levi"                                       | `label text`, trigram GIN on `(workspace_id, label)` |
| `facts`        | `content`                                                                             | `search tsvector`, GIN on `(workspace_id, search)`   |
| `interactions` | `title` (weighted higher) and `summary`                                               | `search tsvector`, GIN on `(workspace_id, search)`   |

The server computes every `search` and `label` value in the same
transaction that writes the row (for records, the one that recomputes
`records.data`). They are not Postgres generated columns, because which
record fields are searchable lives in schema metadata. Each fact carries its
`record_id` and each interaction its matched record IDs (possibly none or
several), so a hit on a fact or interaction also points to records.

Every index leads with `workspace_id` (`btree_gin`), so a common word is
matched within one workspace inside the index instead of across every
tenant and filtered afterwards.

All `tsvector` columns use the `simple` configuration: lowercase, split on
spaces and punctuation, no stemming and no language-specific rules. It
behaves the same for every language, at the cost of matching whole words
only: "meeting" does not find "meetings". Changing the configuration later
requires a background job that rebuilds stored search values.

#### How a search runs

1. Postgres parses the query with `websearch_to_tsquery('simple', …)`, which
   handles quoted phrases, `OR` and `-word`. There is no custom parser.
2. The server runs one query each on records, facts and interactions.
   Workspace and liveness filters (and, for facts, "current, not
   superseded") apply before ranking and limit. The `note` interactions
   `remember` creates are left out: their text is the fact's, so it is found
   with the fact, or hidden with it once the fact is retracted.
3. Each list is ranked with `ts_rank_cd`, using length normalization so long
   texts do not outrank short, precise matches.
4. If the records query finds nothing, the server matches `records.label` by
   trigram similarity, so "Dana Levy" finds "Dana Levi".
5. Results come back grouped by type. Each hit carries its record IDs and
   its text as stored: a record's label, a fact's content, an interaction's
   title and summary. A record hit says whether it matched the text or only
   a similar label. Scores from the three lists are not comparable and are
   not merged.

Agents cover other word forms themselves: the `search` tool description
tells them to add variants with `OR` ("meeting OR meetings").

#### Why not BM25

`ts_rank_cd` has no inverse document frequency: a word that appears
everywhere in a workspace counts as much as a rare one. BM25 handles that,
but Postgres has it only through extensions (for example ParadeDB's
`pg_search`) that many managed Postgres services do not offer, which would
break "plain Postgres is the only dependency". Within one workspace the
candidate set is small, and an agent reads the top results anyway.

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
| `GET /v1/records/:id/interactions`                | Paginated interactions a record took part in or that are about it                                                                       |
| `GET /v1/assertions/:id`                          | One assertion, including status and review details                                                                                      |
| `GET /v1/interactions/:id/claims`                 | Paginated assertions and facts citing an interaction                                                                                    |
| `GET /v1/records/:id/context`                     | Context pack                                                                                                                            |
| `POST /v1/records/:id/merge`                      | Merge another record into this one                                                                                                      |
| `POST /v1/records/:id/forget`                     | Hard delete for privacy requests (2.1)                                                                                                  |
| `GET` · `POST /v1/records/:id/facts`              | Facts about a record                                                                                                                    |
| `DELETE /v1/facts/:id`                            | Retract a fact (soft delete)                                                                                                            |
| `GET /v1/review`                                  | Pending assertions, suggested merges, participants matching deleted records                                                             |
| `POST /v1/review/merges/:id/dismiss`              | Dismiss a suggested merge (4.2)                                                                                                         |
| `POST /v1/assertions/:id/accept` · `/reject`      | Decide a pending assertion                                                                                                              |
| `POST /v1/interactions`                           | Log an interaction; returns matched and unmatched participants (4.1)                                                                    |
| `POST /v1/interactions/query`                     | Filter, count and page interactions (5)                                                                                                 |
| `GET` · `DELETE /v1/interactions/:id`             | Read or retract an interaction                                                                                                          |
| `POST /v1/interactions/:id/participants`          | Add participants and `about` records (1.3)                                                                                              |
| `DELETE /v1/interactions/:id/participants/:pid`   | Remove a participant (a person only)                                                                                                    |
| `DELETE /v1/interactions/:id/about/:recordId`     | Remove an `about` record (a person only)                                                                                                |
| `POST /v1/search`                                 | Keyword search (5.1)                                                                                                                    |

Web sign-in and sign-out use `POST` and `DELETE /auth/session`, outside
`/v1`; see section 7 for cookie and CSRF rules. `GET /health`, also outside
`/v1` and needing no key, reports the version and database status (503
when the database is unreachable). Record reads optionally include
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
`query_records`, `query_interactions`, `get_record`, `search`, `get_context`,
`upsert_record`, `log_interaction`, `remember`, `propose_schema_change`.
`query_interactions` is one fixed tool, not one per object, so it keeps the
list from growing.

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
`interaction` or `fact` fails with the built-in feature to use instead.

In v1 an agent is connected to exactly one workspace through one API key.
Every call acts on that workspace, so no tool takes a workspace parameter.
`describe_schema` still returns the workspace's ID and name for logs and
for the agent's own context. Agents that work across several workspaces,
and any search or query across workspaces, are out of scope for v1.

Inputs are validated at runtime against the workspace schema, and validation
errors name the field and the allowed values so the agent can retry.

`remember(record, text, source?, quote?)` writes one `stated` fact at once,
citing `source` (an interaction ID) with an optional quote. Without
`source`, it creates a `note` interaction for the fact to cite.

`upsert_record` accepts an optional `source` (an interaction ID). Values
from a conversation should cite it, so they carry the interaction's date as
`observed_at` (rule 2.2) and an older email cannot overwrite a newer claim.

The tool descriptions spell out the workflow in 4.1, so an agent knows to
log the interaction first and cite it in the writes that follow.

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
candidates, it tells them apart by company, email or recent interactions, or
asks its user.

Create-style writes (`remember`, record creation and merge requests) accept
a caller idempotency key scoped by workspace and operation. Store the request
hash and result atomically with the mutation; retries return the original
result, and reuse with a different payload fails. Identifier matching alone
does not make note creation or assertion history idempotent. A merge
request is already idempotent by state (B already merged into A is a
no-op). Keys are stored in `idempotency_keys` (workspace, operation, key,
request hash, result, expiry); `interactions.external_id` only covers
logging interactions.

Several agents can share a workspace. Each uses its own API key, so every
write is attributed to the agent that made it; between agents the latest
`observed_at` wins and the full history stays in `field_assertions`.

#### Responses of the memory tools

Record writes return the shape shown above. `log_interaction`, `remember`
and `get_context` return the following. IDs are UUIDs; the examples shorten
them and add a type prefix for readability.

```
→ log_interaction {
    "kind": "call", "channel": "zoom", "externalId": "zoom-8812-3390",
    "occurredAt": "2026-10-29T14:00:00+02:00", "title": "Acme renewal call",
    "summary": "…",
    "participants": [ { "handle": "dana@acme.com", "role": "customer" },
                      { "handle": "ron.peretz@acme.com", "role": "customer" } ],
    "about": [ "rec_a11…" ] }
← { "id": "int_51b…", "created": true,
    "participants": {
      "matched":   [ { "id": "ip_1…", "handle": "dana@acme.com", "role": "customer", "recordId": "rec_9f2…" } ],
      "unmatched": [ { "id": "ip_2…", "handle": "ron.peretz@acme.com", "role": "customer", "reason": "no_match" } ] },
    "about": [ "rec_a11…" ] }
```

`created` is `false` when the same `(channel, externalId)` was already
logged with the same kind, time, title and summary (1.3); the response then
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

`DELETE /v1/interactions/:id` returns how far the retraction reached:
`{ id, deleted: true, retractedAssertions, recomputedRecordIds,
hiddenFactIds }`, the last being facts whose only live source it was.

```
→ remember {
    "record": "rec_9f2…", "text": "Legal review at Acme usually takes two weeks.",
    "source": "int_51b…", "quote": "legal usually needs two weeks with these" }
← { "fact": {
      "id": "fct_77a…", "record": "rec_9f2…",
      "content": "Legal review at Acme usually takes two weeks.",
      "kind": "stated", "validFrom": "2026-10-29T12:00:00Z", "validTo": null,
      "writtenBy": { "type": "agent", "id": "…", "name": "Inbox agent" },
      "sources": [ { "interaction": "int_51b…", "quote": "legal usually needs two weeks with these" } ] },
    "noteInteraction": null }
```

`validFrom` is the cited interaction's `occurred_at` (rule 2.6). Without
`source`, `noteInteraction` is the ID of the `note` interaction created for
the fact to cite, and `validFrom` is the write time. The note has channel
`retainer`, the fact's text as its summary, and the record as its one
`about` record, with no participants. The `retainer` channel is reserved for these
notes: `log_interaction` rejects it, so retrieval can tell them apart. A `quote` needs a `source`. A retry with the
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
                 "sources": [ "int_9d0…" ] } ],
    "recentInteractions": [ { "id": "int_9d0…", "kind": "meeting", "occurredAt": "2026-10-21T09:00:00Z",
                              "title": "Globex data-platform demo", "summary": "…", "via": "participant" } ],
    "omitted": { "openTasks": 0, "facts": 4, "recentInteractions": 11 },
    "tokenEstimate": 1380 }
```

A context pack is assembled by fixed rules (5):

- The record's current field values are always included, each with who
  wrote it and when it was observed, so a value is never mistaken for a
  stated fact. The budget applies to the sections after it.
- The other sections fill in this order until the budget is spent: open
  tasks (tasks linked to the record through an active relation field whose
  status is not `done`, earliest due date first, undated last), current facts (not superseded or retracted,
  newest `validFrom` first), then recent interactions the record took part in
  or that are about it (newest first, each with `via: "participant"` or
  `"about"`, without the notes `remember` created, whose text is already a
  fact). Items
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

Web read routes add paginated assertion history, record interactions,
interaction claims, review totals/cursors, and optional winning provenance
and batched relation references. Object queries accept an optional `search`
keyword string for full-text lookup within one object; workspace-wide search
is `POST /v1/search` (5.1). All use the same runtime role and RLS as other
routes. They do not change the assertion-backed write rules.

- Every row has `workspace_id`. Postgres row-level security uses a
  per-transaction `app.workspace_id` setting as a second line of defense
  behind the application's own checks. Runtime roles must not own tables or
  have `BYPASSRLS`; migrations use a separate role. Tenant foreign keys must
  include `workspace_id` (or equivalent enforced checks), since independent
  UUID foreign keys do not prevent cross-workspace references. Validate
  field/object compatibility in addition to tenant membership.
  `interaction_participants` and `fact_sources` carry `workspace_id`, and
  tenant tables use composite foreign keys `(workspace_id, parent_id)`
  referencing a unique `(workspace_id, id)` on each parent.
- API-key lookup happens before the workspace is known, so `api_keys` is
  read through one narrow `SECURITY DEFINER` function that takes a key hash
  and returns the workspace, scopes and actor; the runtime role has no other
  access to that table. It rejects revoked keys, fixes its `search_path`, uses
  qualified table names and grants execution only to the runtime role.
- Background jobs carry their `workspace_id` and set the same setting, so
  workers are held to the same isolation as API requests.
- API keys are stored hashed, belong to one workspace, and carry scopes
  (`read`, `write`, `schema:write`, `admin`; `admin` implies the other
  three) and the actor they write as.
  Key provisioning/rotation is a trusted administrative operation; agent
  credentials cannot mint a key claiming a `user` actor to bypass approval.
- A self-hosted install starts with one default workspace and an admin key
  printed on first boot. The hosted cloud runs the same image with many
  workspaces. Billing, quotas and SSO live outside this repository.

### 7.1 Managing workspaces and keys

Workspaces and keys are managed by an operator, never by an agent: no
workspace key can create another workspace. On a self-hosted install, the
server image includes a CLI that talks to the database directly:

```sh
docker compose exec retainer retainer workspace create --name "Acme Clinic" --template clinic
docker compose exec retainer retainer workspace list
docker compose exec retainer retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
docker compose exec retainer retainer key list --workspace acme-clinic
docker compose exec retainer retainer key revoke <key-id>
```

`--template` is optional; without it, the first agent chooses one (3.1).
`--slug` overrides the slug made from the name; `--json` prints JSON.
`key create` prints the key once and stores only its hash. The hosted cloud
provisions workspaces and keys through its own service, outside this
repository, using the same database operations. There is no instance-wide
admin HTTP API in v1.

### 7.2 Per-record access (not in v1)

v1 isolates workspaces only: every key sees every record in its workspace.
Per-record audiences, principals and roles may come later. They would be
rules stored in tables and enforced by a restrictive RLS policy
(`AS RESTRICTIVE`, with `USING` and `WITH CHECK`) next to
`workspace_isolation`, so Postgres applies them to every query. Application
code would only add clearer errors and pre-checks; it is never the
enforcement. Until then, new code keeps that path open:

1. Every read and write runs as `retainer_app` under RLS. The only
   `SECURITY DEFINER` functions are the API-key lookup and
   `retainer_workspaces_due` (4.2), which returns workspace IDs only; no read
   takes a shortcut around RLS, including search and context.
2. Per-request database context is set in one place (`inWorkspace`).
3. A response mentions another record (conflict errors, merge candidates,
   relation labels, review items, context) only through one shared
   function, `references()`, so a visibility check can be added there
   later. The records a response is about, such as search hits or the
   record under review, come from their own RLS-bound queries.
4. Identifier claims are unique per workspace. If audiences arrive, claims
   become per audience and promoting a record becomes a merge. That cost is
   accepted.

---

## 8. Repository layout

| Path              | License  | Contents                                            |
| ----------------- | -------- | --------------------------------------------------- |
| `packages/shared` | MIT      | Field types, composite shapes, actor, schema types  |
| `packages/server` | AGPL-3.0 | API, MCP endpoint, workers, schema engine, database |
| `packages/sdk`    | MIT      | TypeScript client                                   |
| `packages/web`    | MIT      | Optional static React app for people                |
| `packages/mcp`    | MIT      | stdio bridge to the hosted MCP endpoint             |
| `docker/`         | AGPL-3.0 | Dockerfile and Compose file                         |
| `docs/`           | AGPL-3.0 | Guides: self-hosting, agents, SDK, REST, releasing  |

## 9. Stack

TypeScript on Node 22, pnpm workspaces, Hono, postgres.js with plain SQL,
Drizzle for table definitions and drizzle-kit migrations, Zod, and the
official MCP TypeScript SDK. The job queue is Postgres itself (4.2), with
no queue library. No LLM SDK.
The optional web package uses Vite, React 19, TanStack Router/Query, Tailwind
CSS 4 and shadcn-style UI primitives. Static files are served by Hono at
`/app` when `RETAINER_WEB_DIR` is set; the Docker image includes the build.

## 10. Build order

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
fresh database per test file, a helper that starts the server, and the CI
workflow.

Not planned: embeddings and semantic search, and any language model inside
Retainer (server-side extraction, generated summaries, an `ask` endpoint).
Search is Postgres full-text only. A BM25 backend may come later as an
option (5.1).

Left out of the first release: phone-based participant matching, typed SQL
views, per-field index automation, field type changes, inferred facts,
automatic record merges, stale-field flags, exact historical belief
snapshots, versioned re-logging of edited sources, partial redaction on
`forget`, and agents connected to more than one workspace.

## 11. Schema checklist for build step 1

Changes to `packages/server/src/db/schema.ts` that this document required
and the original scaffold lacked. All of them landed in build step 1
(`drizzle/0000_init.sql` and `0001_security.sql`).

**New tables**

- [x] `record_identifiers`: normalized identifier per record, with a canonical
  value and a uniqueness claim; a partial unique index on
  `(workspace_id, field_id, value)` over claims (1.2)
- [x] `merge_suggestions`: the two record IDs, reason, status (4.2)
- [x] `idempotency_keys`: workspace, operation, key, request hash, result,
  expiry (6.2)
- [x] Suppression list: workspace, keyed HMAC of a normalized email or phone
  (2.1)
- [x] Deletion audit log: actor ID, time, counts only (2.1)

**New columns**

- [x] `workspaces.templates jsonb` (applied template names and versions) and
  `workspaces.initialized_at` (3.1)
- [x] `records.merged_into_id` (1.1, 4.2)
- [x] `field_assertions.observed_at` (1.3, rule 2.2)
- [x] `search tsvector` on `facts` and `interactions` (title and summary),
  computed by the server like `records.search` (5.1)
- [x] `records.label text`: the label field as plain text, for fuzzy name
  lookup (5.1)
- [x] `workspace_id` on `interaction_participants` and `fact_sources` (7)

**Agent-written memory (4.1, 4.3)**

- [x] `interactions`: replace `content`, `content_format`, `ingest_status`
  and `ingest_error` with `summary text`
- [x] Drop the `record_cards` table

**Changed constraints and defaults**

- [x] Unique index on `record_links (source_record_id, field_id)`, so a
  many-to-one field has at most one edge per record (1.1)
- [x] `facts.valid_from`: no `now()` default; set from the source (1.3,
  rule 2.6)
- [x] Remove `proposed` from live `object_types` / `fields` status and from
  `SCHEMA_STATUSES` in `@retainer/shared` (1.1)
- [x] Composite foreign keys `(workspace_id, parent_id)` referencing a unique
  `(workspace_id, id)` on each parent, instead of plain ID foreign keys (7)

**Extensions and search indexes**

- [x] The migration runner creates `pg_trgm` and `btree_gin` (5.1)
- [x] Replace `records_search_gin` with a GIN index on
  `(workspace_id, search)`; add the same on `facts` and `interactions` (5.1)
- [x] Trigram GIN index on `records (workspace_id, label)` (5.1)

**Security**

- [x] Row-level security policies on every tenant table, keyed on the
  per-transaction `app.workspace_id` setting (7)
- [x] Separate migration and runtime roles; the runtime role does not own
  tables and has no `BYPASSRLS` (7)
- [x] The `SECURITY DEFINER` function for API-key lookup (7)

## 12. Testing

Every build step lands with its tests. Nothing is "done" until the layers
below that apply to it pass locally and in CI. Retainer has no language
model inside it, so every layer except 5 is deterministic.

| Layer                   | What it proves                                                                                                                                                               | How                                                                                                 | Runs                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------- |
| 1. Unit                 | Pure logic: the field-winner rules (2), schema validate/diff/classify (3), identifier normalization (emails, E.164 phones), value validation                                 | Vitest, no database                                                                                 | Every PR               |
| 2. Database integration | Rules only Postgres can prove: concurrent creates with one email make one record, per-record locking, unique claims, row-level security between workspaces, merges, `forget` | Vitest against real Postgres; each test file gets a fresh database                                  | Every PR               |
| 3. API                  | Every REST route: auth, scopes, validation errors, response shapes                                                                                                           | The Hono app called in-process against a real database                                              | Every PR               |
| 4. Agent scenarios      | End-to-end flows as an agent sees them: apply a template, create a person, update by `match`, log an interaction and cite it, review a conflict, search, get context         | The MCP client, directly and through the stdio bridge, and REST, against the app and real Postgres  | Every PR (from step 2) |
| 5. Live agent           | Whether a real agent understands the tools and follows the workflow in 4.1: names, descriptions, error messages, what it chooses to write from a sample conversation         | A separate Claude Code or Codex session connected to Retainer's MCP endpoint, given realistic tasks | By hand, per milestone |

Browser tests use Playwright against the built app and real Postgres, with a
fresh database cloned from a migrated template per test. Run `pnpm build`
then `pnpm test:web`; CI runs these after the existing test layers.

### Rules

- **Fresh database per test file.** Migrations run once into a template
  database; each test file clones it (`CREATE DATABASE … TEMPLATE …`) and
  drops it after. Files never share rows, so they run in parallel without
  flaking. Browser tests clone one per test.
- **Real Postgres, never a mock,** for anything that touches the database.
  Locking, row-level security and unique constraints are the point of
  layers 2 and 3.
- **Concurrency is tested, not assumed.** Every rule in 2 that says
  "serialized", "atomic" or "idempotent" gets a test that runs the
  competing operations at the same time.
- **Scenarios follow the docs.** Each scenario in layer 4 matches a flow
  described here, so a change to the design shows up as a failing scenario.

### CI

A GitHub Actions workflow runs on every PR and on `main`: lint, build,
typecheck, layers 1–4, then the browser tests, with Postgres as a service
container. Pushing a `v*` tag runs the release workflow, which reruns CI
before publishing (docs/releasing.md). Retainer calls no model, so CI needs
no API keys.
