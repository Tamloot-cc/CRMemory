# Retainer

Open-source memory for AI agents that work with CRM data. No UI: REST API,
MCP endpoint and background workers on Postgres. Read
`ARCHITECTURE.md` before changing the data model, the schema engine, or write
rules.

## Commands

- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`
- Postgres for dev: `docker compose -f docker/compose.yml up -d postgres`
  (set `RETAINER_PG_PORT` if 5432 is taken, and match `DATABASE_URL`)
- `pnpm db:generate --name <name>` after editing `packages/server/src/db/schema.ts`;
  `pnpm db:migrate` to apply. Never hand-edit generated migrations.
- `pnpm dev` runs the server with `RETAINER_ROLE=all` from `.env`.

## Rules

- Every write carries an `Actor`, taken from the API key, never from the payload.
- `records.data` is keyed by `fields.key`, never by field name.
- `records.data` is derived from `field_assertions`; write assertions, not data.
- All schema changes go through the schema engine; never write to
  `object_types` or `fields` directly.
- Never hold a DB transaction open across an LLM call.
- No embeddings or semantic search: search is Postgres full-text only.
- Server code is AGPL-3.0; `shared`, `sdk` and `mcp` are MIT. Don't import
  server code into the MIT packages.
- TypeScript 7: `types: ["node"]` is set in `tsconfig.base.json` because TS no
  longer includes `@types/*` by default.
