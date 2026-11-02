# Retainer architecture

Retainer is an open-source memory layer for AI agents that work with customer
relationships. It has no UI. Agents and apps use it through a REST API and an
MCP server.

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
intended first release; the scaffold is not a working implementation of these
invariants. Inline schema notes identify changes still needed in
`packages/server/src/db/schema.ts`; section 11 collects them in one checklist.

### 1.1 Schema (metadata)

| Table            | Holds                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `object_types`   | The kinds of things tracked: `person`, `company`, `task` in every workspace, more from templates (3.1), plus custom objects |
| `fields`         | The fields of each object: type, settings, flags (`is_nullable`, `is_unique`, `is_filterable`, `is_searchable`)             |
| `schema_changes` | Every applied, proposed, rejected or failed change, with its operations and actor                                           |

Every schema row carries:

- `universal_id`: a stable UUID that is the same for a standard object or
  field in every workspace, so upgrades can find it.
- `owner`: `system` (shipped with Retainer), `workspace` (added by a person),
  or `agent` (added by an agent).
- `status`: `active` or `deprecated`. A proposed change lives only in
  `schema_changes` until it is approved; nothing half-exists in the live
  schema.
  The scaffold and shared `SCHEMA_STATUSES` still allow `proposed` on live
  metadata rows; remove that unused state when implementing the engine.
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
`merged_into_id` is a required scaffold addition for merges (4.2).

#### Relations

A `relation` field is defined on the many-to-one side (`person.company`).
The one-to-many side (`company.people`) is its inverse, read from the same
`record_links` rows. Setting a link is a field assertion whose value is the
target record's ID, so links follow the same write rules as other fields;
`record_links` is derived from those assertions, like `records.data`. The
field's `onDelete` setting (`set_null` or `cascade`) is applied by the
application when the target is soft-deleted; the database cascade only
covers hard deletes of edges, not the asserted relation values. A many-to-one
field permits at most one edge per `(source_record_id, field_id)`; inverse
fields are read-only. Validate the source object, target object and workspace
before accepting a relation assertion. Required scaffold addition: a unique
index on `record_links (source_record_id, field_id)`; today only the full
edge is unique. Hard deletion invalidates relation assertions that point at
the deleted record (2.1, step 3), so a rebuild cannot recreate dangling links.

#### Actor

Every write carries an actor: `{ type, id, name? }` where `type` is `user`,
`agent`, `integration`, or `system`. The API key decides the actor; callers
cannot claim to be someone else. Server maintenance (consolidation, merge
bookkeeping) uses a server-owned `system` actor.

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
This is a required addition to the scaffold. Store a canonical value and an
explicit uniqueness claim on each identifier row; a fixed partial unique
index over claims enforces `(workspace_id, field_id, value)` without
per-field DDL. Null values create no claim. Normalization is shared by
writes and lookup; generic unique values retain their JSON type so number
`1` and text `"1"` do not collide. Unsupported unique field types are rejected
by the schema engine.

Only an exact identifier declared unique can automatically select a record.
Non-unique phones, shared inboxes, domains and name similarity produce
candidates. If supplied identifiers point to different records, return a
conflict with candidate IDs; never pick the first match or merge implicitly.
A losing concurrent create rolls back the entire provisional record and
retries lookup. Soft-deleted records retain uniqueness claims until restored
or explicitly purged, so writes cannot silently recreate them. A match on a
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

| Table                      | Holds                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `interactions`             | A log of what happened, written by the agent: `kind` (meeting, call, email, message, note), `channel`, `occurred_at`, `title`, an agent-written `summary`, `external_id` (unique per workspace and channel, so logging the same source twice is a no-op). No transcripts or message bodies |
| `interaction_participants` | Who took part, in the order logged: a normalized `handle` (email or phone) and/or a `record_id`, a free-text `role`, and an `unmatched_reason` when no record was matched                                                                                                                  |
| `field_assertions`         | A claimed value for one field of one record: value, actor, source interaction, confidence, `observed_at` (when the claim was true at the source), `status` (`active`, `superseded`, `pending_review`, `rejected`, `retracted`)                                                             |
| `facts`                    | Plain-language claims about a record: `content`, `kind` (`stated` or `inferred`), confidence, `valid_from` / `valid_to` (when it was true in the world), `superseded_by`                                                                                                                   |
| `fact_sources`             | What a fact rests on: an interaction (with an optional quote the agent chose) or other facts (for inferences)                                                                                                                                                                              |

