# Accounts, organizations and access: spec

Status: **proposed** November 6, 2026. Nothing here is built. Three defaults
need confirming before the work starts (section 9).

This spec turns Retainer from a server an operator runs into a service people
sign up for: they log in, create workspaces, invite colleagues and connect
agents. It amends `ARCHITECTURE.md` section 7 and `FRONTEND.md` section 4 and
adds deployment pieces to [Deploying to AWS](aws.md).

## 1. Why

### 1.1 What already works

Workspaces are already isolated for many tenants. Every tenant table has
`workspace_id`, row-level security (RLS) applies to every query, tenant foreign
keys include the workspace, and the server runs as `retainer_app`, which owns
nothing and has no `BYPASSRLS`. `deploy/aws` runs the service on Lambda, API
Gateway and RDS. None of that needs redesigning.

### 1.2 What is missing

- **People have no identity.** A person signs in by pasting an API key, and
  the session cookie holds that raw key (`packages/server/src/auth/session.ts`).
  There are no users, and a key is the only credential.
- **Only an operator can create a workspace.** `createWorkspace` needs the
  migration role, and the runtime role cannot insert workspaces. That is right
  for a self-hosted install and blocks self-serve signup.
- **Nobody can share a workspace properly.** Each person needs a key issued by
  an operator. There are no invitations or roles.
- **Some agents cannot connect.** `/mcp` accepts only API keys, so clients that
  only support OAuth, such as connectors in Claude's web app, cannot use it.
- **Tenants are assumed to be trusted.** There is one global throttle, no
  quotas, and the API function holds the database owner's password (4.9).

## 2. Scope

**In scope:** users and sessions; organizations; roles at organization and
workspace level; self-serve workspaces; invitations; API keys in the web app;
OAuth for MCP; the hardening a public signup needs.

**Out of scope, with the door left open (section 7):** groups, record-level
access, field-level access, a permission service, billing. The seam billing
will use is in scope (4.10); Stripe itself is not.

**What does not change:** the workspace stays the security boundary. RLS stays
keyed on `workspace_id`. Records get no organization column. A `Caller` still
has exactly one workspace. Queries never cross workspaces. Retainer still calls
no language model.

## 3. Decisions

| #   | Decision                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------ |
| A1  | Keep the backend and RLS. Clients never talk to the database (3.1).                                          |
| A2  | People log in through an external identity provider over OIDC. Retainer stores no passwords.                 |
| A3  | A session is a second way to build a `Caller`. Everything after `authenticate` is unchanged.                 |
| A4  | Sessions are opaque tokens stored hashed. The cookie no longer holds an API key in accounts mode.            |
| A5  | Organizations own workspaces and members. They are hidden in the UI until someone needs them.                |
| A6  | Access is RBAC at workspace level (3.2). Roles are named bundles of the existing scopes.                     |
| A7  | The client names the workspace on each request, and the server checks access each time.                      |
| A8  | A narrow `retainer_control` role does account work. Nothing reachable from the internet uses the owner role. |
| A9  | Functions in the VPC stay without internet. One function outside the VPC holds no database access (4.6).     |
| A10 | MCP OAuth tokens are issued by Retainer and capped by the role of the person who granted them.               |
| A11 | No third-party permission service for now, managed or self-hosted (3.3).                                     |

### 3.1 Why not a Supabase-style design

In that design the browser reaches the database through a generated API, and
RLS with a signed token is the main access check. Retainer's rules cannot live
there: deriving `records.data` from assertions, the schema engine, `forget`
locking, identifier claims and idempotency all need server code. Agents need
MCP, and self-hosters need plain Postgres.

The cost of this design is that RLS here is a second line of defense. It trusts
the `app.workspace_id` the server sets, so it catches a query that forgets to
filter, not a server that picks the wrong workspace. The access check in
`authenticate` is therefore the real gate, and it needs the most tests.

### 3.2 The four questions of access

