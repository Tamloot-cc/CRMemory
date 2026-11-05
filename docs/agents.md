# Connecting agents

Agents use Retainer through MCP. The server hosts the MCP endpoint itself at
`/mcp` (Streamable HTTP); clients that only speak stdio use the
`@retainer/mcp` bridge. Either way the tools are the same, because they are
defined once, on the server.

Create one API key per agent (see [Self-hosting](self-hosting.md#workspaces-and-api-keys)),
with an `agent` actor. `read,write` is enough for most agents; add
`schema:write` if the agent may add fields or apply a template.

```sh
retainer key create --workspace acme --name "Inbox agent" \
  --actor agent:inbox --scopes read,write,schema:write
```

## Over HTTP

Point the client at `https://<your-host>/mcp` and send the key as a bearer
token. In Claude Code:

```sh
claude mcp add --transport http retainer https://retainer.example/mcp \
  --header "Authorization: Bearer rtn_…"
```

Any client that supports Streamable HTTP with custom headers works the same
way. The endpoint is stateless: each request is authenticated on its own.

## Over stdio

For clients that start MCP servers as local processes, run the bridge. It
reads two environment variables and relays MCP messages between stdin/stdout
and the server's `/mcp` endpoint:

| Variable           | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| `RETAINER_URL`     | The server's base URL, e.g. `https://retainer.example`. `/mcp` is added if missing. |
| `RETAINER_API_KEY` | The agent's API key.                                                                |

A client configuration in the common `mcpServers` format (Claude Desktop and
others):

```json
{
  "mcpServers": {
    "retainer": {
      "command": "npx",
      "args": ["-y", "@retainer/mcp"],
      "env": {
        "RETAINER_URL": "https://retainer.example",
        "RETAINER_API_KEY": "rtn_…"
      }
    }
  }
}
```

Or with Claude Code:

```sh
claude mcp add retainer \
  --env RETAINER_URL=https://retainer.example --env RETAINER_API_KEY=rtn_… \
  -- npx -y @retainer/mcp
```

From a checkout instead of npm (the only option until the first release is
published), build it (`pnpm build`) and use
`node /path/to/Retainer/packages/mcp/dist/index.js` as the command.

The bridge writes diagnostics to stderr only. If the server rejects the key or
cannot be reached, the client's request fails with a message saying which, for
example `Retainer at https://retainer.example rejected the API key (401).
Check RETAINER_API_KEY.` `retainer-mcp --help` prints its usage and
`--version` its version.

## Tools

Tools are generic, not one per object, so a workspace's custom objects never
change the tool list.

| Tool                    | What it does                                                                                        | Scope          |
| ----------------------- | --------------------------------------------------------------------------------------------------- | -------------- |
| `describe_schema`       | The workspace's objects (entities and event types) and fields, and the built-in facts               | `read`         |
| `list_templates`        | Templates and what each would add                                                                   | `read`         |
| `apply_template`        | Apply a template to the workspace                                                                   | `schema:write` |
| `get_guide`             | Step-by-step instructions for a rare task, e.g. `discover_schema`                                   | `read`         |
| `query_records`         | Filter, sort and page the records of one object; for an event type, the events linked to a record   | `read`         |
| `get_record`            | One record by ID; merged IDs resolve to the surviving record                                        | `read`         |
| `traverse_records`      | Walk from up to 20 records along an explicit path of relation fields and event links, with evidence | `read`         |
| `get_operation`         | What became of a write: completed, erased or not observed, by operation ID or idempotency key       | `read`         |
| `search`                | Keyword search across records, events and facts                                                     | `read`         |
| `get_context`           | A context pack for one record, fitted to a token budget                                             | `read`         |
| `get_timeline`          | A record's history: events, values asserted for its fields and facts, newest first                  | `read`         |
| `upsert_record`         | Create a record, or update one found by `id` or a unique `match`                                    | `write`        |
| `log_event`             | Log a meeting, call, email, message, note or other event, with who took part and what it is about   | `write`        |
| `remember`              | Store a plain-language fact about a record, citing an event                                         | `write`        |
| `propose_schema_change` | Add fields or objects (applied at once), or propose destructive changes for a person to approve     | `schema:write` |

Validation errors name the field and the allowed values, so an agent can
correct its call and retry.

## Setting up a new workspace

The `discover_schema` guide walks an agent through designing the workspace
from its user's own data. The agent works out the business from what it
already knows, finds the sources its own tools reach (an existing CRM,
spreadsheets, email, calendar), and reads the business's existing records
first. It asks its user only for what it cannot find. It samples those
sources and proposes a template plus the objects and fields the data calls
for, each with the evidence for it. Nothing is applied until the user
agrees.

An agent reads it with `get_guide`, and the server instructions tell it to
when `describe_schema` reports `initialized: false`. A person can also start
it as the MCP prompt `discover_schema`, with an optional `sources` argument
naming where to start; in Claude Code, with the server added as `retainer`,
that is `/mcp__retainer__discover_schema`. Applying the schema needs the
`schema:write` scope.

## Growing the schema

The `schema_design` guide holds the rules for changing a schema that is
already in use, and the server instructions point an agent to it before it
first adds an object. It also walks an agent through reviewing a schema in
use; a person can start that review as the MCP prompt `schema_design`.

## How an agent should write

Retainer does not read conversations; the agent does. After a meeting, call or
email thread, a well-behaved agent:

1. **Logs the event** with `log_event`: its type (`describe_schema` lists the
   event types), channel, time (with a UTC offset), title, its own short
   summary, the type's other fields, the source's external ID, the
   participants as emails, phones or record IDs, and in `about` the IDs of
   the records it concerns. The response lists which participants matched a
   record and which did not.
2. **Updates records** with `upsert_record`, passing the event's ID as
   `source`. Cited values carry the event's date, so an old email can never
   overwrite a newer value.
3. **Stores facts** with `remember`, citing the same event and, optionally,
   a short quote.
4. **Creates tasks** someone committed to, as `task` records.

Things worth knowing:

- **Finding the record.** `upsert_record` finds its record by `id` or by a
  unique field in `match` (for example `{ "emails": "dana@acme.com" }`).
  `ifMissing` defaults to `"fail"`, so "update Dana's address" can never
  create a second Dana; pass `"create"` to create when nothing matches. To
  find someone by name or phone, use `search` or `query_records` first.
- **Pending values.** Each field in a write comes back as `applied`,
  `pending_review` or `superseded`. An agent's value that would overwrite what
  a person entered waits for review; the agent should say so rather than claim
  the update is done.
- **Lists of records.** A `many_to_many` relation (for example a deal's
  `contacts`) takes the whole list of record IDs, and a write replaces it, so
  read the record first and send every member to keep; `[]` clears it. The
  other side of a relation (`readOnly`, `isInverse` in `describe_schema`) is
  written from its owning side. A relation with `targetObjects` takes records of any
  of those objects; find the records pointing at one by filtering on it.
- **Rolled-up events.** A relation with `rollUpEvents` (shown in
  `describe_schema`) also lists the events of the records pointing at a record
  in its history: a company sees the calls about its deals, with
  `via: { kind: "rollup", field, record }`. It is one hop and follows the
  relation's current value, so a reassigned deal takes its events with it.
  Still put the company in an event's `about` when the event is about the
  company itself.
- **Participants and `about`.** Participants are who took part. A meeting
  with Dana about the Acme pilot lists Dana as a participant and the Acme
  company and the pilot project in `about`:

  ```json
  { "type": "meeting", "channel": "calendar", "externalId": "evt-4410",
    "occurredAt": "2026-10-29T14:00:00+02:00", "title": "Acme pilot review",
    "participants": [{ "handle": "dana@acme.com", "role": "customer" }],
    "about": ["<acme company id>", "<pilot project id>"] }
  ```

  The meeting then shows in `get_context` and in `query_records` with
  `linked` for every record it is linked to. Don't list a company or project
  as a participant.
- **Retries are safe.** Logging the same `(channel, externalId)` again with the
  same type, time, title, summary and fields returns the existing event with
  `created: false`. Participants and `about` records it did not have yet are
  added and listed in `added`, so an agent that left the company out can log
  the same source again with it. Nothing is removed that way; a different
  payload is a conflict (`event_conflict`), and `event_retracted` means the
  source was deleted or erased: don't log it again. Writes are independent
  operations, so an agent that stops halfway leaves consistent data and can
  resume.
- **Keep your idempotency key.** `remember`, and `upsert_record` when it
  creates a record without `id` or `match`, take an `idempotencyKey`.
  Choose it and keep it before you send the write, for example from the
  source and what you are writing (`call-8812-legal-review`). Retrying with
  the same key within 24 hours returns the first result instead of writing
  twice; another key would write twice.
- **Unknown outcomes.** An `unknown_outcome` error means Retainer could not
  confirm whether the write was applied; it may have been. Don't assume
  either way: call `get_operation` with the `operationId` from the error,
  or with the `kind` (`remember`, `create_record`) and your
  `idempotencyKey`. `completed` returns the original result; `erased`
  means a privacy request erased it; `not_observed` means Retainer has no
  record of it yet, which is not a rollback. Retry only with the same
  idempotency key, which stays safe. A write by `id` or `match`, and
  logging an event with its `externalId`, is already safe to retry.
- **Busy workspaces.** Writes to one workspace run one at a time. An error
  with `retryable: true` in its details (`workspace_busy`, `schema_busy`,
  `write_conflict`, `workspace_upgrading`) can be sent again unchanged after
  a short wait.
- **Events over time.** `query_records` on an event type lists its events by
  `occurredAt`, `channel` or a field, and with `linked: { record }` only
  those attached to one record, e.g. calls with a company this quarter.
- **Your own event types.** Something else that happens and is logged from
  a source, such as a payment or a site visit, can be an event type:
  `propose_schema_change` with `create_object` and `class: "event"`. It gets
  a title and summary of its own; add only the fields it needs.
- **Connections.** `traverse_records` follows an explicit path from up to
  20 start records, at most 3 steps: relation fields (`{ field, direction }`)
  and event links (`{ link: "participant" | "about", direction }`). For
  example, people who met a deal's decision-maker: start at the deal, then
  `{ field: "decisionMaker" }`, `{ link: "participant", direction: "in" }`
  (the events that person took part in) and
  `{ link: "participant", direction: "out" }` (who else was there). Each
  hop comes with its evidence (an assertion or an event). It reads at most
  500 edges and returns at most 50 paths; when `truncated` is set, the
  result is incomplete, so narrow the starts or the path rather than claim
  there is no connection. Pick start records with `query_records` first.
- **Reading back.** `get_context` gives the current values (with who wrote
  each), open tasks, current facts and recent events, rolled-up ones
  included (each saying how it is attached, `via`), within
  `tokenBudget` tokens (default 2000, at most 16000). `omitted` counts what
  did not fit.
- **History.** `get_timeline` lists how a record got here: its events, every
  value asserted for its fields (`current` says whether it is the value now;
  one that is not may never have been) and its facts, newest first. Narrow it
  with `fields` (e.g. `["stage"]`), `eventTypes`, `types` and a `from`/`to`
  range, and pass `nextCursor` back with the same filters for the next page.
- **Schema.** Additive changes (new objects, fields, options) apply at once.
  Renames, removals and new required or unique constraints requested by an
  agent are stored as proposals for a person to approve in the web app.

## Several agents in one workspace

Give each agent its own key. Every write is attributed to the agent that made
it; between agents the most recent observation wins, and the full history of
each field stays available through the REST API and the web app.