Required scaffold addition: `field_assertions.observed_at`. Replace
the unconditional `facts.valid_from = now()` default with source-derived
validity (rule 2.6), so backfilled facts do not appear newly true.

Retainer stores what the agent chose to record, not the conversation itself.
A summary or quote is stored like any other value, so an agent should not put
in it what the workspace should not keep.

Logging an interaction again with the same `(workspace_id, channel,
external_id)` and identical input returns the existing one. Input is compared
after normalization (handles, the `occurred_at` instant), through a hash of it
stored on the interaction. A different payload for that identity returns a
conflict (`interaction_conflict`); it is never silently ignored. Logging the
identity of a retracted interaction again is also a conflict
(`interaction_retracted`): the unique index still holds the retracted row,
and restoring a source is not in v1. `channel` must distinguish source accounts
when their external IDs can overlap. Without `external_id`, callers do not
get deduplication. An edited source needs a new `external_id` in v1;
creating it does not retract the old source's claims; the caller retracts
the old interaction (`DELETE /v1/interactions/:id`).

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
   assertion re-asserts it with the reviewing user as actor and retaining its source provenance. Acceptance
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
   and recomputes the fields where one of them was winning.
5. **Writes to one record are serialized.** A write locks the record row
   (`SELECT … FOR UPDATE`), inserts its assertions, recomputes only the
   touched keys, and updates `data`, `record_links` and `record_identifiers`
   in the same short transaction. Nothing does read-modify-write on `data`
   outside that lock, so two agents writing the same record never lose each
   other's values. Multi-record writes lock records in sorted
   ID order. An optional expected `updated_at` precondition rejects stale
   direct edits; serialization alone does not detect a stale agent's intent.
6. **Facts are never deleted by the system, only superseded.** Two times are
   kept apart: `valid_from` / `valid_to` say when a fact was true in the
   world; `created_at` says when it was recorded. Use an explicit effective
   date in the source when available, otherwise `occurred_at`. Supersession
   records a correction and preserves provenance. A person can retract a
   fact (soft delete) or hard-delete data for privacy (2.1). Exact historical
   belief snapshots are deferred: the scaffold has no supersession-event
   timestamp or append-only history of validity edits.

### 2.1 Deletion and privacy

Soft delete (`deleted_at`) is the default for records, facts and
interactions. Reads exclude deleted parents as well as deleted rows: a
record's facts are hidden with it. Retracting an interaction also excludes
the claims that cite it and recomputes field winners. Facts with other live
sources may remain; a fact with no live source is hidden on read.
A write citing an interaction locks it in share mode before locking any
record, and retraction locks it exclusively before locking the affected
records, so a claim either commits before the retraction (and is retracted
with the rest) or sees the source retracted and fails.
Restoring a source must revalidate its derived claims before exposing them.

`forget` (admin scope) is the hard delete for privacy requests. First collect
the record's identifiers, participant interactions, dependent facts,
assertions and inbound relation assertions, before cascades or `SET NULL`
can erase those dependencies. Then, in a coordinated deletion operation:

1. add normalized emails and phones to a workspace suppression list using a
   keyed HMAC (a plain hash of a guessable email/phone is insufficient);
2. hard-delete interactions it took part in, with their source quotes, and
   remove their assertions and facts that have no live source;
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
   - Additive: create object, create field, add select option, change
     label/description, mark a field filterable/searchable.
   - Destructive: rename, remove option, delete field or object, make a
     field required or unique.
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
writes, not cascading away assertions. Removing options or changing relation
target/cardinality/delete behavior also needs an explicit plan for existing
values and human approval; unsupported transformations are rejected.

