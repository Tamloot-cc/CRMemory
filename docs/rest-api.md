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

| Status | Typical codes and meaning                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`: the body or a filter does not have the expected shape                                                                                                                           |
| 401    | Missing, unknown or revoked key                                                                                                                                                                    |
| 403    | The key lacks the scope, or the action needs a `user` actor                                                                                                                                        |
| 404    | Not found in this workspace (other workspaces' IDs are reported as not found too)                                                                                                                  |
| 409    | A conflict: a unique value another record holds, an erased handle, or something already decided or retracted                                                                                       |
| 412    | `stale_write`: the record changed since `expectedUpdatedAt`                                                                                                                                        |
| 422    | `invalid_values`: field values fail validation (`details.errors` lists each); `invalid_filter`; `invalid_aggregate` (`details.field`, `details.allowed`); `invalid_view`; `idempotency_key_reused` |
| 503    | The database is unreachable, or `not_configured`: `forget` without `RETAINER_SUPPRESSION_KEY`                                                                                                      |

`unique_conflict` and `suppressed` also list the field in `details.errors`,
in the same shape as `invalid_values`, so a client can show every per-field
error the same way.

## Pagination

List routes take `limit` and `cursor` and return `nextCursor`, which is `null`
on the last page. `GET /v1/review` pages each collection separately with
`pendingAssertionsCursor`, `unresolvedParticipantsCursor` and
`mergeSuggestionsCursor`, and returns `nextCursors` and `totals` for each.
`GET /v1/events/:id/claims` does the same for assertions and facts with
`assertionsCursor` and `factsCursor`.

## Idempotency

Creating a record, `remember` and merging accept an `Idempotency-Key` header
(1–200 characters). A retry with the same key and the same body returns the
original response; the same key with a different body fails with 422
`idempotency_key_reused`. Logging an event is idempotent through its
`(channel, externalId)` instead: logging it again with the same `type`,
`occurredAt`, title, summary and `fields` returns it with `created: false`
(status 200 instead of 201), after adding any participants and `about`
records it did not have yet (listed in `added`). Nothing is removed by
logging again; a different payload is a 409 `event_conflict`, and the
identity of a deleted or erased event is a 409 `event_retracted`.

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
| `GET` · `POST /v1/objects/:object/views`          | `read` · `write` | List the saved views the caller can see, or save one                 |
| `GET` · `PATCH` · `DELETE /v1/views/:id`          | `read` · `write` | Read, change or delete a saved view                                  |
| `GET /v1/records/:id`                             | `read`           | One record; `?include=provenance,relationReferences`                 |
| `PATCH /v1/records/:id`                           | `write`          | Update fields; optional `source` and `expectedUpdatedAt`             |
| `GET /v1/records/:id/delete-impact`               | `read`           | What a delete would take with it through cascades, counted by object |
| `POST /v1/records/delete-impact`                  | `read`           | The same for `{ "ids": [...] }` (at most 200) deleted together       |
| `DELETE /v1/records/:id`                          | `write`          | Soft-delete a record; for events, also retract what cites them       |
| `GET /v1/records/:id/assertions`                  | `read`           | Per-field history; `?field=`                                         |
| `GET /v1/records/:id/events`                      | `read`           | The record's event history, rollups included, with `via`; `?link=`   |
| `GET` · `POST /v1/records/:id/facts`              | `read` · `write` | List facts, or `remember` one                                        |
| `DELETE /v1/facts/:id`                            | `write`          | Retract a fact                                                       |
| `GET /v1/records/:id/context`                     | `read`           | Context pack; `?tokenBudget=` (default 2000, at most 16000)          |
| `GET /v1/records/:id/timeline`                    | `read`           | Events, field values and facts, newest first; filters, cursor        |
| `POST /v1/records/:id/merge`                      | `write`, user    | Merge `recordId` into this record                                    |
| `POST /v1/records/:id/forget`                     | `admin`, user    | Erase a person for a privacy request; not reversible                 |
| `POST /v1/events`                                 | `write`          | Log an event; returns matched and unmatched participants             |
| `POST /v1/events/query`                           | `read`           | Filter, sort and page events of every event type at once             |
| `GET` · `DELETE /v1/events/:id`                   | `read` · `write` | Read an event, or delete it and retract what cites it                |
| `POST /v1/events/:id/links`                       | `write`          | Add participants and `about` records; idempotent                     |
| `DELETE /v1/events/:id/participants/:pid`         | `write`, user    | Remove one participant                                               |
| `DELETE /v1/events/:id/about/:recordId`           | `write`, user    | Remove a record from the event's `about` list                        |
| `GET /v1/events/:id/claims`                       | `read`           | Assertions and facts citing an event                                 |
| `POST /v1/search`                                 | `read`           | Keyword search across records, events and facts                      |
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
With `"groupBy": "stage"` (a filterable single-select field) it also returns
`groups: [{ "value", "total", "values" }]`, one per value the matching
records hold, with `null` for records that have none.

A saved view is a named filter, sort and column set for one object, shown
as a `table`, a `board` (needs `groupBy`, a single-select field) or a
`calendar` (needs `dateField`, a date or date-time field):

```json
{
  "name": "Pipeline",
  "kind": "board",
  "groupBy": "stage",
  "filter": { "amount": { "gte": 10000000000 } },
  "sort": [{ "field": "closeDate", "direction": "asc" }],
  "columns": { "order": ["name", "amount"], "aggregates": { "amount": "sum" } },
  "hiddenGroups": ["lost"],
  "groupAggregate": { "field": "amount", "op": "sum" },
  "visibility": "workspace"
}
```

Fields are named as in the schema; the filter and sort are checked like a
query's, and a bad one fails with 422 `invalid_filter` or `invalid_view`.
`PATCH` changes only the keys sent, and `null` clears one. A `private` view
is visible only to the key's actor that created it (others get 404), and
only that actor can change `visibility` (403 otherwise). A view follows a
renamed field. A schema change that removes a field or option, or stops a
field being filterable, rewrites the views that named it; anything a read
still has to drop is named in the view's `issues`. Saved views are display settings: they never change
records, and moving a board card is a record `PATCH`.

Events are records of event types (`class: "event"` in `GET /v1/schema`):
`conversation` (meetings, calls, emails and chats, told apart by its
`medium` field), `note`, and any type the workspace adds. `channel` is
where an event came from (the source system or account) and is part of its
identity; `medium` is what kind of conversation it was, and can be corrected
later like any field.
They are logged with `POST /v1/events` and never created through
`POST /v1/objects/:object/records` (422 `use_log_event`), but an existing
event's fields can be corrected like any record's. Query them with
`POST /v1/objects/:object/query` on their type, which also filters and
sorts by the built-in `occurredAt`, `channel` and `externalId`, and takes
`linked`: the events attached to one record, as a participant, `about` it,
or through one of the event type's own relation fields, narrowed by `link`
(`participant`, `about` or `field`). Merged record IDs resolve to their
survivor. The notes `remember` creates for facts without a source are
internal and never listed.

```json
{
  "linked": { "record": "rec_5a1…", "link": "participant" },
  "filter": { "occurredAt": { "gte": "2026-10-01T00:00:00Z" } },
  "sort": [{ "field": "occurredAt", "direction": "desc" }]
}
```

`POST /v1/events/query` (also `POST /v1/objects/event/query`) takes the same
body and returns events of every event type in one page, newest first
unless `sort` says otherwise. Its filters and sorts take only what every
event type shares: `occurredAt`, `channel`, `externalId`, `id`, `createdAt`
and `updatedAt`. Filters also take `type` (event type API names, with
`eq`, `neq` or `in`); it is not a sort. `search` matches the events' searchable text, such as their title and
summary, and `linked` works as above; rollups are not included. A type's own
fields, such as `medium`, come back on each event but are filterable only
with that type's own query. Each event carries `type` beside its fields and
`event` details, and `include: ["relationReferences"]` adds labels for
relation values, participants and `about` records. Internal notes are
never listed.

```json
{
  "filter": { "type": { "in": ["conversation", "note"] }, "channel": "gmail" },
  "linked": { "record": "rec_5a1…" },
  "include": ["relationReferences"]
}
```
