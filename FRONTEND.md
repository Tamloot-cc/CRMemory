# Retainer web app

Status: web steps 1–4 are implemented and verified locally. Server build
step 5 has landed (merge, dismiss and `forget` routes; merge suggestions in
`GET /v1/review`), but web step 5 and the product questions in section 13
remain deferred. Read
`ARCHITECTURE.md` first; this document uses its section numbers.

Retainer is used by agents through REST and MCP. The web app is for the
people those agents work for. It does the jobs only a person can do and lets
them see what the agents remembered and why. It is not a CRM front end:
no pipelines, dashboards, email sync or agent chat.

---

## 1. Decisions

| Decision      | Choice                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Package       | `packages/web`, published as `@retainer/web`, **MIT**                                                                             |
| Data source   | `@retainer/sdk` over the REST API only. Never imports `packages/server`                                                           |
| Data model    | Every list, form and filter is built at runtime from `GET /v1/schema`; nothing is written per object                              |
| UI kit        | shadcn/ui on Tailwind CSS 4, React 19                                                                                             |
| App shape     | Single-page app built with Vite; TanStack Router for routes, TanStack Query for server state                                      |
| Hosting       | Static files served by the Retainer server at `/app`, same origin as the API, so the image stays one process and there is no CORS |
| Auth          | A person signs in with their own `user`-actor API key; the server turns it into an httpOnly cookie (4)                            |
| Twenty        | A behaviour reference only. No Twenty code is copied or translated (2)                                                            |
| First screens | Retainer's own: the review inbox, then records with provenance, facts and interactions                                            |

### Why a single-page app and not Next.js

Retainer has no use for server rendering: every screen is behind sign-in and
reads a JSON API. A Next.js server would be a second runtime to deploy next to
the Retainer image and a second place for the API key to live. A static build
served by the existing Hono server keeps self-hosting at one container.

---

## 2. Licensing rules

`packages/web` is MIT, like `shared`, `sdk` and `mcp`.

- **No server code.** `packages/web` depends only on `@retainer/shared`,
  `@retainer/sdk` and third-party packages. Types the UI needs from a
  response (the review queue, a presented record) move to `@retainer/shared`
  or the SDK; they are never imported from `packages/server`.
- **No Twenty code.** `twenty-front` is AGPL-3.0, and Twenty's application
  exception covers apps that call its APIs, not code taken from it. People
  may read Twenty to learn how a field type behaves (what an emails input
  does with additional values, how a relation picker searches). They must
  not paste, port or translate its files, and no file in `packages/web` may
  be written with a Twenty file open as the template. Section 6 names what
  to read for each type.
- **MIT sources may be copied** with their notice kept: shadcn/ui, and Comp
  AI CRM's `packages/ui` (`github.com/trycompai/crm`, MIT). Copied files keep
  a header naming the origin, and `packages/web/THIRD_PARTY.md` lists them
  with the upstream license text.
- Serving the built files from the AGPL server is aggregation; it does not
  change either license.

---

## 3. Package layout

```
packages/web/
  index.html
  vite.config.ts
  THIRD_PARTY.md
  src/
    main.tsx            router, query client, theme
    api/                SDK client, query keys, hooks per route
    auth/               sign-in, session, scope checks
    schema/             schema cache, object and field lookups
    fields/             one folder per field type (6)
    provenance/         actor badges, sourced values, assertion history
    routes/             one file per screen (5)
    ui/                 shadcn components: the only source of UI (8)
```

The Vite dev server proxies `/v1`, `/auth` and `/health` to `pnpm dev`, so
development is same-origin too.

---

## 4. Sign-in and permissions

### 4.1 Who a person is

Retainer knows callers only by API key (7). Each person gets their own key
from the operator CLI, with a `user` actor:

```sh
retainer key create --workspace acme --name "Maayan (web)" \
  --actor user:maayan --scopes read,write,admin
```

A shared key for several people is not supported: writes, accepted
assertions and approvals must name the person who made them (rule 2.3).

### 4.2 Session cookie (new server routes)