Standard objects ship as code (definitions with fixed `universal_id`s) and
are applied through the same engine when a workspace is created or upgraded.

### 3.1 Base objects and templates

Every workspace is created with three base objects: `person` (name, emails,
phones, address, job title, company), `company` (name, domain, address,
people) and `task` (title, status, due date, assignee, related records).
Nobody builds a workspace from scratch.

Templates add the objects and fields a kind of business needs. They ship
as code in `packages/server/src/templates/`, with fixed `universal_id`s
like the base objects, and are applied through the schema engine as owner
`system`. Every template operation is additive, so applying one never needs
approval.

| Template      | For                                     | Adds                                                                                                       |
| ------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sales`       | B2B sales teams, founders selling       | `deal` (stage, amount, close date, company, point of contact); `company` gets industry and employee count  |
| `services`    | Agencies, consultants, freelancers      | `project` (status, budget, start and end dates, company, contacts); `proposal` (status, amount, sent date) |
| `clinic`      | Clinics, therapists, wellness practices | `appointment` (date and time, type, status, person); `person` gets date of birth and preferred channel     |
| `real_estate` | Agents and brokers                      | `property` (address, type, price, status); `viewing` (date, property, person, feedback)                    |
| `recruiting`  | Recruiters, hiring teams                | `job` (title, status, company); `application` (person, job, stage, source)                                 |
| `blank`       | Anything else                           | Nothing; the agent extends the base objects itself                                                         |

**Choosing a template on init.** A new workspace has no template applied,
and `describe_schema` says so (`initialized: false`). An agent that sees this
calls `list_templates`, picks the closest one from what it knows about the
business, or asks its user when it is unsure, and calls
`apply_template`. Choosing `blank` marks the workspace initialized without
adding anything. An agent that cannot decide should not guess: base objects
work without a template, and a template can be applied later.

**Later.** Templates are additive, so a workspace can apply a second one
later (a consultancy that starts recruiting). If a template's object or field
name collides with an existing custom one, applying it fails validation and
the error lists the collisions; nothing is half-applied. Template updates in
new Retainer releases reach workspaces through the same upgrade path as base
objects, matched by `universal_id`.

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
   title, its own short summary, the source's external ID, and the
   participants as handles (emails, phones) and/or record IDs.
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

A record ID the agent passes is used as given, after following merges; an
unknown or deleted one fails the call, since the agent named it explicitly.
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

Required scaffold addition: `merge_suggestions`. Flagging stale field values
is deferred: "stale" has no definition yet and nothing reads the flag.

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

| Operation                           | What it returns                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `describe_schema`                   | The workspace (ID, name, applied templates, `initialized`) and a compact list of its objects and fields        |
| `query_records`                     | Structured filter, sort and pagination over one object                                                         |
| `get_record`                        | One record with its fields and links                                                                           |
| `search`                            | Keyword search (Postgres full-text) across records, facts and interactions, with highlighted snippets          |
| `get_context(record, token_budget)` | A ready-to-use pack: key fields, current facts, open tasks, recent interaction summaries, fitted to the budget |

Every read hides soft-deleted parents/rows and superseded facts by default.
An explicit history mode can list retained assertions and facts with their
source and validity dates; exact `as_of` snapshots are deferred. Context
packs distinguish stated facts from current field values and show who wrote
each. They are assembled by rules (recency, precedence, the token budget),
not summarized by a model; summarizing is the agent's job.

### 5.1 Search

Search is Postgres full-text search, plus two standard extensions that ship
with Postgres and are offered by managed services: `pg_trgm` (fuzzy matching)
and `btree_gin` (combined indexes). No embeddings, no BM25 extension.

#### What is indexed

| Source         | Search text                                                                           | Column and index                                     |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `records`      | Values of `is_searchable` fields; the label field (usually the name) weighted highest | `search tsvector`, GIN on `(workspace_id, search)`   |
| `records`      | The label field as plain text, e.g. "Dana Levi"                                       | `label text`, trigram GIN on `(workspace_id, label)` |
| `facts`        | `content`                                                                             | `search tsvector`, GIN on `(workspace_id, search)`   |
| `interactions` | `title` (weighted higher) and `summary`                                               | `search tsvector`, GIN on `(workspace_id, search)`   |

The server computes every `search` and `label` value, in the same
transaction that writes the row (for records, the one that recomputes
`records.data`). They are not Postgres generated columns: which record fields
are searchable lives in schema metadata, and indexing and querying must share
one normalization function. Each fact carries its `record_id` and each
interaction its matched record IDs (possibly none or several), so a hit on a
fact or interaction also points to records.

Every index leads with `workspace_id` (`btree_gin`), so a common word is
matched within one workspace inside the index instead of across every
tenant and filtered afterwards.

#### Text normalization

All `tsvector` columns use the `simple` configuration: lowercase, split on
spaces and punctuation, no stemming. It handles mixed Hebrew and English
text. Two additions cover what stemming would otherwise catch:

- **Hebrew prefixes.** Hebrew attaches prefix letters to words. A Hebrew
  word that starts with ו, ה, ב, כ, ל, מ or ש is also indexed without that
  letter when two or more letters remain, so "בפגישה" ("in the meeting") is
  indexed as both "בפגישה" and "פגישה" ("meeting"). Query terms expand the same
  way. A word whose first letter is not really a prefix gains a spurious
  variant; that costs some precision and is accepted.
- **English plurals and endings.** Query terms of four or more letters are
  also matched as prefixes (`meeting:*`), so "meeting" finds "meetings".

Changing the configuration or the normalization later requires a background
job that rebuilds stored search values.

#### How a search runs

1. The server parses the query (quoted phrases, `OR`, `-word`) and builds the
   `tsquery` with the normalization above.
2. It runs one query each on records, facts and interactions. Workspace and
   liveness filters (and, for facts, "current, not superseded") apply before
   ranking and limit.
3. Each list is ranked with `ts_rank_cd`, using length normalization so long
   texts do not outrank short, precise matches. Hits carry a snippet from
   `ts_headline`.
4. If the records query returns few hits, the server also matches
   `records.label` by trigram similarity, so "Dana Levy" finds "Dana Levi".
5. Results come back grouped by type, each with its record IDs. Scores from
   the three lists are not comparable, so a caller that wants one list asks
   for it merged by reciprocal rank fusion (rank positions, not scores).

#### Why not BM25

`ts_rank_cd` scores how often and how close together query words appear, but
has no inverse document frequency: a word that appears everywhere in a
workspace counts as much as a rare one. BM25 handles that, but Postgres has it
only through extensions (for example ParadeDB's `pg_search` or Tiger Data's
`pg_textsearch`) that many managed Postgres services do not offer, which
would break "plain Postgres is the only dependency". Within one workspace
the candidate set is small, and an agent reads the top results anyway.

Search sits behind one internal interface, so a BM25 backend can be added
later as an option without changing the API.

There is no `ask` endpoint: answering questions is the agent's job. It
composes `search`, `query_records` and `get_context` with its own model.

---

## 6. Interfaces

### 6.1 REST (`/v1`)

| Route                                             | Purpose                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /v1/schema`                                  | Current schema                                                              |
| `POST /v1/schema/changes`                         | Request a schema change (applied or proposed)                               |
| `POST /v1/schema/changes/:id/approve` · `/reject` | Decide a proposed change                                                    |
| `GET /v1/templates`                               | Templates and what each adds (3.1)                                          |
| `POST /v1/templates/:name/apply`                  | Apply a template (needs `schema:write`)                                     |
| `POST /v1/objects/:object/records`                | Create a record                                                             |
| `POST /v1/objects/:object/query`                  | Filter records                                                              |
| `POST /v1/objects/:object/upsert`                 | Update or create a record found by `id` or `match`, with `ifMissing` (6.2)  |
| `GET` · `PATCH` · `DELETE /v1/records/:id`        | One record                                                                  |
| `GET /v1/records/:id/context`                     | Context pack                                                                |
| `POST /v1/records/:id/merge`                      | Merge another record into this one                                          |
| `POST /v1/records/:id/forget`                     | Hard delete for privacy requests (2.1)                                      |
| `GET` · `POST /v1/records/:id/facts`              | Facts about a record                                                        |
| `DELETE /v1/facts/:id`                            | Retract a fact (soft delete)                                                |
| `GET /v1/review`                                  | Pending assertions, suggested merges, participants matching deleted records |
| `POST /v1/assertions/:id/accept` · `/reject`      | Decide a pending assertion                                                  |
| `POST /v1/interactions`                           | Log an interaction; returns matched and unmatched participants (4.1)        |
| `GET` · `DELETE /v1/interactions/:id`             | Read or retract an interaction                                              |
| `POST /v1/search`                                 | Keyword search (5.1)                                                        |

