# Retainer and Twenty: how the schemas differ

[Twenty](https://github.com/twentyhq/twenty) is an open-source CRM. Like
Retainer, it lets each workspace define its own objects and fields at
runtime, and it stores everything in Postgres. The two store that data in
very different ways, because they serve different users: Twenty is a CRM that
people use, while Retainer is memory that agents write to and people review.
This page compares the two data models. It is based on Twenty's `main`
branch as of November 2026.

## In one table

|                     | Twenty                                                                  | Retainer                                                                   |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Where records live  | A Postgres schema per workspace (`workspace_<id>`), a table per object  | One `records` table for every object in every workspace                    |
| Fields              | A column per field; composite fields (name, emails, links) span several | Keys in `records.data` (JSONB), keyed by the field's stable `key`          |
| Adding a field      | DDL (`ALTER TABLE … ADD COLUMN`) through a workspace migration runner   | One row in `fields`; no DDL                                                |
| Schema metadata     | `objectMetadata` and `fieldMetadata` in the shared `core` schema        | `object_types` and `fields`, changed only through the schema engine        |
| Relations           | A foreign key column on the source table (`companyId`)                  | Rows in `record_links`, with real foreign keys                             |
| Uniqueness          | A unique index on the column                                            | A unique index on `record_identifiers`, with no per-field DDL              |
| Source of truth     | The row: a write overwrites the value                                   | `field_assertions`; `records.data` is a cache derived from them            |
| History             | `timelineActivity` rows with a JSON payload of what changed             | Every assertion keeps its actor, source, confidence and status             |
| Unstructured memory | Notes and tasks as ordinary objects                                     | Events as records; `facts` and `comments` as built-in tables               |
| Tenant isolation    | Separate schemas                                                        | A `workspace_id` on every row, enforced by row-level security              |
| Search              | A `searchVector` tsvector column in each object's table                 | A `search` tsvector column on `records` and `facts` (§5.1)                 |

## Tables versus one JSONB table

Twenty gives each workspace its own Postgres schema and creates a real table
for every object in it, with a column for every field. A Person with a name,
emails and a company becomes columns like `nameFirstName`, `nameLastName`,
`emailsPrimaryEmail`, `emailsAdditionalEmails` and `companyId`. Adding a field
runs `ALTER TABLE` through Twenty's workspace migration runner, and the
server can lock DDL during upgrades (`WORKSPACE_SCHEMA_DDL_LOCKED`).

Retainer stores every record of every object in one `records` table. Field
values sit in `records.data` (JSONB) under each field's `key`, which never
changes when the field is renamed. Adding a field is one row in `fields`.
What real tables would give for free is rebuilt explicitly:

- **Relations**: `record_links` holds one row per edge, with real foreign
  keys and cascade delete.
- **Uniqueness and lookup**: `record_identifiers` holds every normalized
  email, phone and domain, plus each unique field's value. A single partial
  unique index enforces uniqueness for all of them.
- **Filtering**: JSONB containment on a shared GIN index.

The trade-off:

|                      | Table per object (Twenty)                         | One JSONB table (Retainer)                                               |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Agents adding fields | DDL: locks, and a partial failure is possible     | One metadata row                                                         |
| Queries and typing   | Native columns and indexes; plain SQL and BI work | Typed comparisons over JSONB; a hot field can become a real column later |
| Upgrades             | A migration per workspace schema                  | One fixed schema with normal migrations                                  |
| Many workspaces      | The catalog grows with workspaces × objects       | The catalog stays the same size                                          |

Retainer chose JSONB because agents create fields as they go: a field
should cost one row, not a schema migration. ARCHITECTURE.md §1.2 ("Why
JSONB and not a table per object") gives the full reasoning.

## Values: overwritten versus asserted

The bigger difference is what a value is.

In Twenty, a field value is the column's current content. A write replaces
it, and what changed is recorded separately as a timeline activity.

In Retainer, nobody writes a value directly. Agents, people and integrations
write **assertions**: a claimed value for one field of one record, with the
actor (taken from the API key), the event it came from, a confidence
and the time it was observed. `records.data` is computed from the winning
assertions:

- people outrank agents;
- newer observations outrank older ones;
- an agent that would overwrite a person's value leaves a `pending_review`
  assertion instead.

So every value can answer "who said this, when, and based on what", and
`records.data` can always be rebuilt from `field_assertions`.

## Memory beyond fields

Twenty models notes and tasks as ordinary objects with their own tables.
Retainer has three kinds of memory:

- **Events** (`event_records`, `event_links`): conversations and any type a
  workspace adds, logged with the records that took part or that they concern.
  Events are records of event types, so they have fields, assertions and search
  like any other record.
- **Facts** (`facts`, `fact_sources`): plain-language statements about a
  record, each citing the event it came from, with `valid_from` and
  supersession.
- **Comments** (`comments`): remarks people write on a record.

Events are in the schema so a workspace can add its own types. The write rules
still depend on them: a derived value cites the event it came from.

## Where they are alike

- Both keep the schema as data: objects and fields are rows, and each
  workspace can change its own.
- Both soft-delete records (`deletedAt` / `deleted_at`).
- Both search with Postgres full-text search on a stored tsvector column
  with the `simple` configuration. Neither uses embeddings.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 for Retainer's full data model
and §5.1 for search.