| Route                  | Does                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/session`   | Takes `{ key }`, checks it through `retainer_lookup_api_key`, sets the cookie and returns the same body as `GET /v1/me` |
| `DELETE /auth/session` | Clears the cookie                                                                                                       |
| `GET /v1/me`           | The caller's workspace (`id`, `name`, `slug`), actor and scopes. Works with a bearer key or the cookie                  |

- The cookie is `retainer_session`, `HttpOnly`, `Secure` (except on
  localhost), `SameSite=Strict`, `Path=/`, 30-day `Max-Age`. Its value is the
  key itself: the authentication middleware already looks a key up on every
  request, so revoking the key ends the session at once and no session table
  is needed.
- `authenticate` accepts the bearer header or the cookie. When both are
  present, the header wins.
- Cookie-authenticated `POST`, `PATCH` and `DELETE` requests must carry
  `X-Retainer-Client: web`, or they get `403 csrf`. Bearer requests are
  unaffected.
- The key is typed once on the sign-in screen and sent to `POST /auth/session`.
  The app never stores it in `localStorage`, `sessionStorage` or memory after
  that call.
- The hosted cloud may sign people in through its own identity provider and
  set the same cookie with a key it issues. That lives outside this
  repository (7).

For TLS termination at a reverse proxy, set `RETAINER_PUBLIC_ORIGIN` to the
external origin (for example `https://retainer.example`). CSRF checks compare
the browser Origin to this configured value; forwarded headers are not trusted.
The setting also controls the cookie's public host and Secure handling.

### 4.3 What the UI shows by scope

The server enforces scopes. `admin` implies `read`, `write` and
`schema:write`; UI checks use these effective scopes. The web app additionally
restricts every mutation to a `user` actor. This UI restriction does not change
which actors the REST and MCP APIs allow to edit or retract data.

| Action                                                                       | Needs                             |
| ---------------------------------------------------------------------------- | --------------------------------- |
| Browse records, facts, interactions                                          | `read`                            |
| Edit fields, retract facts and interactions, accept or reject pending values | `write` and a `user` actor        |
| Approve or reject schema changes                                             | `admin` and a `user` actor        |
| Apply a template                                                             | `schema:write` and a `user` actor |
| `forget` (conditional step 5)                                                | `admin` and a `user` actor        |

A key with a non-`user` actor can sign in read-only, with a banner saying
why actions are missing.

---

## 5. Screens

URLs hold all list state (filters, sort, cursor, open tab), so a copied
address reproduces the view.

### 5.1 Sign in — `/app/sign-in`

One field for the key, one button. Errors from `POST /auth/session` are shown
as the server words them.

### 5.2 Review inbox — `/app` (home)

The first screen built and the default after sign-in. Source: `GET /v1/review`
and `GET /v1/schema/changes?status=proposed`.

Tabs, each with a total count from the server, independent of the loaded
page. Each tab has its own cursor and a Load more control (9.1); no tab may
silently truncate outstanding items. Counts and pages reflect live data and
are refreshed after decisions. A record links to a review item using its
assertion ID in the URL; the inbox fetches that item directly even when it
is outside the loaded page.

Tabs:

1. **Pending values.** One row per pending assertion: record label and
   object, field label, **current value → proposed value** rendered with the
   field type's display (6), who proposed it (actor badge, 7), the reason in
   plain words, confidence, `observedAt`, and the source interaction's title
   and date with a link to it (5.6).

   | `reason`          | Shown as                                                           |
   | ----------------- | ------------------------------------------------------------------ |
   | `outranked`       | "Newer than a value a person or integration set"                   |
   | `low_confidence`  | "Below the workspace's confidence threshold"                       |
   | `unique_conflict` | "Another record already has this value" with a link to that record |

   Accept and Reject per row (`POST /v1/assertions/:id/accept` · `/reject`),
   and for a selection of rows. Accepting writes as the signed-in person
   (rule 2.3), preserving the original `observedAt` and source. Acceptance
   does not promise that the proposed value becomes current: inspect the
   returned per-field outcome and record. If a newer human value still wins,
   show "Accepted; a newer value remains current" and the current value.
   A unique conflict leaves the item pending and shows the conflicting record
   when available. A `409 not_pending` removes the row with a note that it is
   no longer pending. Deleted sources, deleted fields, merged records and
   values that no longer validate show the server error and refresh the item;
   they must not be presented as successful decisions.

   Bulk review calls the existing single-item routes with bounded concurrency.
   Results are independent, not atomic: report success or failure per item,
   keep failed pending items selected, and retry only failures. Never replay
   successful decisions automatically.