| Question                   | Enforced by                             | Status           |
| -------------------------- | --------------------------------------- | ---------------- |
| Which workspace's data?    | RLS on `workspace_id`                   | Done             |
| What can you do there?     | Roles mapped to scopes, on each route   | This spec        |
| Which records can you see? | Restrictive RLS (`ARCHITECTURE.md` 7.2) | Not in this spec |
| Which fields can you see?  | Neither fits; avoid                     | Not planned      |

RLS cannot hide fields because values sit in `records.data` as JSONB, and also
in the search index and `field_assertions`. To hide a field from some people,
use a separate object or workspace.

### 3.3 Why no permission service

We looked at SpiceDB, OpenFGA, Auth0 FGA, AuthZed Cloud, WorkOS FGA and Cerbos
(their documentation as read on November 6, 2026). They are good at storing
rules and answering "can X do Y?". For Retainer:

- **At launch they add work.** Workspace roles are a few tables and one lookup.
- **Lists are the hard part.** Retainer's reads are search, filtered queries,
  counts and aggregates. OpenFGA's `ListObjects` defaults to 1,000 results and a
  3-second deadline. SpiceDB suggests its lookup below about 10,000 results, and
  calls its commercial Materialize the most scalable option. Checking results
  page by page does not work for counts and aggregates.
- **Enforcement leaves Postgres.** RLS cannot call a service, so every read path
  would have to remember the check. Section 7.2 of the architecture rejects
  that. SpiceDB's Postgres connector is marked experimental, and it runs
  aggregates and sorting on the client.
- **Two stores can disagree.** A record and its access rule cannot commit in one
  transaction, and `forget` would have to clean both.
- **It breaks deployment promises.** Self-hosters would run a second server. A
  managed service would need internet from a VPC that has none, and would hold
  access data outside the AWS account. The open-source product cannot depend on
  our paid account.
- **The hard product questions stay** (7.2).

Wanting "a Zanzibar-style model" is not a reason by itself. Write the rule as a
customer would say it and see whether it fits a fixed number of joins. If it
does, Postgres handles it.

**When to reconsider.** Any one of these, if paying customers need it:

1. Access flows through nesting of any depth, set up by customers.
2. Rules must apply beyond Retainer's Postgres, such as a second product.
3. Keeping `record_access` (7.3) current becomes the main cost.
4. Customers write their own rules and roles.
5. "Who can see this, and why?" can no longer be answered reliably.

Groups, SSO, enterprise customers, more users and single-record sharing do not
qualify. If a trigger fires, prefer a self-hosted Apache-2.0 engine, keep
workspace RLS, and feed `record_access` from its change feed so RLS stays the
enforcer. Prototype against filtered search with counts in a large workspace
first.

## 4. System design

### 4.1 Two modes

| Mode          | When                      | People sign in with | Workspaces come from   |
| ------------- | ------------------------- | ------------------- | ---------------------- |
| Key (default) | No OIDC settings          | A personal API key  | The operator CLI       |
| Accounts      | `RETAINER_OIDC_*` are set | The provider        | The CLI or the web app |

A self-hosted install that upgrades sees no change unless it sets those values.
In accounts mode `POST /auth/session` returns 404. API keys work for agents in
both modes.

### 4.2 Data model

These tables are not tenant tables. Like `api_keys`, they have RLS enabled, no
policy for the runtime role and no grants to it.

| Table                  | Columns                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                | `id`, `provider_subject` (unique), `email`, `name`, `created_at`, `disabled_at`                                                       |
| `sessions`             | `id`, `token_hash` (unique), `user_id`, `created_at`, `expires_at`, `revoked_at`                                                      |
| `organizations`        | `id`, `name`, `limits` (4.10), `created_at`                                                                                           |
| `organization_members` | `organization_id`, `user_id`, `role` (`owner`, `admin`, `member`), `created_at`                                                       |
| `workspace_members`    | `organization_id`, `workspace_id`, `user_id`, `role` (`admin`, `editor`, `viewer`), `created_at`                                      |
| `invitations`          | `id`, `organization_id`, `email`, `role`, `workspaces` (jsonb), `token_hash`, `invited_by`, `expires_at`, `accepted_at`, `revoked_at` |
| `oauth_clients`        | `id`, `name`, `redirect_uris`, `created_at`                                                                                           |
| `oauth_grants`         | `id`, `client_id`, `user_id`, `workspace_id`, `scopes`, `refresh_hash`, `created_at`, `revoked_at`                                    |

