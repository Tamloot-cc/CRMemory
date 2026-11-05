# Retainer

Open-source memory for AI agents that work with CRM data. Optional web app
in `packages/web`, plus a REST API, MCP endpoint and background workers in
one process on SurrealDB. Read `ARCHITECTURE.md` before changing the data
model, the schema engine, or write rules, and `docs/surrealdb-migration-spec.md`
for the storage design (sections 4-9) and its recorded deviations (section 13).

## Commands

- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`
- SurrealDB for dev: `docker compose -f docker/compose.yml up -d surrealdb`
  (the pinned 4.0.0 digest; set `RETAINER_SURREAL_PORT` if 8000 is taken, and
  match `RETAINER_SURREAL_URL`)
- `pnpm retainer signing-key generate` prints a `RETAINER_SIGNING_KEY` for `.env`.
- Web: `pnpm dev:web` alongside `pnpm dev`; `pnpm build` builds static assets.
- `pnpm test:web` runs Playwright against the built web app and real SurrealDB
  (`RETAINER_SURREAL_URL` required; a fresh namespace per test).
- `pnpm dev` runs the server (API, MCP and workers) from `.env`. A second
  process against the same namespace refuses to start (the process lease).

## Testing

See `ARCHITECTURE.md` section 12 for the test layers.

- Every feature lands with unit tests and, if it touches the database,
  integration tests against real SurrealDB. Never mock the database.
- Each test file gets its own namespace (`useTestBackend()`), with its own
  catalog and workspace databases; never share rows between test files.
- Rules described as serialized, atomic or idempotent need a test that runs
  the competing operations concurrently, including from a second backend
  (`backend.another()`) so the process-local queue cannot hide conflicts.

## Rules

- Every write carries an `Actor`, taken from the API key, never from the payload.
- Every workspace write is one `mutate()` operation (write protocol, spec
  section 6): plan from reads, then one revision-checked transaction whose
  statements each have an effect check. Nothing writes around it.
- Field values live in typed `f_<key>` columns of the object's table, keyed
  by `fields.key`, never by field name; relations are native edges in
  `r_<field universal id>` tables. Both are derived from `field_assertions`:
  write assertions, not values.
- All schema changes go through the schema engine; never write to
  `object_types` or `fields` directly or issue `DEFINE` outside it.
- Pass every caller value as a CBOR parameter (`db/surreal.ts`); identifiers
  only through `ident()` from validated metadata. Never interpolate caller text
  into SurrealQL.
- Unique indexes are defined alone, outside a transaction, then verified
  (`db/provision.ts`); never define one inside `BEGIN`/`COMMIT`.
- Reads are point lookups or top-level indexed statements per value; no
  closures or `IN` lists over a frontier, and no `LIMIT` after an unindexed scan.
- Retainer never calls a language model or embedding provider. Agents decide
  what to write; the server validates, stores and retrieves.
- No embeddings or semantic search: search is SurrealDB full-text only.
- Server code is AGPL-3.0; `shared`, `sdk`, `mcp` and `web` are MIT. Don't
  import server code into the MIT packages.
- TypeScript 7: `types: ["node"]` is set in `tsconfig.base.json` because TS no
  longer includes `@types/*` by default.