The OpenAPI document is generated per workspace from its schema.

### 6.2 MCP

Hosted on the API server at `/mcp` (Streamable HTTP). `@retainer/mcp` is a
small stdio bridge for local clients that only speak stdio.

Tools are generic, not one per object. Custom objects would otherwise grow
the tool list without limit and break clients' tool caching.

`describe_schema`, `list_templates`, `apply_template`, `query_records`,
`get_record`, `search`, `get_context`, `upsert_record`, `log_interaction`,
`remember`, `propose_schema_change`.

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
← { "id": "rec_9f2…", "created": false, "fields": { "address": "applied" } }
```

The response reports each field as `applied`, `pending_review` or
`superseded` (rule 2.3), so an agent can tell its user that an update is
waiting for approval rather than claim it is done.

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
no-op). Required scaffold addition: an `idempotency_keys` table (workspace,
operation, key, request hash, result, expiry); `interactions.external_id`
only covers logging interactions.

Several agents can share a workspace. Each uses its own API key, so every
write is attributed to the agent that made it; between agents the latest
`observed_at` wins and the full history stays in `field_assertions`.

#### Responses of the memory tools

Record writes return the shape shown above. `log_interaction`, `remember`
and `get_context` return the following.

```
→ log_interaction {
    "kind": "call", "channel": "zoom", "externalId": "zoom-8812-3390",
    "occurredAt": "2026-10-29T14:00:00+02:00", "title": "Acme renewal call",
    "summary": "…",
    "participants": [ { "handle": "dana@acme.com", "role": "customer" },
                      { "handle": "ron.peretz@acme.com", "role": "customer" } ] }