2. **Schema changes.** Proposed changes with their operations listed in
   words ("Add field _Renewal date_ (date) to _Company_"), the proposing
   actor and time. Approve and Reject for `admin` keys
   (`POST /v1/schema/changes/:id/approve` · `/reject`). Approving refreshes
   the cached schema (6.3).

3. **Unresolved participants.** Handles from logged interactions that match
   only a deleted record (1.2). Read-only in v1, with links to the
   interaction.

4. **Suggested merges.** Shown when build step 5 lands: the two records side
   by side, field by field, with a Merge button (`POST /v1/records/:id/merge`).

### 5.3 Object list — `/app/o/:object`

One route for every object. Source: `POST /v1/objects/:object/query`.

- A full-width, spreadsheet-style grid with a sticky header and a sticky
  label column.
- Columns come from the object's fields in schema order. The label field is
  first and pinned. Inverse relations and `json` fields are hidden by
  default. The column menu shows, hides and reorders the rest; headers can
  also be dragged to reorder and their edges dragged (or arrow-keyed) to
  resize. Order and widths are saved per object in `localStorage`
  (`retainer:columns:v2:…`, migrating the v1 visible-columns list).
- Filters are offered for `isFilterable` fields only, with the operators
  each type supports (6). Each active filter is a removable chip in the
  toolbar; several chips are ANDed. The URL filter is read as one flat AND:
  parts the chips can't express (`or`, `not`) show as "Custom filter" chips
  and stay in place while other chips are added, replaced or removed.
- Click a sortable header to sort ascending, descending, then off. The Sort
  menu also offers Updated and Created.
- Cursor pagination with `limit` 50. A footer shows the row range and
  Previous/Next; Previous is remembered for pages reached in this visit,
  otherwise it returns to the first page.
- Clicking a row, or its label link, opens the record in a side sheet that
  slides in over the list (5.4 content). The open record is the `record`
  search parameter, so Back closes the sheet and a copied address reopens
  it; the row stays highlighted. The sheet is non-modal: clicking another
  row swaps the record without closing it. Escape or the close button
  closes it, and "Open full page" goes to `/app/r/:id`. Its memory tab and
  page are local to the sheet, since the list owns `cursor`.

### 5.3a Shell

- A left sidebar: workspace, Find anything (⌘K), Review inbox with its
  pending count, every object from the schema (standard ones first, with an
  icon), Schema, and the signed-in actor with Sign out.
- It collapses to an icon rail with its toggle or ⌘\, remembered in
  `localStorage`. Below `md` it is a drawer opened from the top bar.
- Every screen has a slim top bar with a breadcrumb and the screen's
  actions. Record lists fill the width; other screens use a readable
  centred column.

### 5.4 Record — `/app/r/:id`

Source: `GET /v1/records/:id`, its provenance (9.1), facts and interactions.
An ID that was merged loads the surviving record and says so.

Three areas:

- **Fields.** Every field with its type's display. Each value carries its
  provenance (7): who wrote it, when it was observed, and the source
  interaction. A field with a pending assertion shows a marker that links to
  that row in the review inbox. Clicking a field's value (or its Edit
  button) edits it in place with the type's input, here and in the list's
  side sheet; Enter or Save writes and Escape cancels (inside the sheet,
  Escape cancels the edit before it closes the sheet). Saving sends
  `PATCH /v1/records/:id` with the record's
  `updatedAt` as `expectedUpdatedAt` (rule 2.5). A `412 stale_write` shows
  the new value instead of overwriting it, preserving the unsaved draft so
  the person can compare, discard it, or explicitly retry against the latest
  version. A history button opens every
  assertion for that field, including superseded, rejected and retracted
  ones, newest first.
