# Changelog

All notable changes to Retainer are listed here. Versions follow
[semantic versioning](https://semver.org); before 1.0, a minor version may
include breaking changes.

## Unreleased (`codex/surrealdb-v1`)

### Breaking

- SurrealDB 4.0.0 replaces PostgreSQL as the only runtime storage: a catalog
  database plus one database per workspace, typed tables per object and
  native relation tables ([migration spec](docs/surrealdb-migration-spec.md)).
  There is no data migration from a PostgreSQL install.
- Configuration: `RETAINER_SURREAL_*` and `RETAINER_SIGNING_KEY` replace
  `DATABASE_URL` and `RETAINER_DB_POOL_MAX`; `RETAINER_ROLE` accepts only
  `all`. One process per deployment (a second one refuses to start).
- Removed: the AWS deployment (`deploy/aws`, `docs/aws.md`, Lambda entry
  points), Drizzle migrations and `pnpm db:generate` / `db:migrate`.

### Added

- `get_operation` (`GET /v1/operations/:id`, `GET /v1/operations?kind=&idempotencyKey=`,
  SDK `getOperation`, MCP `get_operation`) and the `Retainer-Operation-Id`
  response header; a lost response is `unknown_outcome` with its operation ID.
- `traverse_records` (`POST /v1/records/traverse`, SDK `traverseRecords`,
  MCP `traverse_records`): bounded walks along relation fields and event links.
- `retainer signing-key generate`.
- `retainer search rebuild [--workspace]` rewrites search documents in batches
  while the server runs.

### Changed

- Search is SurrealDB full-text (BM25 prefix and exact-word indexes, trigram
  similarity): email and host words split at punctuation, and results are
  no longer weighted title-over-summary.
- Similar-name merge suggestions use Jaro-Winkler ≥ 0.9 on folded labels.

## 0.1.0

The first release: the whole of build order steps 1 to 6 in
[ARCHITECTURE.md](ARCHITECTURE.md#10-build-order).

### Server (`@retainer/server`, Docker image)

- Schema as data: base objects, six templates (`sales`, `services`, `clinic`,
  `real_estate`, `recruiting`, `blank`) and a schema engine that applies
  additive changes and holds destructive ones for a person's approval.
- Assertion-backed records: every field value is the winner among assertions
  from people, integrations and agents, with precedence, `observed_at`
  ordering and a review queue for agent values that would overwrite people.
- Interaction log with participant matching on normalized emails, `about`
  links to the records an interaction concerns, re-logging that adds the
  participants and `about` records it was missing, filtering and counting
  with `query_interactions`, and facts that cite the interactions they came
  from. `describe_schema` lists interactions and facts as built-ins.
- Keyword search over records, facts and interactions (Postgres full-text,
  with every word matched as a prefix and exact matches ranked first, accents
  ignored, email and website domains indexed, and a trigram fallback for
  misspelled names), and token-budgeted context packs.
- Consolidator: fact deduplication and supersession, merge suggestions,
  record merges, and `forget` for privacy requests with keyed-hash
  suppression of erased emails and phones.
- REST API under `/v1`, MCP over Streamable HTTP at `/mcp`, API keys with
  scopes and actors, row-level security between workspaces, and the operator
  CLI for workspaces and keys.
- Optional web app at `/app`, signed in with a personal API key: a review
  inbox for pending values, proposed schema changes and unresolved
  participants; record tables with filters, sorting and resizable,
  reorderable columns, a total count, per-column calculations (empty,
  unique, sum, average, min, max), row selection with bulk delete and merge,
  and editing cells in place; records in a side sheet or a full page, with
  provenance, inline field editing and retraction of facts and interactions;
  a schema page with objects, fields and change history; record creation
  from a schema-driven form; delete, merge (with a field-by-field comparison)
  and erase-for-privacy from a record's actions menu; suggested merges in the
  review inbox; ⌘K search across records, facts and interactions; and
  saved views shown as a table, a board grouped by a single-select field
  (with per-column counts and totals) or a month calendar, where cards and
  records move between columns and days by mouse, touch or keyboard.
- Saved views: `GET`/`POST /v1/objects/:object/views` and
  `GET`/`PATCH`/`DELETE /v1/views/:id`, with workspace or private
  visibility; fields are stored by key, so views follow renames, and a
  schema change that removes a field or option rewrites the views that
  named it.
- `groupBy` on `POST /v1/objects/:object/aggregate`: the same totals per
  value of a single-select field.
- AWS deployment (`deploy/aws`, [docs/aws.md](docs/aws.md)): Terraform for
  Lambda functions behind API Gateway (REST, MCP and the web app), a
  scheduled consolidator, an ops function for migrations and the operator
  CLI, and RDS PostgreSQL in a private VPC, with scripts to build, deploy
  (stop, migrate, start) and run operator commands, and an optional
  GitHub Actions deploy role. `RETAINER_DB_POOL_MAX` sets the API's
  database pool size (default 10).

### `@retainer/sdk`

- Typed client for every REST route, including search, context packs,
  aggregates, merges, merge-suggestion dismissal and `forget`; typed
  `RetainerApiError`.

### `@retainer/mcp`

- stdio bridge (`retainer-mcp`) for MCP clients that only speak stdio,
  configured with `RETAINER_URL` and `RETAINER_API_KEY`.

### `@retainer/shared`

- Field types, value validation, schema definitions and the public request and
  response types shared by the server, the SDK and the web app. Merge
  suggestions carry the object and label of both records (`records`).
