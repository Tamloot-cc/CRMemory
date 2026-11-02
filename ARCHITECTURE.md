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

Three layers, all in one Postgres database.

### 1.1 Schema (metadata)

| Table            | Holds                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `object_types`   | The kinds of things tracked: `person`, `company`, `deal`, `task`, plus custom objects            |
| `fields`         | The fields of each object: type, settings, flags (`is_unique`, `is_filterable`, `is_searchable`) |
| `schema_changes` | Every applied, proposed or rejected change, with its actor                                       |

Every schema row carries:

- `universal_id`: a stable UUID that is the same for a standard object or
  field in every workspace, so upgrades can find it.
- `owner`: `system` (shipped with CRMemory), `workspace` (added by a person),
  or `agent` (added by an agent).
- `status`: `active`, `proposed`, or `deprecated`.
- `key` (fields only): a short, permanent ID used as the JSON key in
  `records.data`. Renaming a field changes `name`, never `key`, so a rename
  never touches the data.

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
`updated_by`. These are real columns on `records`, not schema fields.

#### Actor

Every write carries an actor: `{ type, id, name? }` where `type` is `user`,
`agent`, `integration`, or `system`. The API key decides the actor; callers
cannot claim to be someone else.

### 1.2 Records

| Table          | Holds                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `records`      | One row per entity: `workspace_id`, `object_type_id`, `data jsonb` (keyed by field `key`), `search tsvector`, built-in columns |
| `record_links` | Relations as edges: `field_id`, `source_record_id`, `target_record_id`. Real foreign keys with cascade delete                  |

`records.data` is a **cache computed from `field_assertions`** (below). If the
layout ever needs to change, records are rebuilt from assertions.

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
3. **Indexes from the schema**: marking a field `is_filterable` or
   `is_unique` makes the schema engine create a partial expression index
   (`… ON records ((data->>'<key>')) WHERE object_type_id = '<id>'`).
4. **Readable SQL**: the schema engine maintains a typed view per object and
   workspace (`crm_views.<workspace>_<object>`) for people and BI tools.
5. **Escape hatch**: a field that gets very hot can be promoted to a real
   column later.

### 1.3 Memory

| Table                      | Holds                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interactions`             | Raw, immutable sources: meeting, call, email, message, note, document. `kind`, `channel`, `occurred_at`, `content`, `external_id` (unique per workspace and channel, for safe re-ingest), `ingest_status` |
| `interaction_participants` | Who took part: a `handle` (email or phone), `role`, and the matched `record_id` once resolved                                                                                                             |
| `interaction_chunks`       | Chunks of long interaction content, with embeddings, for search                                                                                                                                           |
| `field_assertions`         | A claimed value for one field of one record: value, actor, source interaction, confidence, `status` (`active`, `superseded`, `pending_review`, `rejected`)                                                |
| `facts`                    | Plain-language claims about a record: `content`, `kind` (`stated` or `inferred`), confidence, `valid_from` / `valid_to`, `superseded_by`, embedding                                                       |
| `fact_sources`             | What a fact rests on: an interaction (with an optional quote) or other facts (for inferences)                                                                                                             |
| `record_cards`             | A short regenerated profile per record, used at the top of every context pack                                                                                                                             |

---

## 2. Write rules

1. **Nothing is written without an actor and, for derived data, a source.**
2. **Precedence decides a field's value**: `user` > `integration` > `agent`
   > `system`. Within the same precedence, the latest assertion wins.
3. **Agents never silently overwrite people.** If an active `user` assertion
   exists, an agent's new value is stored as `pending_review` and does not
   change `records.data`.
4. **Facts are never deleted by the system, only superseded.** Both versions
   keep their time period, so "what did we believe in March?" is answerable.
   A person can still hard-delete data (privacy requests).

---

## 3. Schema engine

One entry point for every schema change, whoever makes it (seed, upgrade,
person or agent). Same pattern as Twenty's migration engine:

1. **Load** the workspace's current schema.
2. **Apply** the requested operations in memory to get the desired schema.
3. **Validate**: name collisions, reserved names, relation targets, option
   values, type rules.
4. **Diff** current against desired into a list of operations.
5. **Classify** each operation:
   - Additive: create object, create field, add select option, change
     label/description, mark a field filterable/searchable.
   - Destructive: rename, change type, remove option, delete field or object,
     make a field required or unique.
6. **Apply or propose**:
   - All additive, or the actor is a `user` with admin rights: apply in one
     transaction (metadata rows, view refresh, `schema_version + 1`).
     Indexes are built afterwards by a job with `CREATE INDEX CONCURRENTLY`,
     which cannot run inside a transaction.
   - Otherwise: store as `proposed` in `schema_changes` for a person to
     approve or reject.

Standard objects ship as code (definitions with fixed `universal_id`s) and
are applied through the same engine when a workspace is created or upgraded.

---

## 4. Runtime

```
 AI agents ── MCP ───┐
 Apps / SDK ── REST ─┤──► API server ─────────────► Postgres + pgvector
 Integrations ───────┘     (ask agent runs inline)   schema · records ·
                                │                     memory · job queue
                                ▼                          ▲
                            Workers ───────────────────────┘
                            ├─ ingest  (per interaction)
                            ├─ consolidate (scheduled)
                            ├─ embed
                            └─ schema-index builder