- **Relations.** Many-to-one fields render as a link to the target. Each
  inverse (one-to-many) field renders as a short list of linked records with
  a link to the filtered object list.
- **Memory tabs.**
  - _Facts_: `GET /v1/records/:id/facts`. Content, `validFrom`, writer, and
    each source with its quote. Retract (`DELETE /v1/facts/:id`) asks for
    confirmation.
  - _Interactions_: newest first (9.1). Kind icon, title, date, summary,
    and participants, matched ones linked.
  - _Tasks_: open tasks linked to the record, from the standard `task`
    object.

### 5.5 Search — `⌘K`

Available once build step 4 ships `POST /v1/search`. Results grouped by
object, then facts and interactions. Before that, `⌘K` jumps between
objects and searches the current list only.

### 5.6 Interaction — `/app/i/:id`

Source: `GET /v1/interactions/:id`. Kind, channel, time, title, summary,
participants (matched and unmatched with the reason), and everything that
cites it: field assertions and facts (9.1). Retract
(`DELETE /v1/interactions/:id`) shows the server's counts afterwards:
retracted assertions, recomputed records and hidden facts.

### 5.7 Schema — `/app/schema`

Read-only in v1. Objects and their fields with type, flags and owner
(`system`, `workspace`, `agent`), and the change history from
`GET /v1/schema/changes`. Agents change the schema; people approve (5.2).
A workspace with no template applied shows the template list
(`GET /v1/templates`) and an Apply button for `schema:write` keys.

### Not in v1

Creating or editing objects and fields in the UI, kanban and pipeline views,
dashboards, workspace and key management (operator CLI only, 7.1), several workspaces per session,
and `forget` (until build step 5). Record creation and the release boundary
for step 5 remain explicit open decisions (13); no label-only creation flow
is specified by this document.

---

## 6. Field types

### 6.1 One module per type

`src/fields/<type>/` exports:

| Export    | Does                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `Display` | Read-only rendering for a table cell (`compact`) and the record page (`full`)         |
| `Input`   | Editing control; produces a value that passes the type's schema in `@retainer/shared` |
| `Filter`  | The operators offered in the list filter bar for `isFilterable` fields                |
| `isEmpty` | Whether a value counts as empty for display                                           |

A registry maps every `FieldType` in `@retainer/shared` to its module, and a
unit test fails when a type has no module. Before implementing inputs,
extract the server's pure field-aware validation and normalization into
`@retainer/shared` (9.3). Both server and UI use it; the existing composite
Zod shapes alone are not equivalent to server validation. Local validation
covers value shape and field settings. The server remains authoritative for
uniqueness, relation targets, scopes, concurrency and other database checks.

### 6.2 Behaviour per type

The last column is where to read how Twenty behaves (2). Paths are under
`packages/twenty-front/src/modules/`.

| Type           | Display                                                  | Input                                                                   | Twenty reference                              |
| -------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `text`         | Single line, full text on hover                          | Text field                                                              | `ui/field/display/components/TextDisplay`     |
| `number`       | Locale formatting                                        | Numeric field                                                           | `NumberFieldInput`                            |
| `boolean`      | Check or dash                                            | Switch                                                                  | `BooleanDisplay`                              |
| `date`         | Date in the viewer's locale                              | Date picker                                                             | `DateDisplay`                                 |
| `date_time`    | Date and time in the viewer's time zone, ISO on hover    | Date and time picker                                                    | `DateTimeDisplay`                             |
| `select`       | Option label as a badge                                  | Combobox of `settings.options`                                          | `SelectDisplay`, `SelectFieldInput`           |
| `multi_select` | Badges, overflow as "+n"                                 | Multi-select combobox                                                   | `MultiSelectDisplay`, `MultiSelectFieldInput` |
| `money`        | Amount from `amountMicros` with `currency`               | Amount plus currency picker; converts to micros without floats          | `CurrencyDisplay`, `CurrencyFieldInput`       |
| `emails`       | Primary, "+n" for additional                             | List editor: add, remove, set primary; at most `settings.maxValues`     | `EmailsDisplay`, `EmailsFieldInput`           |
| `phones`       | Primary with country, "+n"                               | List editor with country code                                           | `PhonesDisplay`, `PhonesFieldInput`           |
| `links`        | Primary label or host, "+n"                              | List editor of URL and label                                            | `LinksDisplay`, `LinksFieldInput`             |
| `full_name`    | "First Last"                                             | Two fields                                                              | `FullNameFieldInput`                          |
| `address`      | One line: city, country; full address on the record page | Grouped fields; `lat`/`lng` shown, not edited                           | `AddressFieldInput`                           |
| `relation`     | Target record's label as a link                          | Record picker searching the target object; inverse fields are read-only | `RelationManyToOneFieldInput`                 |
| `json`         | Collapsed preview, formatted on the record page          | Read-only in v1                                                         | `JsonDisplay`                                 |

