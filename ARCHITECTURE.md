# CRMemory architecture

CRMemory is an open-source memory layer for AI agents that work with customer
relationships. It has no UI. Agents and apps use it through a REST API and an
MCP server.

It combines two ideas:

- **Schema as data** (from [Twenty](https://github.com/twentyhq/twenty)): the
  shape of the CRM (objects, fields, relations) is stored as rows, so a
  workspace, or an agent working in it, can extend the model at runtime.
- **Derived memory** (from [Honcho](https://github.com/plastic-labs/honcho)):
  raw interactions go in, and background workers turn them into facts, field
  values and summaries, each traceable to its source.

Interactions come in, the current schema tells the extractor what to look
for, and the output is typed field values plus plain-language facts.

---

## 1. Data model

Three layers, all in one Postgres database. This document describes the
intended first release; the scaffold is not a working implementation of these
invariants. Inline schema notes identify changes still needed in
`packages/server/src/db/schema.ts`; section 11 collects them in one checklist.

### 1.1 Schema (metadata)

| Table            | Holds                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `object_types`   | The kinds of things tracked: `person`, `company`, `deal`, `task`, plus custom objects                           |
| `fields`         | The fields of each object: type, settings, flags (`is_nullable`, `is_unique`, `is_filterable`, `is_searchable`) |
| `schema_changes` | Every applied, proposed, rejected or failed change, with its operations and actor                               |

Every schema row carries:

- `universal_id`: a stable UUID that is the same for a standard object or
  field in every workspace, so upgrades can find it.
- `owner`: `system` (shipped with CRMemory), `workspace` (added by a person),
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

Composite shapes are defined once in `@crmemory/shared`, so every object that
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
cannot claim to be someone else. Background extraction uses a server-assigned
`agent` actor, while the source interaction retains its submitting actor.
An email imported with a user's or integration's key must not give LLM
output that actor's higher precedence. System maintenance uses a server-owned
`system` actor; neither actor comes from extraction output.

### 1.2 Records

| Table                | Holds                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records`            | One row per entity: `workspace_id`, `object_type_id`, `data jsonb` (keyed by field `key`), `search tsvector`, built-in columns                                                                                                          |
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
stops two concurrent ingests from creating the same person twice.
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
or explicitly purged, so ingest cannot silently recreate them. A match on a
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

| Table                      | Holds                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interactions`             | Raw, immutable sources: meeting, call, email, message, note, document. `kind`, `channel`, `occurred_at`, `content`, `external_id` (unique per workspace and channel, for safe re-ingest), `ingest_status`         |
| `interaction_participants` | Who took part: a `handle` (email or phone), `role`, and the matched `record_id` once resolved                                                                                                                     |
| `field_assertions`         | A claimed value for one field of one record: value, actor, source interaction, confidence, `observed_at` (when the claim was true at the source), `status` (`active`, `superseded`, `pending_review`, `rejected`) |
| `facts`                    | Plain-language claims about a record: `content`, `kind` (`stated` or `inferred`), confidence, `valid_from` / `valid_to` (when it was true in the world), `superseded_by`                                          |
| `fact_sources`             | What a fact rests on: an interaction (with an optional quote) or other facts (for inferences)                                                                                                                     |
| `record_cards`             | A short regenerated profile per record, used at the top of every context pack                                                                                                                                     |

Required scaffold addition: `field_assertions.observed_at`. Replace
the unconditional `facts.valid_from = now()` default with source-derived
validity (rule 2.6), so backfilled facts do not appear newly true.

Sending an interaction again with the same `(workspace_id, channel,
external_id)` and identical input returns the existing one, including its
ingest status. A different payload for that identity returns a conflict;
it is never silently ignored. `channel` must distinguish source accounts
when their external IDs can overlap. Without `external_id`, callers do not
get deduplication. An edited source needs a new `external_id` in v1;
creating it does not retract the old source's claims; the caller retracts
the old interaction (`DELETE /v1/interactions/:id`).

---

## 2. Write rules

1. **Nothing is written without an actor and, for derived data, a source.**
   A direct write through the API has the actor as its source. A fact an
   agent states directly (`remember`) is stored with a `note` interaction as
   its source, so every fact has one.
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
   `observed_at` is derived by the server from the source, not invented by
   the extractor; direct writes use server time.
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
5. **Writes to one record are serialized.** A write locks the record row
   (`SELECT … FOR UPDATE`), inserts its assertions, recomputes only the
   touched keys, and updates `data`, `record_links` and `record_identifiers`
   in the same short transaction. Nothing does read-modify-write on `data`
   outside that lock, so two agents or two ingests writing the same record
   never lose each other's values. Multi-record writes lock records in sorted
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
record's facts and card are hidden with it. Retracting an interaction also
excludes its derived claims, recomputes field winners and
invalidates affected cards. Facts with other live sources may remain.
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
   field values, links, identifiers and search text; discard and regenerate
   affected cards from surviving sources;
4. hard-delete the record, its assertions, facts, card, links and identifiers;
5. write a minimal audit entry (actor ID, time, counts), without copied names,
   handles, source text or extracted values.

Workers and writes coordinate with deletion: after every external call they
recheck that sources and targets are live under lock before committing, and
participant creation checks suppression in the same serialization boundary
as `forget`. A queued or running job must not resurrect deleted content.
Delete job payloads, idempotency responses and error text containing erased
content too; prefer jobs carrying IDs only.

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

---

## 4. Runtime

```
 AI agents ── MCP ───┐
 Apps / SDK ── REST ─┤──► API server ─────────────► Postgres
 Integrations ───────┘                              schema · records ·
                                │                     memory · job queue
                                ▼                          ▲
                            Workers ───────────────────────┘
                            ├─ ingest  (per interaction)
                            └─ consolidate (scheduled)
```

One Docker image, started with a role: `api`, `worker`, or `all`.
Postgres is the only dependency; the job queue runs on Postgres too.

### 4.1 Ingest pipeline (per interaction)

1. **Resolve participants**: normalize handles (lowercased email, E.164
   phone) and look them up in `record_identifiers`. Unknown handles create a
   `person` record (actor `system`) or stay unresolved, depending on
   workspace settings. Only a handle that is a unique identifier can
   auto-create, because the create relies on that unique constraint: a
   concurrent ingest that loses the race uses the winner's record.
   Phones are not unique (numbers are shared and reassigned), so in v1 a
   participant known only by phone (WhatsApp, SMS, calls) stays unresolved
   unless the caller passes its record ID. Matching a phone held by exactly
   one live record is a later option.
   Never auto-created: the workspace's own domains (its team),
   no-reply and bulk senders, suppressed handles (2.1), and participants
   with only a display name (a transcript speaker called "John"). A new
   person is linked to an existing `company` only if that domain identifies
   exactly one company, excluding free-mail domains. A domain alone never
   merges companies; ambiguous handles remain unresolved.
2. **Extract**: one structured LLM call. The prompt includes the schema of
   the objects involved and their current values and open tasks, so output
   is typed and the model can update rather than duplicate:
   - field assertions for the participants' records and their related records
     (company, deals);
   - facts with quotes from the source;
   - new records to create (e.g. a task someone committed to).

   Extraction never changes the schema. Something with no field to hold it
   becomes a fact. Source content is untrusted data, not instructions: the
   extractor has no tools or schema-write authority. The server supplies
   target IDs and validates every output against those allowed targets;
   confidence and JSON validity do not establish that a claim is true.
3. **Write** everything with provenance, applying the write rules. Output is
   validated against the schema as it is now, which may have changed while
   the LLM ran; values for fields that no longer exist are dropped. The
   write runs in one transaction that locks the interaction row, rechecks
   source liveness, exits if it is already `done`, persists all extracted
   outputs and sets it to `done`, so a retried job never writes twice.
   Participant resolution is independently idempotent; new tasks and other
   extraction-created records are committed with the extraction output.
4. **Mark** affected `record_cards` stale and durably schedule a card
   refresh in that same transaction (pg-boss transactional enqueue
   or a Postgres outbox). Interaction creation and initial ingest enqueue
   are atomic too; a crash between database commit and enqueue cannot strand
   work. Cards are regenerated by a debounced job, not once per interaction.
   Jobs have bounded retries and visible failure state; an authorized retry
   resumes failed work without requiring a new source identity.

#### Cost and latency

Extraction is the main running cost, so the first release keeps it bounded:
interactions from bulk or no-reply senders, and internal-only ones with no
target record, are stored and searchable but not extracted. A note or an
internal meeting about a customer is still extracted when the caller names
its target records as `mentioned` participants (`log_interaction` accepts
record IDs there); otherwise a user's own notes, which have no external
participant, would never be extracted. Enforce limits on source bytes,
chunks, input/output tokens, attempts and concurrent calls per workspace;
reject oversized input explicitly rather than silently truncating it.
Content too long for one call is extracted in bounded chunks within the
same job, deduplicating repeated outputs from chunk overlap, and committed
once. A retry re-runs the whole extraction; per-chunk checkpoints are
deferred, since they need their own storage and most interactions fit one
call. Record skipped/failed reasons separately from successful extraction.
The extraction model is a workspace setting (a small model is the
default), and token usage is recorded on the
interaction so operators can see cost per workspace. Ingest is asynchronous,
so its latency never blocks `log_interaction`.

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

Every field/fact mutation, source retraction, merge and schema change that
affects a card marks it stale in the same transaction. `record_cards` stores
`stale_since` and an incrementing `source_revision`. Regeneration publishes
and clears staleness only if that revision is unchanged since its inputs
were read; an older job cannot mark a newer mutation's card fresh.

Required scaffold additions: `merge_suggestions` and
`record_cards.stale_since` / `source_revision` / `withheld` (set when
retraction, merge or `forget` made the card stale, so it is not served; see
5). Flagging stale field values
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

### 4.3 Rule from Honcho

Never hold a database transaction open across an LLM call.
Compute the external result first, then write in a short transaction.

---

## 5. Read paths

| Operation                           | What it returns                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `describe_schema`                   | Compact list of objects and fields for an agent's prompt                                                 |
| `query_records`                     | Structured filter, sort and pagination over one object                                                   |
| `get_record`                        | One record with its fields, links and card                                                               |
| `search`                            | Keyword search (Postgres full-text) across records, facts and interactions, with highlighted snippets    |
| `get_context(record, token_budget)` | A ready-to-use pack: card, key fields, recent facts, open tasks, last interactions, fitted to the budget |

Every read hides soft-deleted parents/rows and superseded facts by default.
An explicit history mode can list retained assertions and facts with their
source and validity dates; exact `as_of` snapshots are deferred. A card
made stale by new information is still served, marked with `stale_since`,
followed by the facts and field changes newer than it; omitting it would
leave busy records, which are always stale between debounced refreshes,
with no card at all. A card made stale by retraction, merge or `forget` may
contain removed content, so it is not served until regenerated. Context
packs distinguish stated claims from current field values.

`search` uses Postgres full-text search only.
Each fact carries its `record_id` and each interaction its matched record
IDs (possibly none or several), so a hit on a fact or interaction also
points to records. Apply workspace and liveness filters before ranking and
limit, rank with `ts_rank`, and return source IDs with a snippet
(`ts_headline`) rather than whole interactions.
Required scaffold addition: generated `tsvector` columns with GIN indexes on
`facts` and `interactions`, next to `records.search`. All three use one text-search
configuration, `simple` in v1, for mixed Hebrew/English text without
language-specific stemming. Alternative configurations are deferred;
changing one later requires rebuilding stored search vectors as well as
changing query tokenization.

`ask` is deferred from v1: callers can compose search and context tools in
their own agent. This keeps request-time model loops, budgets and timeout
handling out of the API server.

---

## 6. Interfaces

### 6.1 REST (`/v1`)

| Route                                             | Purpose                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /v1/schema`                                  | Current schema                                                              |
| `POST /v1/schema/changes`                         | Request a schema change (applied or proposed)                               |
| `POST /v1/schema/changes/:id/approve` · `/reject` | Decide a proposed change                                                    |
| `POST /v1/objects/:object/records`                | Create a record                                                             |
| `POST /v1/objects/:object/query`                  | Filter records                                                              |
| `GET` · `PATCH` · `DELETE /v1/records/:id`        | One record                                                                  |
| `GET /v1/records/:id/context`                     | Context pack                                                                |
| `POST /v1/records/:id/merge`                      | Merge another record into this one                                          |
| `POST /v1/records/:id/forget`                     | Hard delete for privacy requests (2.1)                                      |
| `GET` · `POST /v1/records/:id/facts`              | Facts about a record                                                        |
| `DELETE /v1/facts/:id`                            | Retract a fact (soft delete)                                                |
| `GET /v1/review`                                  | Pending assertions, suggested merges, participants matching deleted records |
| `POST /v1/assertions/:id/accept` · `/reject`      | Decide a pending assertion                                                  |
| `POST /v1/interactions`                           | Log an interaction (ingest runs in the background)                          |
| `GET` · `DELETE /v1/interactions/:id`             | Inspect ingest status or retract a source                                   |
| `POST /v1/interactions/:id/retry`                 | Retry failed ingest without a new source identity                           |
| `POST /v1/search`                                 | Hybrid search                                                               |

The OpenAPI document is generated per workspace from its schema.

### 6.2 MCP

Hosted on the API server at `/mcp` (Streamable HTTP). `@crmemory/mcp` is a
small stdio bridge for local clients that only speak stdio.

Tools are generic, not one per object. Custom objects would otherwise grow
the tool list without limit and break clients' tool caching.

`describe_schema`, `query_records`, `get_record`, `search`, `get_context`,
`upsert_record`, `log_interaction`, `remember`,
`propose_schema_change`.

Inputs are validated at runtime against the workspace schema, and validation
errors name the field and the allowed values so the agent can retry.

`remember(record, text)` stores the text as a `note` interaction and writes
one `stated` fact from it at once, so the agent can read it back
immediately. Do not enqueue extraction of that note too, which would create
a second fact. `upsert_record` uses an explicit record ID or a declared unique
identifier with the conflict rules in 1.2; names and shared handles are not
idempotency keys. Calls without either explicitly create a new record.

Create-style writes (`remember`, record creation and merge requests) accept
a caller idempotency key scoped by workspace and operation. Store the request
hash and result atomically with the mutation; retries return the original
result, and reuse with a different payload fails. Identifier matching alone
does not make note creation or assertion history idempotent. A merge
request is already idempotent by state (B already merged into A is a
no-op). Required scaffold addition: an `idempotency_keys` table (workspace,
operation, key, request hash, result, expiry); `interactions.external_id`
only covers interaction ingest.

Several agents can share a workspace. Each uses its own API key, so every
write is attributed to the agent that made it; between agents the latest
`observed_at` wins and the full history stays in `field_assertions`.

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
migrations, Zod, pg-boss, the Vercel AI SDK (bring your own model
provider), and the official MCP TypeScript SDK.

## 10. Build order

1. Schema engine with standard objects, assertion-backed records CRUD,
   REST and API keys (including direct-write precedence and review).
2. MCP endpoint with the read and write tools.
3. Interactions and the ingest pipeline (participants, extraction, assertions).
4. Facts, keyword search, context packs.
5. Consolidator (fact dedupe and supersession, merge suggestions), review
   queue, `forget`.
6. SDK, stdio bridge, docs, first release.

Not planned: embeddings and semantic search. Search is Postgres full-text
only, so no vector extension or embedding provider is needed.

Left out of the first release: `ask`, phone-based participant matching,
typed SQL views, per-field index automation, field type changes, inferred
facts, automatic record merges, stale-field flags, per-chunk extraction
checkpoints, exact historical belief snapshots, versioned re-ingest of edited
sources, and partial redaction on `forget`.

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

- [ ] `records.merged_into_id` (1.1, 4.2)
- [ ] `field_assertions.observed_at` (1.3, rule 2.2)
- [ ] `record_cards.stale_since`, `source_revision`, `withheld` (4.2, 5)
- [ ] Generated `search tsvector` columns with GIN indexes on `facts` and
  `interactions`, using the `simple` configuration like `records.search`
  (5)
- [ ] `workspace_id` on `interaction_participants` and `fact_sources` (7)

**Changed constraints and defaults**

- [ ] Unique index on `record_links (source_record_id, field_id)`, so a
  many-to-one field has at most one edge per record (1.1)
- [ ] `facts.valid_from`: no `now()` default; set from the source (1.3,
  rule 2.6)
- [ ] Remove `proposed` from live `object_types` / `fields` status and from
  `SCHEMA_STATUSES` in `@crmemory/shared` (1.1)
- [ ] Composite foreign keys `(workspace_id, parent_id)` referencing a unique
  `(workspace_id, id)` on each parent, instead of plain ID foreign keys (7)

**Security**

- [ ] Row-level security policies on every tenant table, keyed on the
  per-transaction `app.workspace_id` setting (7)
- [ ] Separate migration and runtime roles; the runtime role does not own
  tables and has no `BYPASSRLS` (7)
- [ ] The `SECURITY DEFINER` function for API-key lookup (7)
