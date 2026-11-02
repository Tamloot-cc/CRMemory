# Retainer web app

Status: draft spec, not built. Read `ARCHITECTURE.md` first; this document
uses its section numbers.

Retainer is used by agents through REST and MCP. The web app is for the
people those agents work for. It does the jobs only a person can do and lets
them see what the agents remembered and why. It is not a CRM front end:
no pipelines, dashboards, email sync or agent chat.

---

## 1. Decisions

| Decision      | Choice                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Package       | `packages/web`, published as `@retainer/web`, **MIT**                                                                                           |
| Data source   | `@retainer/sdk` over the REST API only. Never imports `packages/server`                                                                          |
| Data model    | Every list, form and filter is built at runtime from `GET /v1/schema`; nothing is written per object                                             |
| UI kit        | shadcn/ui on Tailwind CSS 4, React 19                                                                                                            |
| App shape     | Single-page app built with Vite; TanStack Router for routes, TanStack Query for server state                                                    |
| Hosting       | Static files served by the Retainer server at `/app`, same origin as the API, so the image stays one process and there is no CORS                 |
| Auth          | A person signs in with their own `user`-actor API key; the server turns it into an httpOnly cookie (4)                                           |
| Twenty        | A behaviour reference only. No Twenty code is copied or translated (2)                                                                          |
| First screens | Retainer's own: the review inbox, then records with provenance, facts and interactions                                                          |

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