Composite values are replaced whole (rule 2.2), so list editors send the
complete value, not a diff.

### 6.3 Schema cache

`GET /v1/schema` returns `workspace.schemaVersion`. The schema is cached in
TanStack Query under `[workspaceId, 'schema', schemaVersion]` and re-read on
window focus and after any schema approval. A `404` for an object or field
that the cached schema still has triggers one refetch before showing an
error.

### 6.4 Mutation and session cache rules

All workspace queries include `workspaceId` in their keys. On logout, an
expired or revoked session, or replacement of the signed-in identity, cancel
in-flight queries and clear cached data before rendering another session.
Responses from the previous session must not repopulate the new cache.
Column preferences use workspace and object identifiers in their storage keys.

After a mutation completes, invalidate the affected queries:

| Mutation                                                   | Refresh                                                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Record edit                                                | Record, object lists, field provenance/history, review pages and totals                                                     |
| Assertion accept or reject, including partial bulk results | Review pages/totals and affected records, lists, provenance/history and interaction claims                                  |
| Schema approval or template application                    | Schema, schema changes, review totals, and record/list queries built from the old schema                                    |
| Fact retraction                                            | Record facts and the cited interactions' claims                                                                             |
| Interaction retraction                                     | Interaction and claims, affected records and their lists, provenance/history, facts, interaction lists, review pages/totals |

If the response does not identify all affected queries, invalidate the broader
workspace query group. On `412`, refetch the record before offering an explicit
retry. Refetch active data on window focus to pick up agent and reviewer writes
from other clients; mutation responses are not a substitute for fresh reads.

---

## 7. Provenance

Provenance is what sets this app apart, so every value shows it the same
way.

- **Actor badge.** The four actor types (`user`, `integration`, `agent`,
  `system`) each get a fixed icon and label, with the actor's `name` (or
  `id`) next to it.
- **Sourced value.** A value written by anyone other than the viewer has a
  dotted underline. Hovering or focusing it shows: who wrote it, when it was
  observed, the source interaction's title and date, and the quote when
  there is one. This follows Comp AI's `SourcedValue` and `Provenance`
  components, which may be copied (2).
- **Pending marker.** A field with a pending assertion shows a small badge
  with the proposed value on hover and a link to review it.
- **History.** Opened per field (5.4): every assertion with status, actor,
  `observedAt`, source and, for reviewed ones, who decided.

---

## 8. Design rules

Taken from Comp AI CRM's `docs/design.md`, which works well for a tool like
this:

- `src/ui` is the only source of UI. Screens compose its components and do
  not pass styling `className`s; a new look is a new variant in `src/ui`.
- Only two things are filled: `primary` for the action you want and
  `destructive` for the one you cannot undo. Everything else is outline or
  ghost.
- One brand colour, the same value in light and dark. Neutral greys.
- Radius from the scale only: `rounded-sm` for small controls, `rounded-md`
  for buttons and inputs, `rounded-lg` for popovers, dialogs and table
  shells.
- Light and dark themes from the start, following the system setting.
- Keyboard first on the review inbox: `j`/`k` to move, `a` to accept,
  `r` to reject, `x` to select.

