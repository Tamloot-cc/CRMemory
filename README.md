# Retainer

Open-source memory for AI agents that work with customer relationships.

Retainer keeps a living record of every person, company and deal a business
works with. Agents read conversations with their own models and write what
matters: typed fields, plain-language facts and a log of interactions, each
linked to who wrote it and where it came from. Agents read it back through MCP
or a REST API.

There is no UI. It is a backend for agents.

- **Schema as data**: objects and fields are stored as rows, so a workspace,
  or an agent working in it, can add fields and objects at runtime.
- **Agent-written memory**: Retainer never calls a language model. It
  validates writes, resolves conflicts between agents and people, keeps
  history and makes it searchable.
- **Self-hosted**: one Docker image and Postgres.

Status: early development. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
design and build order.

## Run it

```sh
docker compose -f docker/compose.yml up --build
curl localhost:8787/health
```

On first boot the server creates a `default` workspace and prints an admin
API key once. Manage workspaces and keys with the operator CLI, which talks
to the database directly:

```sh
docker compose -f docker/compose.yml exec retainer retainer workspace create --name "Acme Clinic" --template clinic
docker compose -f docker/compose.yml exec retainer retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
```

Send the key as `Authorization: Bearer <key>` to the REST API under `/v1`.

## Connect an agent

Agents connect over MCP (Streamable HTTP) at `/mcp`, with the same key as a
bearer token. The key decides the workspace and who the agent's writes are
attributed to, so give each agent its own key. For example, in Claude Code:

```sh
claude mcp add --transport http retainer http://localhost:8787/mcp \
  --header "Authorization: Bearer <key>"
```

Tools: `describe_schema`, `list_templates`, `apply_template`,
`query_records`, `get_record`, `upsert_record` and `propose_schema_change`.
Interactions, facts and search come in later build steps.

## Develop

Requires Node 22 and pnpm 10.

```sh
pnpm install
cp .env.example .env
docker compose -f docker/compose.yml up -d postgres
pnpm db:migrate
pnpm dev
```

| Command                          | What it does                                                  |
| -------------------------------- | ------------------------------------------------------------- |
| `pnpm build`                     | Build every package                                           |
| `pnpm typecheck`                 | Type-check every package                                      |
| `pnpm test`                      | Run tests (integration tests need Postgres at `DATABASE_URL`) |
| `pnpm lint`                      | Biome lint and format check                                   |
| `pnpm db:generate --name <name>` | Create a migration from `packages/server/src/db/schema.ts`    |
| `pnpm db:migrate`                | Apply migrations                                              |
| `pnpm retainer <command>`        | Run the operator CLI against `DATABASE_URL`                   |

## Packages

| Package           | License  | Contents                                    |
| ----------------- | -------- | ------------------------------------------- |
| `packages/server` | AGPL-3.0 | API, MCP endpoint, workers, schema engine   |
| `packages/shared` | MIT      | Field types, composite value shapes, actors |
| `packages/sdk`    | MIT      | TypeScript client                           |
| `packages/mcp`    | MIT      | stdio bridge for MCP clients                |

## License

The server is licensed under [AGPL-3.0](LICENSE). The SDK, shared types and
MCP bridge are MIT-licensed; see each package's `LICENSE`.