← { "id": "int_51b…", "created": true,
    "participants": {
      "matched":   [ { "handle": "dana@acme.com", "role": "customer", "recordId": "rec_9f2…" } ],
      "unmatched": [ { "handle": "ron.peretz@acme.com", "role": "customer", "reason": "no_match" } ] } }
```

`created` is `false` when the same `(channel, externalId)` was already
logged with the same input (1.3). Handles come back normalized, in the order
logged; `handle` or `role` is `null` when not given. An unmatched
participant's `reason` is `no_match`, `phone_only` (phones never resolve a
participant on their own, 4.1), `deleted_record` (the handle belongs to a
soft-deleted record that was not merged; it is also listed in
`GET /v1/review`, 1.2) or `ambiguous` (several live records claim the
handle; `candidates` lists their IDs, 1.2).

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
participant with role `subject`. A `quote` needs a `source`. A retry with the
same idempotency key returns the same response.
`GET /v1/records/:id/facts` returns `{ record, facts }` with facts in this
shape, newest `validFrom` first, listing only live sources.

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
                              "title": "Globex data-platform demo", "summary": "…" } ],
    "omitted": { "openTasks": 0, "facts": 4, "recentInteractions": 11 },
    "tokenEstimate": 1380 }
```

A context pack is assembled by fixed rules (5):

- The record's current field values are always included, each with who
  wrote it and when it was observed, so a value is never mistaken for a
  stated fact. The budget applies to the sections after it.