---

## 9. Server and SDK work this needs

### 9.1 New or changed routes (AGPL server)

| Route                                           | Purpose                                                                                                                         | Needed by |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `POST` · `DELETE /auth/session`                 | Cookie sign-in (4.2)                                                                                                            | 5.1       |
| `GET /v1/me`                                    | Workspace, actor and scopes of the caller                                                                                       | 4.3       |
| Cookie in `authenticate`, CSRF header check     | 4.2                                                                                                                             | all       |
| Static files at `/app`                          | Serves `packages/web/dist` when `RETAINER_WEB_DIR` is set; the Docker image sets it. Unknown `/app/*` paths return `index.html` | all       |
| `GET /v1/records/:id/assertions`                | Every assertion for the record, optionally by `field`, with status, actor, `observedAt`, source and reviewer                    | 5.4, 7    |
| `GET /v1/records/:id/interactions`              | Interactions the record took part in, newest first, cursor-paginated                                                            | 5.4       |
| `GET /v1/interactions/:id/claims`               | Assertions and facts that cite the interaction                                                                                  | 5.6       |
| Per-field provenance on `GET /v1/records/:id`   | With `?include=provenance`, each field's winning assertion: actor, `observedAt`, source, and whether a pending assertion exists | 5.4, 7    |
| Review and schema-change pagination             | Add the contracts below to the existing list routes                                                                             | 5.2, 5.7  |
| `GET /v1/assertions/:id`                        | Fetch an assertion directly for review deep links, including its current status                                                 | 5.2, 5.4  |
| Review enrichment                               | Source interaction summary and current conflicting record reference, as below                                                   | 5.2       |
| Relation references on record reads and queries | Optional resolved labels alongside existing relation ID values, as below                                                        | 5.3, 5.4  |

The v1 read contracts are:

- **Review pages.** Preserve the existing arrays on `GET /v1/review` and add
  `totals` and `nextCursors`, each keyed by `pendingAssertions`,
  `unresolvedParticipants` and `mergeSuggestions`. Accept a separate cursor
  for each collection; each has a limit and deterministic ordering by time
  and ID. Schema changes return `{ changes, total, nextCursor }`, accepting
  `cursor` and retaining the `status` filter. Totals count all matching items,
  not just a page. Define cursors so removing reviewed items does not skip
  remaining work; do not paginate a shrinking inbox by offset.
- **Review details.** List items and direct assertion reads include nullable
  `source: { id, title, occurredAt }` and
  `conflictingRecord: { id, object, label }`. A missing, retracted or no-longer
  conflicting reference is represented as null. Conflict links describe the
  current claim, which the server rechecks on acceptance.
- **Object-scoped keyword lookup.** `POST /v1/objects/:object/query`
  accepts optional `search` text, ANDed with structured filters. Use Postgres
  full-text matching over the existing record search vector, under the same
  workspace/object restrictions. This supports relation pickers and the
  current-object command palette even when the label field is not filterable.
  Global search, ranking and context packs remain in architecture step 4.
- **Relation labels.** Record reads and queries support
  `include=relationReferences` (an `include` array on query requests), returning
  one separate response-level map keyed by target ID
  with `{ id, object, label }`, leaving field values as IDs. Resolve targets
  in batches through the shared record-reference presentation path under RLS;
  the UI must not fetch each relation separately. Omit unavailable targets
  and render an unavailable-reference state rather than inventing a label.
- **Other growing collections.** Assertion history, record interactions,
  interaction claims and record facts provide cursor pagination and
  `nextCursor`; their screens expose Load more rather than silently stopping
  at the current server limits.

Relation filters by target ID already exist in the query engine (`eq` and
`in`); use them for inverse-relation links, respecting `isFilterable`.

Each route lands with API-layer tests (12, layer 3). The cookie and CSRF
rules get tests for: cookie only, header only, both, revoked key, and a
cookie-authenticated write without the CSRF header.

Already planned routes the app picks up when they ship: `POST /v1/search`
and `GET /v1/records/:id/context` (step 4), merges and `forget` (step 5).