Changes to existing tables:

- `workspaces.organization_id`: required, `ON DELETE RESTRICT`, with a unique
  `(organization_id, id)`. Add it nullable, backfill, then make it required.
  Deleting an organization never cascades into workspaces.
- `workspaces.deletion_scheduled_at` (4.5).
- `api_keys.created_by_user`, `api_keys.expires_at` and
  `api_keys.granted_by_user` (4.7).

`workspace_members` has composite foreign keys to `organization_members` and to
`workspaces (organization_id, id)`. A person can therefore only hold a role in
a workspace of an organization they belong to, and leaving the organization
removes those roles in the same statement.

Users match by `provider_subject`, never by email, so a recycled address cannot
take over an account.

**Existing data.** The migration creates one `Default` organization and moves
every existing workspace into it. `bootstrap` does the same on a new container
install. The CLI gains `org create`, `org list`, `member add` and `workspace
move`, and `workspace create` gains `--org`, defaulting to `Default`.

### 4.3 Roles

Workspace roles are bundles of the existing scopes. Routes keep calling
`requireScope` and do not change.

| Workspace role | Scopes                                   | In plain words                                                                               |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `viewer`       | `read`                                   | Can see everything in this workspace                                                         |
| `editor`       | `read`, `write`                          | Can also add and change records, comment and review                                          |
| `admin`        | `read`, `write`, `schema:write`, `admin` | Can also change the workspace's structure, erase personal data, and manage people and agents |

Organization roles:

| Organization role | Means                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| `owner`           | `admin` in every workspace; billing; delete the organization; manage owners |
| `admin`           | `admin` in every workspace; create workspaces; invite and remove members    |
| `member`          | Only the workspaces they are added to, with the role set there              |

A person's effective role is `admin` if they are an owner or admin of the
organization, otherwise their `workspace_members` role, otherwise none.

The full table of what each kind of caller can do:

| Action                                | Viewer | Editor | Admin | Agent               |
| ------------------------------------- | ------ | ------ | ----- | ------------------- |
| Read and search                       | Yes    | Yes    | Yes   | With `read`         |
| Write records, events and facts       |        | Yes    | Yes   | With `write`        |
| Write comments                        |        | Yes    | Yes   | Never               |
| Review assertions and merges          |        | Yes    | Yes   | Never               |
| Non-destructive schema changes        |        |        | Yes   | With `schema:write` |
| Destructive schema changes            |        |        | Yes   | Propose only        |
| `forget`, moving events               |        |        | Yes   | Never               |
| Manage API keys and workspace members |        |        | Yes   | Never               |

The human-only rules (`requireUser`, `canApproveDestructive`, the comment rule)
stay as a separate check. A scope is never a person's approval.

The role tables live in `packages/shared`, so the server and the web app read
one definition. A test runs every role against every route.

### 4.4 Authentication

`Caller` gains an optional `userId`. `authenticate` works in this order:

1. **`Authorization` header present:** as today, it never falls back to the
   cookie. A session token (`rts_`) in this header is refused.
2. **Cookie holding `rts_`:** a session. Requires `X-Retainer-Workspace`, then
   calls `retainer_session_access(token_hash, workspace_id)`.
3. **Cookie holding `rtn_`:** key mode, as today.

`retainer_session_access` is `SECURITY DEFINER`, fixes its `search_path` and is
granted only to `retainer_app`. It takes the token hash, not a user ID, so the
runtime role cannot ask about an arbitrary person. It returns the user and the
effective role.

| Result           | Response                                                     |
| ---------------- | ------------------------------------------------------------ |
| No row           | 401: expired, revoked or unknown session, or a disabled user |
| Row with no role | 404: the workspace's existence is not revealed               |
| Row with a role  | `Caller { workspaceId, actor: user:<id>, scopes, userId }`   |