```

One Docker image, started with a role: `api`, `worker`, or `all`.
Postgres is the only dependency; the job queue runs on Postgres too.

### 4.1 Ingest pipeline (per interaction)

1. **Resolve participants**: match handles to records by email or phone.
   Unknown handles create a `person` record (actor `system`) or stay
   unresolved, depending on workspace settings.
2. **Extract**: one structured LLM call. The prompt includes the schema of
   the objects involved, so output is typed:
   - field assertions for the participants' records and their related records
     (company, deals);
   - facts with quotes from the source;
   - new records to create (e.g. a task someone committed to).
3. **Write** everything with provenance, applying the write rules.
4. **Refresh** affected `record_cards` and enqueue embeddings.

### 4.2 Consolidator (scheduled per workspace)

- Merge duplicate facts; supersede contradicted ones.
- Suggest merges of duplicate records (same person, two records).
- Infer facts from other facts (`kind = inferred`, linked to premises).
- Flag field values that have gone stale.

### 4.3 Rule from Honcho

Never hold a database transaction open across an LLM or embedding call.
Compute the external result first, then write in a short transaction.

---

## 5. Read paths

| Operation                           | What it returns                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `describe_schema`                   | Compact list of objects and fields for an agent's prompt                                                                      |
| `query_records`                     | Structured filter, sort and pagination over one object                                                                        |
| `get_record`                        | One record with its fields, links and card                                                                                    |
| `search`                            | Keyword (tsvector) plus semantic (pgvector) search across records, facts and interactions, merged with reciprocal rank fusion |
| `get_context(record, token_budget)` | A ready-to-use pack: card, key fields, recent facts, open tasks, last interactions, fitted to the budget                      |
| `ask(question, record?)`            | A recall agent that loops over the tools above and answers with citations                                                     |

---

## 6. Interfaces

### 6.1 REST (`/v1`)

| Route                                             | Purpose                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `GET /v1/schema`                                  | Current schema                                     |
| `POST /v1/schema/changes`                         | Request a schema change (applied or proposed)      |
| `POST /v1/schema/changes/:id/approve` · `/reject` | Decide a proposed change                           |
| `POST /v1/objects/:object/records`                | Create a record                                    |
| `POST /v1/objects/:object/query`                  | Filter records                                     |
| `GET` · `PATCH` · `DELETE /v1/records/:id`        | One record                                         |
| `GET /v1/records/:id/context`                     | Context pack                                       |
| `GET` · `POST /v1/records/:id/facts`              | Facts about a record                               |
| `POST /v1/interactions`                           | Log an interaction (ingest runs in the background) |
| `POST /v1/search`                                 | Hybrid search                                      |
| `POST /v1/ask`                                    | Recall agent                                       |

The OpenAPI document is generated per workspace from its schema.

### 6.2 MCP

Hosted on the API server at `/mcp` (Streamable HTTP). `@crmemory/mcp` is a
small stdio bridge for local clients that only speak stdio.

Tools are generic, not one per object. Custom objects would otherwise grow
the tool list without limit and break clients' tool caching.

`describe_schema`, `query_records`, `get_record`, `search`, `get_context`,
`ask`, `upsert_record`, `log_interaction`, `remember`,
`propose_schema_change`.

Inputs are validated at runtime against the workspace schema, and validation
errors name the field and the allowed values so the agent can retry.

---

## 7. Tenancy and auth

- Every row has `workspace_id`. Postgres row-level security uses a
  per-transaction `app.workspace_id` setting as a second line of defense
  behind the application's own checks.
- API keys are stored hashed, belong to one workspace, and carry scopes
  (`read`, `write`, `schema:write`, `admin`) and the actor they write as.
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
migrations, Zod, pg-boss, pgvector, the Vercel AI SDK (bring your own model
provider), and the official MCP TypeScript SDK.

## 10. Build order

1. Schema engine with standard objects, records CRUD, REST, API keys.
2. MCP endpoint with the read and write tools.
3. Interactions and the ingest pipeline (participants, extraction, assertions).
4. Facts, embeddings, hybrid search, context packs.
5. `ask` agent and the consolidator.
6. SDK, stdio bridge, docs, first release.