### 9.2 SDK (MIT)

`@retainer/sdk` exposes a typed method per REST route, with public response
and schema-operation types in `@retainer/shared`. It supports abort signals
and typed API errors. The app uses it with `credentials: 'include'` and the
CSRF header instead of a bearer key. This part of architecture step 6 moved
earlier; step 6 completed it with the step 4 and 5 routes.

### 9.3 Shared value validation (MIT)

Extract pure value validation/normalization from `records/values.ts` into
`@retainer/shared`, expressed against public field definitions and settings.
Do not import server code into MIT packages. Cover all field types, nullability,
select options, text limits, real dates and time zones, phone syntax, HTTP(S)
links, nonempty full names, deduplication and multi-value limits. Match current
server behavior: `maxValues` caps the total primary plus additional values.
The shared setting's comment describes the same total-value cap. Keep tenant, uniqueness, relation-target and write-precondition
checks in the server. Preserve existing normalization and API error behavior
when switching the server to the shared helpers.

---

## 10. Testing

Same rules as `ARCHITECTURE.md` section 12: a real database, never a mock.

| Layer      | Covers                                                                                                                  | How                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Unit       | Field modules: every type round-trips through its shared schema; money to micros; registry completeness                 | Vitest                                                                                                                  |
| Component  | Displays and inputs per type, provenance tooltip, review row states                                                     | Vitest and Testing Library                                                                                              |
| End to end | Sign in, review inbox accept and reject, schema approval, record edit with a stale precondition, retract an interaction | Playwright against the real server and Postgres, a fresh database per test, seeded through the REST API as an agent key |

Add coverage for inboxes larger than one page (including decisions between
page loads), accurate totals and off-page review links; acceptance that leaves
a newer value current; unique conflicts; partial bulk failures; relation-label
batching; cache refresh after retraction; preserved drafts after stale writes;
and logout followed by another session with requests still in flight. Permission
checks cover admin-only scopes and non-user actors. Shared validation tests
include invalid values previously accepted by composite schemas alone.

End-to-end tests run in CI after layers 1–4.

---

## 11. Build order

1. **Prerequisites.** Section 9: session cookie, `GET /v1/me`, static
   serving, SDK methods and response contracts, shared field validation,
   pagination and enrichment, and the provenance and history routes.
2. **Shell and review inbox.** Sign-in, layout, schema cache, every field
   type's `Display`, provenance components, and the review inbox (5.2).
3. **Records.** Object lists, record page read-only, facts, interactions,
   interaction page, schema page.
4. **Editing.** Every field type's `Input`, inline editing, retracting facts
   and interactions.
5. **After server steps 4 and 5.** Search, suggested merges, `forget`.

Each step lands with its tests (10).

---

## 12. Documents to update when this is built

- `CLAUDE.md` and `AGENTS.md`: "No UI" becomes "No UI except the optional web
  app in `packages/web`", plus its commands.
- `ARCHITECTURE.md`: the opening ("It has no UI"), section 6 (new routes),
  section 7 (cookie sessions), section 8 (`packages/web`, MIT), section 9
  (Vite, React, TanStack, Tailwind).
- `README.md`: how to open the app and create a person's key.

---

## 13. Open questions

1. **Brand colour** and a name for the app, if it is not just "Retainer".
2. **Cookie holds the key.** Simple and revocable, but a stolen cookie is a
   stolen key until revoked. The alternative is a `sessions` table with
   short-lived tokens. Is the simple version enough for v1?
3. **Schema editing in the UI.** v1 only approves what agents propose. Should
   people be able to propose changes from the schema page?
4. **Record creation.** No creation flow is specified yet. Decide whether
   creation belongs in the web v1 before including it in implementation.
   Label-only creation is not sufficient for objects with other required
   fields; inclusion needs a schema-driven required-field form and tests.
5. **Release boundary.** Decide whether search, suggested merges and `forget`
   are part of the web v1 or a later release. Build step 5 is conditional on
   server work and is not a complete UI contract: merge survivor selection,
   conflict feedback, permissions and destructive confirmation still need
   specification before that step is implemented.