- The other sections fill in this order until the budget is spent: open
  tasks (tasks linked to the record whose status is not `done`, earliest due
  date first, undated last), current facts (not superseded or retracted,
  newest `validFrom` first), then recent interactions (newest first). Items
  are never cut mid-text; a section stops at the last whole item that fits.
- `omitted` counts the items left out of each section, so the agent knows
  to read more with `search` or the REST routes.
- Tokens are estimated from characters, at about four per token. Retainer
  runs no tokenizer or model, so the budget is approximate. `tokenBudget`
  defaults to 2000 and is capped at 16000.

---

## 7. Tenancy and auth

- Every row has `workspace_id`. Postgres row-level security uses a
  per-transaction `app.workspace_id` setting as a second line of defense
  behind the application's own checks. Runtime roles must not own tables or
  have `BYPASSRLS`; migrations use a separate role. Tenant foreign keys must
  include `workspace_id` (or equivalent enforced checks), since independent
  UUID foreign keys do not prevent cross-workspace references. Validate
  field/object compatibility in addition to tenant membership.
  Required scaffold additions: `workspace_id` on `interaction_participants`
  and `fact_sources`; composite foreign keys
  `(workspace_id, parent_id)` referencing a unique `(workspace_id, id)` on
  each parent (today's independent FKs allow cross-workspace references);
  and RLS policies (absent from the initial migration).
- API-key lookup happens before the workspace is known, so `api_keys` is
  read through one narrow `SECURITY DEFINER` function that takes a key hash
  and returns the workspace, scopes and actor; the runtime role has no other
  access to that table. It rejects revoked keys, fixes its `search_path`, uses
  qualified table names and grants execution only to the runtime role.
- Background jobs carry their `workspace_id` and set the same setting, so
  workers are held to the same isolation as API requests.
- API keys are stored hashed, belong to one workspace, and carry scopes
  (`read`, `write`, `schema:write`, `admin`) and the actor they write as.
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
docker compose exec retainer retainer key revoke <key-id>
```

`--template` is optional; without it, the first agent chooses one (3.1).
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

1. Every read and write runs as `retainer_app` under RLS. The API-key lookup
   is the only `SECURITY DEFINER` function; no read takes a shortcut around
   RLS, including search and context.
2. Per-request database context is set in one place (`inWorkspace`).
3. A response mentions another record (conflict errors, merge candidates,
   relation labels, review items, context) only through one shared
   function, so a visibility check can be added there later.
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
| `packages/mcp`    | MIT      | stdio bridge to the hosted MCP endpoint             |
| `docker/`         | AGPL-3.0 | Dockerfile and Compose file                         |

## 9. Stack

TypeScript on Node 22, pnpm workspaces, Hono, Drizzle ORM and drizzle-kit
migrations, Zod, pg-boss, and the official MCP TypeScript SDK. No LLM SDK.

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

Each step lands with its tests (12). Step 1 also sets up the test harness:
fresh database per test, a helper that starts the server, and the CI
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

## 11. Schema checklist before build step 1

Changes to `packages/server/src/db/schema.ts` that this document requires and
the initial migration does not have yet. They are the first part of build
step 1.

**New tables**

- [ ] `record_identifiers`: normalized identifier per record, with a canonical
  value and a uniqueness claim; a partial unique index on
  `(workspace_id, field_id, value)` over claims (1.2)
- [ ] `merge_suggestions`: the two record IDs, reason, status (4.2)
- [ ] `idempotency_keys`: workspace, operation, key, request hash, result,
  expiry (6.2)
- [ ] Suppression list: workspace, keyed HMAC of a normalized email or phone
  (2.1)
- [ ] Deletion audit log: actor ID, time, counts only (2.1)

**New columns**

- [ ] `workspaces.templates jsonb` (applied template names and versions) and
  `workspaces.initialized_at` (3.1)
- [ ] `records.merged_into_id` (1.1, 4.2)
- [ ] `field_assertions.observed_at` (1.3, rule 2.2)
- [ ] `search tsvector` on `facts` and `interactions` (title and summary),
  computed by the server like `records.search` (5.1)
- [ ] `records.label text`: the label field as plain text, for fuzzy name
  lookup (5.1)
- [ ] `workspace_id` on `interaction_participants` and `fact_sources` (7)

**Agent-written memory (4.1, 4.3)**

- [ ] `interactions`: replace `content`, `content_format`, `ingest_status`
  and `ingest_error` with `summary text`
- [ ] Drop the `record_cards` table

**Changed constraints and defaults**

- [ ] Unique index on `record_links (source_record_id, field_id)`, so a
  many-to-one field has at most one edge per record (1.1)
- [ ] `facts.valid_from`: no `now()` default; set from the source (1.3,
  rule 2.6)
- [ ] Remove `proposed` from live `object_types` / `fields` status and from
  `SCHEMA_STATUSES` in `@retainer/shared` (1.1)
- [ ] Composite foreign keys `(workspace_id, parent_id)` referencing a unique
  `(workspace_id, id)` on each parent, instead of plain ID foreign keys (7)

**Extensions and search indexes**

- [ ] The migration runner creates `pg_trgm` and `btree_gin` (5.1)
- [ ] Replace `records_search_gin` with a GIN index on
  `(workspace_id, search)`; add the same on `facts` and `interactions` (5.1)
- [ ] Trigram GIN index on `records (workspace_id, label)` (5.1)

**Security**

- [ ] Row-level security policies on every tenant table, keyed on the
  per-transaction `app.workspace_id` setting (7)
- [ ] Separate migration and runtime roles; the runtime role does not own
  tables and has no `BYPASSRLS` (7)
- [ ] The `SECURITY DEFINER` function for API-key lookup (7)

## 12. Testing

Every build step lands with its tests. Nothing is "done" until the layers
below that apply to it pass locally and in CI. Retainer has no language
model inside it, so every layer except 5 is deterministic.

| Layer                   | What it proves                                                                                                                                                                      | How                                                                                                 | Runs                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------- |
| 1. Unit                 | Pure logic: the field-winner rules (2), schema validate/diff/classify (3), identifier normalization (emails, E.164 phones), Hebrew prefix and query parsing (5.1), value validation | Vitest, no database                                                                                 | Every PR               |
| 2. Database integration | Rules only Postgres can prove: concurrent creates with one email make one record, per-record locking, unique claims, row-level security between workspaces, merges, `forget`        | Vitest against real Postgres; each test gets a fresh database                                       | Every PR               |
| 3. API                  | Every REST route: auth, scopes, validation errors, response shapes                                                                                                                  | The Hono app called in-process against a real database                                              | Every PR               |
| 4. Agent scenarios      | End-to-end flows as an agent sees them: apply a template, create a person, update by `match`, log an interaction and cite it, review a conflict, search, get context                | A runner starts Postgres and the server, then drives them through the MCP client and REST           | Every PR (from step 2) |
| 5. Live agent           | Whether a real agent understands the tools and follows the workflow in 4.1: names, descriptions, error messages, what it chooses to write from a sample conversation                | A separate Claude Code or Codex session connected to Retainer's MCP endpoint, given realistic tasks | By hand, per milestone |

### Rules

- **Fresh database per test.** Migrations run once into a template
  database; each test file clones it (`CREATE DATABASE … TEMPLATE …`) and
  drops it after. Tests never share rows, so they run in parallel without
  flaking.
- **Real Postgres, never a mock,** for anything that touches the database.
  Locking, row-level security and unique constraints are the point of
  layers 2 and 3.
- **Concurrency is tested, not assumed.** Every rule in 2 that says
  "serialized", "atomic" or "idempotent" gets a test that runs the
  competing operations at the same time.
- **Scenarios follow the docs.** Each scenario in layer 4 matches a flow
  described here, so a change to the design shows up as a failing scenario.

### CI

A GitHub Actions workflow runs on every PR and on `main`: lint, typecheck,
then layers 1–4, with Postgres as a service container. Retainer calls no
model, so CI needs no API keys.
