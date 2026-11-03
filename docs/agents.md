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

| Tool                    | What it does                                                                                    | Scope          |
| ----------------------- | ----------------------------------------------------------------------------------------------- | -------------- |
| `describe_schema`       | The workspace's objects, fields, types, options and which fields are unique                     | `read`         |
| `list_templates`        | Templates and what each would add                                                               | `read`         |
| `apply_template`        | Apply a template to the workspace                                                               | `schema:write` |
| `query_records`         | Filter, sort and page the records of one object                                                 | `read`         |
| `get_record`            | One record by ID; merged IDs resolve to the surviving record                                    | `read`         |
| `search`                | Keyword search across records, facts and interactions                                           | `read`         |
| `get_context`           | A context pack for one record, fitted to a token budget                                         | `read`         |
| `upsert_record`         | Create a record, or update one found by `id` or a unique `match`                                | `write`        |
| `log_interaction`       | Log a meeting, call, email, message or note, and match its participants to records              | `write`        |
| `remember`              | Store a plain-language fact about a record, citing an interaction                               | `write`        |
| `propose_schema_change` | Add fields or objects (applied at once), or propose destructive changes for a person to approve | `schema:write` |

Validation errors name the field and the allowed values, so an agent can
correct its call and retry.

## How an agent should write

Retainer does not read conversations; the agent does. After a meeting, call or
email thread, a well-behaved agent:

1. **Logs the interaction** with `log_interaction`: kind, channel, time (with
   a UTC offset), title, its own short summary, the source's external ID, and
   the participants as emails, phones or record IDs. The response lists which
   participants matched a record and which did not.
2. **Updates records** with `upsert_record`, passing the interaction's ID as
   `source`. Cited values carry the interaction's date, so an old email can
   never overwrite a newer value.
3. **Stores facts** with `remember`, citing the same interaction and,
   optionally, a short quote.
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
- **Retries are safe.** Logging the same `(channel, externalId)` again with the
  same input returns the existing interaction with `created: false`. Writes are independent short transactions, so an agent
  that stops halfway leaves consistent data and can resume.
- **Reading back.** `get_context` gives the current values (with who wrote
  each), open tasks, current facts and recent interactions, within
  `tokenBudget` tokens (default 2000, at most 16000). `omitted` counts what
  did not fit.
- **Schema.** Additive changes (new objects, fields, options) apply at once.
  Renames, removals and new required or unique constraints requested by an
  agent are stored as proposals for a person to approve in the web app.

## Several agents in one workspace

Give each agent its own key. Every write is attributed to the agent that made
it; between agents the most recent observation wins, and the full history of
each field stays available through the REST API and the web app.