Access is checked on every request, so removing someone or changing their role
applies at their next request. Cookie-authenticated mutations keep the
`X-Retainer-Client` and Origin checks.

**Why the workspace is per request (A7).** If the session held an "active
workspace", switching in one tab would make another tab write to the wrong
place. The client chooses the workspace and never authorizes it. A bearer
request needs no header, because keys belong to one workspace, and a header
naming a different workspace is refused with a 400.

**Session lifetime.** 30 days, fixed. After that the provider signs the person
back in. `disabled_at` and "sign out everywhere" revoke all sessions.

### 4.5 Workspaces and account routes

Account routes live under `/account`, take a session cookie only, and are never
reachable with an API key. An agent's key can therefore never create a key,
add a member or create a workspace, as `ARCHITECTURE.md` 7.1 requires.

| Route                                                           | Who                         |
| --------------------------------------------------------------- | --------------------------- |
| `GET /account`: the user, organizations, workspaces, roles      | Signed in                   |
| `POST /account/sign-out`                                        | Signed in                   |
| `POST /account/workspaces`                                      | Organization owner or admin |
| `DELETE /account/workspaces/:id`                                | Organization owner or admin |
| `PATCH`, `DELETE /account/organizations/:id`                    | Owner                       |
| `GET`, `PATCH`, `DELETE /account/organizations/:id/members/...` | Organization owner or admin |
| `POST`, `GET`, `DELETE /account/organizations/:id/invitations`  | Organization owner or admin |
| `POST /account/invitations/:token/accept`                       | Signed in, verified email   |
| `PUT`, `DELETE /account/workspaces/:id/members/:userId`         | Workspace admin             |
| `GET`, `POST`, `DELETE /account/workspaces/:id/keys`            | Workspace admin             |

**First workspace.** A person with no memberships and no pending invitation
sees "Name your workspace". `POST /account/workspaces` then creates the
organization, owner membership, workspace and seed in one transaction, so there
are no empty organizations and nothing half-created.

**One transaction.** `retainer_control` inserts the account rows and the
workspace, then runs `SET LOCAL ROLE retainer_app` and sets `app.workspace_id`
to seed through the schema engine under RLS. The template is optional, and
without one the first agent chooses as today (`ARCHITECTURE.md` 3.1).

**Slugs.** `workspaces.slug` is unique across all customers. A plain `slug_taken`
would reveal another customer's workspace name, so self-serve creation adds a
generated suffix, such as `sales-x7k2`. The CLI keeps exact slugs.

**Invitations.** A token is stored hashed and expires after 7 days. Accepting
requires a verified email from the provider that matches the invitation, so a
forwarded link is useless to anyone else. Accepting twice is a no-op.

**Removing a member.** Web access ends at the next request. OAuth grants they
made are revoked. Agent keys belong to the workspace and keep working, and the
UI shows who created each one. Past writes keep their actor.

**The last owner.** An organization always has an owner. Membership changes lock
the organization row, so two owners removing each other cannot leave none.

**Deleting.** Deleting a workspace sets `deletion_scheduled_at`. Every lookup
then refuses it, the consolidator skips it, and after 7 days a scheduled control
run hard-deletes it, cascading as today. Support can undo it within those days.
An organization can be deleted only when it has no workspaces left.

**API keys in the web app** are for agents and integrations only: `read`,
`write` and `schema:write`. The actor is `agent:<slug of the name>` and cannot
be a person. Keys with a `user` actor remain CLI-only.

### 4.6 Deployment shape

```
 People (browser)                      Agents
   │ session cookie                      │ API key or MCP OAuth token
   ▼                                     ▼
 API Gateway
   │        │                 │
   │        │ /account        │ /auth/oidc, invitations, webhooks
   │        │ /oauth          ▼
   │        │             edge function ◄──► identity provider, email
   │        │             (internet, no database)
   │        ▼                 │ Lambda invoke (IAM)
   │     control function ◄───┘
   │     (VPC, no internet, retainer_control)
   │ /v1, /mcp, /app
   ▼
 api function (VPC, no internet, retainer_app + RLS)
   │        │
   └───► RDS Postgres ◄───┘
```

