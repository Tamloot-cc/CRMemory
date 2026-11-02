# CRMemory

Open-source memory for AI agents that work with customer relationships.

CRMemory keeps a living record of every person, company and deal a business
works with. Agents log interactions (meetings, calls, emails, messages), and
CRMemory turns them into typed fields and plain-language facts, each linked to
the interaction it came from. Agents read it back through MCP or a REST API.

There is no UI. It is a backend for agents.

- **Schema as data**: objects and fields are stored as rows, so a workspace,
  or an agent working in it, can add fields and objects at runtime.
- **Derived memory**: background workers extract facts and field values from
  raw interactions, with provenance and confidence.
- **Self-hosted**: one Docker image and Postgres with pgvector.

Status: early development. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
design and build order.

## Run it

```sh
docker compose -f docker/compose.yml up --build
curl localhost:8787/health
```

## Develop

Requires Node 22 and pnpm 10.

```sh
pnpm install
cp .env.example .env
docker compose -f docker/compose.yml up -d postgres
pnpm db:migrate
pnpm dev
```

| Command                          | What it does                                               |
| -------------------------------- | ---------------------------------------------------------- |
| `pnpm build`                     | Build every package                                        |
| `pnpm typecheck`                 | Type-check every package                                   |
| `pnpm test`                      | Run tests                                                  |
| `pnpm lint`                      | Biome lint and format check                                |
| `pnpm db:generate --name <name>` | Create a migration from `packages/server/src/db/schema.ts` |
| `pnpm db:migrate`                | Apply migrations                                           |

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
