# Changelog

All notable changes to Retainer are listed here. Versions follow
[semantic versioning](https://semver.org); before 1.0, a minor version may
include breaking changes.

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
- Interaction log with participant matching on normalized emails, and facts
  that cite the interactions they came from.
- Keyword search over records, facts and interactions (Postgres full-text and
  trigram fallback), and token-budgeted context packs.
- Consolidator: fact deduplication and supersession, merge suggestions,
  record merges, and `forget` for privacy requests with keyed-hash
  suppression of erased emails and phones.
- REST API under `/v1`, MCP over Streamable HTTP at `/mcp`, API keys with
  scopes and actors, row-level security between workspaces, and the operator
  CLI for workspaces and keys.
- Optional web app at `/app` for reviewing pending values, schema changes and
  merge suggestions, and for browsing and editing records with provenance.

### `@retainer/sdk`

- Typed client for every REST route, including search, context packs,
  merges, merge-suggestion dismissal and `forget`; typed `RetainerApiError`.

### `@retainer/mcp`

- stdio bridge (`retainer-mcp`) for MCP clients that only speak stdio,
  configured with `RETAINER_URL` and `RETAINER_API_KEY`.

### `@retainer/shared`

- Field types, value validation, schema definitions and the public request and
  response types shared by the server, the SDK and the web app.