`docs/aws.md` promises that the functions reach only the database. Login and
webhooks need the internet, so they get their own function, which has no
database access. A NAT gateway would be simpler but costs more and gives up the
promise.

- **Sign-in.** The edge function handles the OIDC redirect with PKCE and `state`,
  exchanges the code and verifies the ID token. It refuses an unverified email,
  then invokes control with the subject, email and name. Control upserts the user
  and creates a session. The edge function sets the cookie and redirects to
  `/app/`. It alone holds the client secret.
- **Invitations.** The route goes through the edge function. Control creates the
  invitation and returns the link, the edge function emails it, and the web app
  also offers "Copy invite link".
- **Direct invocations.** Control accepts them only with a strict event shape,
  as the ops function does. An API Gateway event cannot pass as one.
- **Container.** With `RETAINER_ROLE=all` the same routes run in one process. The
  separate functions exist only for the no-internet AWS network.
- **Deploys.** `deploy.sh` also stops and starts `control` and `edge`.

The cookie stays `SameSite=Strict`. The redirect back from the provider still
works, because the static app loads without a cookie and its own requests send
one.

### 4.7 MCP OAuth

Retainer acts as its own authorization server, following the current MCP
authorization specification (check the revision when building this):

- `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server`.
- A `401` from `/mcp` names the resource metadata in `WWW-Authenticate`.
- `/oauth/register`, `/oauth/authorize` and `/oauth/token`, with PKCE and exact
  redirect URI matching. Registration is rate limited.

**Consent.** `/oauth/authorize` is opened from another site, so a
`SameSite=Strict` cookie does not arrive. It redirects to `/app/oauth/consent`,
whose own requests carry the cookie. There the person picks a workspace and
scopes, capped by their role. That page must not be framed
(`frame-ancestors 'none'`).

**Tokens.** A grant creates a short-lived access token (1 hour) stored as an
`api_keys` row with `expires_at` and `granted_by_user`, and a rotating refresh
token on `oauth_grants`. The api function checks it like any key, with a database
lookup and no internet. The actor is an `agent`, named after the client and the
person, so the human-only rules still apply.

**The cap.** `retainer_lookup_api_key` also rejects expired keys and returns the
granting person's current effective role. The request's scopes are the key's
scopes intersected with that role's. Losing access ends the token at once.

### 4.8 Limits

- **Rate.** A per-workspace limit returning `429` with `Retry-After`, in addition
  to the global API Gateway throttle. Start with a counter in an unlogged Postgres
  table, because Postgres is the only dependency. Measure it before launch, and
  move it if it shows up as contention.
- **Time.** A statement timeout on the runtime role, below the 29-second request
  limit, so that one expensive search cannot hold connections.
- **Signup.** Verified email required; limits on workspaces and members per
  organization.

### 4.9 Database credentials

The API, consolidator and ops functions all receive one `DATABASE_URL` holding
the owner's password, and the first two switch to `retainer_app` at connection
start. RLS holds as long as nothing runs `SET ROLE`, but a SQL injection could
switch back to the owner and bypass it. With public signup that is too thin.

| Function             | Logs in as         | Direct privileges                                                             |
| -------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `ops`                | Owner              | Migrations and the operator CLI; only the operator invokes it                 |
| `api`, `consolidate` | `retainer_app`     | As today, and it no longer can become the owner                               |
| `control`            | `retainer_control` | Account tables, `workspaces`, `api_keys`; can `SET ROLE retainer_app` to seed |
| `edge`               | None               | No database access                                                            |

`retainer_control` has no `BYPASSRLS` and no DDL. It holds `retainer_app` with
`INHERIT FALSE, SET TRUE`, and RLS policies of its own on `workspaces` and
`api_keys`. It can still read tenant data by switching role, the same power the
api function has, so its code only does that to seed. Each role gets its own
secret.

The container keeps one URL by default, and an optional
`RETAINER_RUNTIME_DATABASE_URL` gives self-hosters the same separation.

### 4.10 The billing seam

