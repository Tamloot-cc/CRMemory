# REST API

Everything an agent can do over MCP, and the review operations people use, is
available over REST under `/v1`. The [TypeScript SDK](sdk.md) wraps every
route.

## Authentication

Send an API key as a bearer token:

```sh
curl https://retainer.example/v1/me -H "Authorization: Bearer rtn_…"
```

The key decides the workspace and the actor every write is attributed to.
Nothing in a request body can change either. See
[Self-hosting](self-hosting.md#workspaces-and-api-keys) for scopes and actor
types.

The web app authenticates with a session cookie instead (`POST` and
`DELETE /auth/session`). Cookie-authenticated writes must send
`X-Retainer-Client: web` and come from the configured origin. A bearer header
always wins over a cookie.

## Errors

Errors are JSON with a stable `code`, a readable `message`, and sometimes
`details` naming the field and the allowed values:

```json
{ "error": { "code": "stale_write", "message": "the record changed since expectedUpdatedAt", "details": { … } } }
```

| Status | Typical codes and meaning                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`: the body or a filter does not have the expected shape                                                                                                           |
| 401    | Missing, unknown or revoked key                                                                                                                                                    |
| 403    | The key lacks the scope, or the action needs a `user` actor                                                                                                                        |
| 404    | Not found in this workspace (other workspaces' IDs are reported as not found too)                                                                                                  |
| 409    | A conflict: a unique value another record holds, an erased handle, or something already decided or retracted                                                                       |
| 412    | `stale_write`: the record changed since `expectedUpdatedAt`                                                                                                                        |
| 422    | `invalid_values`: field values fail validation (`details.errors` lists each); `invalid_filter`; `invalid_aggregate` (`details.field`, `details.allowed`); `idempotency_key_reused` |
| 503    | The database is unreachable, or `not_configured`: `forget` without `RETAINER_SUPPRESSION_KEY`                                                                                      |

`unique_conflict` and `suppressed` also list the field in `details.errors`,
in the same shape as `invalid_values`, so a client can show every per-field
error the same way.

## Pagination

List routes take `limit` and `cursor` and return `nextCursor`, which is `null`
on the last page. `GET /v1/review` pages each collection separately with
`pendingAssertionsCursor`, `unresolvedParticipantsCursor` and
`mergeSuggestionsCursor`, and returns `nextCursors` and `totals` for each.
`GET /v1/interactions/:id/claims` does the same for assertions and facts with
`assertionsCursor` and `factsCursor`.

## Idempotency

Creating a record, `remember` and merging accept an `Idempotency-Key` header
(1–200 characters). A retry with the same key and the same body returns the
original response; the same key with a different body fails with 422
`idempotency_key_reused`. Logging an interaction is idempotent through its
`(channel, externalId)` instead: logging it again with the same kind,
`occurredAt`, title and summary returns it with `created: false`, after
adding any participants and `about` records it did not have yet (listed in
`added`). Nothing is removed by logging again; a different kind, time, title
or summary is a 409 `interaction_conflict`.

## Routes

| Route                                             | Scope            | Purpose                                                              |
| ------------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `GET /health`                                     | none             | Server version and database status (503 when the database is down)   |
| `GET /v1/me`                                      | any              | The caller's workspace, actor and scopes                             |
| `GET /v1/schema`                                  | `read`           | The workspace schema                                                 |
| `POST /v1/schema/changes`                         | `schema:write`   | Request a schema change (applied, or proposed for approval)          |
| `GET /v1/schema/changes` · `/:id`                 | `read`           | Change history, or one change                                        |
| `POST /v1/schema/changes/:id/approve` · `/reject` | `admin`, user    | Decide a proposed change                                             |
| `GET /v1/templates`                               | `read`           | Templates and what each adds                                         |
| `POST /v1/templates/:name/apply`                  | `schema:write`   | Apply a template                                                     |
| `POST /v1/objects/:object/records`                | `write`          | Create a record                                                      |
| `POST /v1/objects/:object/upsert`                 | `write`          | Update or create a record found by `id` or `match`, with `ifMissing` |
| `POST /v1/objects/:object/query`                  | `read`           | Filter, sort and page records of one object                          |
| `POST /v1/objects/:object/aggregate`              | `read`           | Count, and per-field totals over, the records a filter matches       |
| `GET /v1/records/:id`                             | `read`           | One record; `?include=provenance,relationReferences`                 |
| `PATCH /v1/records/:id`                           | `write`          | Update fields; optional `source` and `expectedUpdatedAt`             |
| `GET /v1/records/:id/delete-impact`               | `read`           | What a delete would take with it through cascades, counted by object |
| `POST /v1/records/delete-impact`                  | `read`           | The same for `{ "ids": [...] }` (at most 200) deleted together       |
| `DELETE /v1/records/:id`                          | `write`          | Soft-delete a record                                                 |
| `GET /v1/records/:id/assertions`                  | `read`           | Per-field history; `?field=`                                         |
| `GET /v1/records/:id/interactions`                | `read`           | Interactions the record took part in or that are about it            |
| `GET` · `POST /v1/records/:id/facts`              | `read` · `write` | List facts, or `remember` one                                        |
| `DELETE /v1/facts/:id`                            | `write`          | Retract a fact                                                       |
| `GET /v1/records/:id/context`                     | `read`           | Context pack; `?tokenBudget=` (default 2000, at most 16000)          |
| `POST /v1/records/:id/merge`                      | `write`, user    | Merge `recordId` into this record                                    |
| `POST /v1/records/:id/forget`                     | `admin`, user    | Erase a person for a privacy request; not reversible                 |
| `POST /v1/interactions`                           | `write`          | Log an interaction; returns matched and unmatched participants       |
| `POST /v1/interactions/query`                     | `read`           | Filter, count and page interactions by kind, channel, time or record |
| `GET` · `DELETE /v1/interactions/:id`             | `read` · `write` | Read or retract an interaction                                       |
| `POST /v1/interactions/:id/participants`          | `write`          | Add participants and `about` records; idempotent                     |
| `DELETE /v1/interactions/:id/participants/:pid`   | `write`, user    | Remove one participant                                               |
| `DELETE /v1/interactions/:id/about/:recordId`     | `write`, user    | Remove a record from the interaction's `about` list                  |
| `GET /v1/interactions/:id/claims`                 | `read`           | Assertions and facts citing an interaction                           |
| `POST /v1/search`                                 | `read`           | Keyword search across records, facts and interactions                |
| `GET /v1/review`                                  | `read`           | Pending values, merge suggestions, unresolved participants           |
| `GET /v1/assertions/:id`                          | `read`           | One assertion with its review state                                  |
| `POST /v1/assertions/:id/accept` · `/reject`      | `write`, user    | Decide a pending value                                               |
| `POST /v1/review/merges/:id/dismiss`              | `write`, user    | Dismiss a merge suggestion                                           |

"user" means the key's actor must be a `user`; agents get 403 even with the
scope. Request and response shapes are exported as TypeScript types from
`@retainer/shared`, and [ARCHITECTURE.md section 6](../ARCHITECTURE.md#6-interfaces)
shows annotated examples.

`POST /v1/objects/:object/aggregate` takes the same `filter` and `search` as
a query, plus `aggregates: [{ "field": "amount", "op": "sum" }]` (at most 50),
and returns `{ "total": 42, "values": [{ "field", "op", "value" }] }`. The
operations are `countEmpty`, `countNotEmpty`, `percentEmpty`,
`percentNotEmpty`, `countUnique`, `sum`, `avg`, `min` and `max`;
`aggregateOps(field)` in `@retainer/shared` says which a field supports.
Money totals are `{ amountMicros, currency }`, or `null` with
`"mixedCurrencies": true` when the matching records use several currencies.

`POST /v1/interactions/query` reads the interaction log, which is not a
record object. Its `filter` takes `kind` and `channel` (one value or a
list), `externalId`, an `occurredAt` range (`gt`, `gte`, `lt`, `lte`), and
`record`: interactions linked to that record, narrowed by `link`
(`participant` or `about`). `order` is `newest` (default) or `oldest`, and
`countBy: "kind" | "channel"` adds counts over every match. It returns
`{ items, nextCursor, total, counts? }`; `limit: 0` returns only the totals.
Retracted interactions and the notes `remember` creates are left out.

```json
{
  "filter": {
    "record": "rec_5a1…",
    "kind": "call",
    "occurredAt": { "gte": "2026-10-01T00:00:00Z" }
  },
  "countBy": "kind",
  "limit": 0
}
```
