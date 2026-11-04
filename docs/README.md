# Retainer documentation

Retainer is open-source memory for AI agents that work with customer
relationships. Agents read conversations with their own models and write what
matters: typed fields, plain-language facts and a log of interactions, each
linked to who wrote it and where it came from. Retainer validates, stores,
resolves conflicts and searches. It never calls a language model.

| Guide                                       | For                                                             |
| ------------------------------------------- | --------------------------------------------------------------- |
| [Self-hosting](self-hosting.md)             | Running the server, workspaces and API keys, configuration      |
| [Deploying to AWS](aws.md)                  | Lambda, API Gateway and RDS with Terraform, instead of Docker   |
| [Connecting agents](agents.md)              | MCP over HTTP or stdio, the tools, how an agent should write    |
| [TypeScript SDK](sdk.md)                    | `@retainer/sdk`: calling the REST API from your own code        |
| [REST API](rest-api.md)                     | Authentication, errors, pagination, idempotency and every route |
| [Releasing](releasing.md)                   | How maintainers cut a release                                   |
| [Retainer and Twenty](twenty-comparison.md) | How Retainer's schema differs from Twenty's CRM schema          |
| [Schema expressiveness coverage](schema-expressiveness-coverage.md) | Direct structural coverage and required remodeling across ten CRMs, plus Affinity |
| [PostgreSQL and SurrealDB](postgres-surrealdb-evaluation.md) | Database tradeoffs and a proposed experiment for an agent-first CRM |
| [Event types and record history](event-types-and-history-spec.md) | Proposed spec: interactions as event types, rollups, timelines and implementation order |
| [Schema, events and history: merged spec](schema-events-and-history-spec.md) | Consolidated proposal: event records, native collection/polymorphic relations, rollups, history and phased delivery |

The design, the data model and the write rules are in
[ARCHITECTURE.md](../ARCHITECTURE.md); the web app's design is in
[FRONTEND.md](../FRONTEND.md).

## Concepts in one minute

- **Workspace**: one tenant. Every API key belongs to exactly one workspace,
  so agents never name a workspace in their calls.
- **Objects and fields**: the schema is data. A workspace starts from a
  template (`sales`, `services`, `clinic`, `real_estate`, `recruiting`,
  `blank`) and agents can propose new fields and objects at runtime.
- **Records** hold typed field values. Each value is the winner among
  _assertions_ from agents and people: people outrank agents, newer
  observations outrank older ones, and an agent that would overwrite a
  person's value leaves a pending assertion for review instead.
- **Interactions** are meetings, calls, emails, messages and notes. Agents log
  them first, then cite them as the `source` of what they write.
- **Facts** are plain-language statements about a record (`remember`), each
  citing the interaction it came from.
- **Actors**: every write is attributed to the actor of the API key that made
  it (`user`, `agent`, `integration` or `system`), never to anything in the
  request body.