`organizations.limits` holds quotas, and null means unlimited, so self-hosted
installs have no limits. Retainer enforces limits and does not know where they
come from. Stripe webhooks arrive at the edge function, which invokes control
to set them. Plans, prices and Stripe code stay out of the open repo.

## 5. Frontend design

Plain words throughout, per the web app's rule. No screen says "RBAC", "scope",
"OIDC" or "tenant".

- **Sign in.** One button that goes to the provider. Key mode keeps today's
  screen.
- **First run.** "Name your workspace", then the existing flow. The word
  organization does not appear.
- **URLs.** `/app/w/<slug>/...` in accounts mode, and `/app/...` as today in key
  mode. The router's base path is computed at startup from the location.
- **Switching workspaces** is a full page load. It clears cached data and needs
  no router or query changes, and a tab stays on its workspace. The switcher
  appears when a person has more than one.
- **Session state.** Inside a workspace, `Session` stays as it is, so scope checks
  and `canMutate` are unchanged. `GET /account` supplies the rest.
- **Members** (workspace settings). Everyone with access and their role, each
  explained with the plain words in 4.3. While an organization has one workspace,
  inviting happens here too.
- **Organization** appears in settings only once there is a second member or a
  second workspace.
- **Agents** (workspace settings). Create and revoke keys, shown once with
  copyable connection instructions, and see who created each. OAuth grants appear
  here too, and can be revoked.

## 6. Implementation order

Each step lands with its tests and can ship alone.

1. **Credentials (4.9).** Separate logins for each function. This is worth doing
   whether or not the rest goes ahead.
2. **Model.** Account tables, the `Default` organization, the role tables in
   `shared`, the CLI.
3. **Sign-in.** Provider, edge and control functions, sessions, `authenticate`,
   the workspace header, URLs, Terraform.
4. **Self-serve.** Workspace creation, members, invitations, keys in the web app.
5. **MCP OAuth.**
6. **Hardening.** Rate and quota limits, scheduled deletion, a staging deployment
   (a second `name`), a larger instance with `db_multi_az` on, and a practised
   restore. The legal items in section 9.
7. **Private beta**, then billing when people want to pay.

## 7. What can come later

### 7.1 Groups: small

Add `groups`, `group_members` and `workspace_group_roles`. The effective role
becomes the highest of the direct and group roles. Only the lookup changes, and
`Caller` looks the same. SSO can later fill the same tables.

### 7.2 Record-level access: large

The rule is the easy part, and it is the same cost whichever model expresses it.
The hard parts are:

1. **Coverage.** 20 tables carry `workspace_id`, and many hold record data.
2. **Uniqueness leaks.** Creating a person with an email on a hidden record
   reveals or matches that record. `ARCHITECTURE.md` 7.2 already accepts the cost:
   claims become per audience, and sharing a private record becomes a merge.
3. **Shared events.** Whether someone sees a call with one visible and one hidden
   person, and what rollups show, are product decisions.
4. **Agents.** Each needs an audience. The consolidator's merge suggestions can
   pair records a reviewer cannot see.
5. **Performance.** A check on every row touches search, counts and paging.

If this is ever needed, start with a fixed setting of Everything, Team or Owned,
then single-record sharing.

### 7.3 One table for every model

Whatever model comes later, ACL entries, ownership, groups or relationship rules
all write to one `record_access` table, and one restrictive RLS policy reads it. A
record with no restrictions stays visible to everyone in the workspace, so the
change is additive. Keeping the table current becomes the new work.

### 7.4 Keeping the path open

- `Caller` carries `userId`, and actors use a stable UUID, not an email.
- Roles resolve in one function, the only place groups need to touch.
- Everything in `ARCHITECTURE.md` 7.2 stays true. This spec adds exactly one
  `SECURITY DEFINER` function, and a new test fails on any function outside the
  list.
- No generic permission tables or policy engine until a rule needs one.

## 8. Tests

In the layers of `ARCHITECTURE.md` section 12.