| Route                  | Does                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /auth/session`   | Takes `{ key }`, checks it through `retainer_lookup_api_key`, sets the cookie and returns the same body as `GET /v1/me` |
| `DELETE /auth/session` | Clears the cookie                                                                                            |
| `GET /v1/me`           | The caller's workspace (`id`, `name`, `slug`), actor and scopes. Works with a bearer key or the cookie        |

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

### 4.3 What the UI shows by scope

The server enforces scopes; the UI only hides what would fail.

| Action                                  | Needs                     |
| --------------------------------------- | ------------------------- |
| Browse records, facts, interactions     | `read`                    |
| Edit fields, retract facts and interactions, accept or reject pending values | `write` and a `user` actor |
| Approve or reject schema changes        | `admin`                   |
| `forget`                                | `admin`                   |

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

Tabs, each with a count:

1. **Pending values.** One row per pending assertion: record label and
   object, field label, **current value → proposed value** rendered with the
   field type's display (6), who proposed it (actor badge, 7), the reason in
   plain words, confidence, `observedAt`, and the source interaction's title
   and date with a link to it (5.6).

   | `reason`          | Shown as                                                         |
   | ----------------- | ---------------------------------------------------------------- |
   | `outranked`       | "Newer than a value a person or integration set"                 |
   | `low_confidence`  | "Below the workspace's confidence threshold"                     |
   | `unique_conflict` | "Another record already has this value" with a link to that record |

   Accept and Reject per row (`POST /v1/assertions/:id/accept` · `/reject`),
   and for a selection of rows. Accepting writes as the signed-in person
   (rule 2.3). A `409 not_pending` removes the row with a note that someone
   else decided it.

2. **Schema changes.** Proposed changes with their operations listed in
   words ("Add field *Renewal date* (date) to *Company*"), the proposing
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

- Columns come from the object's fields in schema order. The label field is
  first and pinned. Inverse relations and `json` fields are hidden by
  default; a column menu shows and hides the rest, saved per object in
  `localStorage`.
- Filters are offered for `isFilterable` fields only, with the operators
  each type supports (6). Sort by any sortable column.
- Cursor pagination with `limit` 50.
- Rows open the record page.
- The sidebar lists every object from the schema, standard ones first.

### 5.4 Record — `/app/r/:id`

Source: `GET /v1/records/:id`, its provenance (9.1), facts and interactions.
An ID that was merged loads the surviving record and says so.

Three areas:

- **Fields.** Every field with its type's display. Each value carries its
  provenance (7): who wrote it, when it was observed, and the source
  interaction. A field with a pending assertion shows a marker that links to
  that row in the review inbox. Clicking a field edits it with the type's
  input; saving sends `PATCH /v1/records/:id` with the record's
  `updatedAt` as `expectedUpdatedAt` (rule 2.5). A `412 stale_write` shows
  the new value instead of overwriting it. A history button opens every
  assertion for that field, including superseded, rejected and retracted
  ones, newest first.
- **Relations.** Many-to-one fields render as a link to the target. Each
  inverse (one-to-many) field renders as a short list of linked records with
  a link to the filtered object list.
- **Memory tabs.**
  - *Facts*: `GET /v1/records/:id/facts`. Content, `validFrom`, writer, and
    each source with its quote. Retract (`DELETE /v1/facts/:id`) asks for
    confirmation.
  - *Interactions*: newest first (9.1). Kind icon, title, date, summary,
    and participants, matched ones linked.
  - *Tasks*: open tasks linked to the record, from the standard `task`
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

Creating or editing objects and fields in the UI, record creation forms
beyond the label field, kanban and pipeline views, dashboards, workspace and
key management (operator CLI only, 7.1), several workspaces per session,
and `forget` (until build step 5).

---

## 6. Field types

### 6.1 One module per type

`src/fields/<type>/` exports:

| Export    | Does                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `Display` | Read-only rendering for a table cell (`compact`) and the record page (`full`)          |
| `Input`   | Editing control; produces a value that passes the type's schema in `@retainer/shared` |
| `Filter`  | The operators offered in the list filter bar for `isFilterable` fields                |
| `isEmpty` | Whether a value counts as empty for display                                           |

A registry maps every `FieldType` in `@retainer/shared` to its module, and a
unit test fails when a type has no module. Values are validated with the
shared Zod schemas before any write, so the UI rejects what the server would.

### 6.2 Behaviour per type

The last column is where to read how Twenty behaves (2). Paths are under
`packages/twenty-front/src/modules/`.

| Type           | Display                                                    | Input                                                                    | Twenty reference                                   |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| `text`         | Single line, full text on hover                             | Text field                                                                | `ui/field/display/components/TextDisplay`          |
| `number`       | Locale formatting                                          | Numeric field                                                            | `NumberFieldInput`                                 |
| `boolean`      | Check or dash                                              | Switch                                                                   | `BooleanDisplay`                                   |
| `date`         | Date in the viewer's locale                                | Date picker                                                              | `DateDisplay`                                      |
| `date_time`    | Date and time in the viewer's time zone, ISO on hover      | Date and time picker                                                     | `DateTimeDisplay`                                  |
| `select`       | Option label as a badge                                    | Combobox of `settings.options`                                           | `SelectDisplay`, `SelectFieldInput`                |
| `multi_select` | Badges, overflow as "+n"                                   | Multi-select combobox                                                    | `MultiSelectDisplay`, `MultiSelectFieldInput`      |
| `money`        | Amount from `amountMicros` with `currency`                 | Amount plus currency picker; converts to micros without floats           | `CurrencyDisplay`, `CurrencyFieldInput`            |
| `emails`       | Primary, "+n" for additional                               | List editor: add, remove, set primary; at most `settings.maxValues`      | `EmailsDisplay`, `EmailsFieldInput`                |
| `phones`       | Primary with country, "+n"                                 | List editor with country code                                            | `PhonesDisplay`, `PhonesFieldInput`                |
| `links`        | Primary label or host, "+n"                                | List editor of URL and label                                             | `LinksDisplay`, `LinksFieldInput`                  |
| `full_name`    | "First Last"                                               | Two fields                                                               | `FullNameFieldInput`                               |
| `address`      | One line: city, country; full address on the record page   | Grouped fields; `lat`/`lng` shown, not edited                            | `AddressFieldInput`                                |
| `relation`     | Target record's label as a link                            | Record picker searching the target object; inverse fields are read-only  | `RelationManyToOneFieldInput`                      |
| `json`         | Collapsed preview, formatted on the record page            | Read-only in v1                                                          | `JsonDisplay`                                      |

Composite values are replaced whole (rule 2.2), so list editors send the
complete value, not a diff.

### 6.3 Schema cache

`GET /v1/schema` returns `workspace.schemaVersion`. The schema is cached in
TanStack Query under `['schema', workspaceId, schemaVersion]` and re-read on
window focus and after any schema approval. A `404` for an object or field
that the cached schema still has triggers one refetch before showing an
error.

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

| Route                                       | Purpose                                                                                                   | Needed by |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- |
| `POST` · `DELETE /auth/session`              | Cookie sign-in (4.2)                                                                                      | 5.1       |
| `GET /v1/me`                                 | Workspace, actor and scopes of the caller                                                                 | 4.3       |
| Cookie in `authenticate`, CSRF header check  | 4.2                                                                                                       | all       |
| Static files at `/app`                       | Serves `packages/web/dist` when `RETAINER_WEB_DIR` is set; the Docker image sets it. Unknown `/app/*` paths return `index.html` | all |
| `GET /v1/records/:id/assertions`             | Every assertion for the record, optionally by `field`, with status, actor, `observedAt`, source and reviewer | 5.4, 7 |
| `GET /v1/records/:id/interactions`           | Interactions the record took part in, newest first, cursor-paginated                                       | 5.4       |
| `GET /v1/interactions/:id/claims`            | Assertions and facts that cite the interaction                                                            | 5.6       |
| Per-field provenance on `GET /v1/records/:id`| With `?include=provenance`, each field's winning assertion: actor, `observedAt`, source, and whether a pending assertion exists | 5.4, 7 |
| Relation filter on `query`                   | Confirm `POST /v1/objects/:object/query` can filter by a relation field's target ID; add it if not        | 5.4       |

Each route lands with API-layer tests (12, layer 3). The cookie and CSRF
rules get tests for: cookie only, header only, both, revoked key, and a
cookie-authenticated write without the CSRF header.

Already planned routes the app picks up when they ship: `POST /v1/search`
and `GET /v1/records/:id/context` (step 4), merges and `forget` (step 5).

### 9.2 SDK (MIT)

`@retainer/sdk` has only `health()` today. Before the app, it gets one typed
method per REST route, with request and response types in
`@retainer/shared`. The app uses the SDK with `credentials: 'include'` and
the CSRF header instead of a bearer key. This is part of build step 6 moved
earlier.

---

## 10. Testing

Same rules as `ARCHITECTURE.md` section 12: a real database, never a mock.

| Layer         | Covers                                                                                                   | How                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Unit          | Field modules: every type round-trips through its shared schema; money to micros; registry completeness | Vitest                                                                                          |
| Component     | Displays and inputs per type, provenance tooltip, review row states                                      | Vitest and Testing Library                                                                      |
| End to end    | Sign in, review inbox accept and reject, schema approval, record edit with a stale precondition, retract an interaction | Playwright against the real server and Postgres, a fresh database per test, seeded through the REST API as an agent key |

End-to-end tests run in CI after layers 1–4.

---

## 11. Build order

1. **Prerequisites.** Section 9: session cookie, `GET /v1/me`, static
   serving, SDK methods for existing routes, the provenance and history
   routes.
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
4. **Record creation.** v1 creates records only with the label field. Are
   full forms needed, or do agents create almost everything?