| Layer       | Proves                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Effective role, the role-to-scope tables, slug suffixes, OAuth scope capping                                                                                                                                                                                |
| Database    | The runtime role cannot read account tables; `retainer_session_access` answers only for its own token; expired and revoked tokens; the composite foreign keys; deleting an organization with workspaces fails                                               |
| Concurrent  | Two owners removing each other leave one; two first sign-ins make one user; two accepts of one invitation make one membership; two first workspaces make one organization                                                                                   |
| API         | Every role against every route; an API key on `/account` is refused; a session with a workspace it cannot access gets 404; a session token in `Authorization` is refused; header mismatch on a bearer request gets 400; removal applies at the next request |
| Credentials | The runtime login cannot `SET ROLE` to the owner, and `retainer_control` holds no DDL rights                                                                                                                                                                |
| Agent       | An OAuth client registers, is consented, connects and calls tools; its token dies when the person is removed                                                                                                                                                |
| Browser     | Sign up, name a workspace, invite someone who accepts, each role sees the right buttons, two tabs on two workspaces write to the right ones                                                                                                                 |

Every test uses real Postgres with a fresh cloned database. CI uses a fake OIDC
provider, so no test needs the internet.

## 9. Open questions

**To confirm before starting.** The spec takes these defaults:

1. **Accounts live in the open repo (AGPL).** The auth path needs them, and
   self-hosters benefit. Billing stays private. This reverses the line in
   `ARCHITECTURE.md` 7 that puts provisioning and SSO outside the repository.
2. **WorkOS AuthKit is the provider.** Its pricing page lists the first million
   monthly users as free, and SSO can follow. The design only needs OIDC, so check
   first that AuthKit works as a plain OIDC provider. If not, add a small adapter
   in the edge function. Cognito is the alternative if keeping everything in one
   AWS account matters more than developer experience. Either way the provider
   sees names and emails, never CRM data.
3. **Whole workspaces are the finest thing to hide at launch.** Choosing record
   level would not change the build order, but section 7.2 would need designing now.

**Later:**

4. **Old personal keys.** Actors like `user:maya` stay separate from new user IDs,
   so a person cannot edit comments written under the old one. A mapping could
   be added if that matters.
5. **Departed people's names** stay on past writes through the stored actor.
   `forget` covers records, not actors. Erasing a former employee's name needs a
   decision.
6. **Viewers and private views.** Creating a view needs `write`, so a viewer cannot
   save a private view. That is acceptable at first.
7. **Zero-downtime deploys.** Each deploy gives up to a minute of `503`s because one
   version runs at a time. Acceptable for a beta, not once customers rely on it.
8. **Legal.** Retainer becomes a data processor for customers' contacts: terms, a
   DPA and a sub-processor list are needed. Erased data stays in backups for up to
   14 days, and that must be stated. Private code that imports the AGPL server
   needs the rights to any outside contributions checked.

## 10. Acceptance

- A new person signs up, names a workspace and connects an agent, with no operator.
- They invite a colleague, who accepts and sees only the workspaces they were
  given, with the right buttons for their role.
- Removing that colleague ends their web access and OAuth tokens at the next
  request, and agent keys keep working.
- No agent credential can create a key, a member or a workspace.
- Claude's web app connects to `/mcp` over OAuth.
- One tenant's traffic spike gets `429`s while others keep working.
- The api function's database login cannot become the owner.
- A self-hosted install that sets nothing behaves exactly as before.

## 11. Documents to update

Update these when the work lands, not before:

- `ARCHITECTURE.md`: section 7 (sessions, organizations, roles, the new function)
  and 7.1 (self-serve alongside the CLI).
- `CLAUDE.md`: "Every write carries an Actor, taken from the API key" becomes "from
  the credential".
- `FRONTEND.md`: section 4.
- `docs/aws.md`: new functions, credentials, and the OAuth limit it lists.
- `docs/self-hosting.md`: `RETAINER_OIDC_*`, `RETAINER_RUNTIME_DATABASE_URL`, the
  new CLI commands.
- `docs/rest-api.md`: `/account`, `X-Retainer-Workspace`.
- `docs/agents.md`: connecting over OAuth.
