# Accounts, organizations and access: spec

Status: **proposed** November 6, 2026. Nothing here is built. Better Auth is
chosen for login after a throwaway test, whose results are in section 12. One
default needs confirming before the work starts (section 9).

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
- **Tenants are assumed to be trusted.** There is one global throttle and no
  quotas, and every function shares one database login (4.9).

## 2. Scope

**In scope:** users and sessions; organizations; roles at organization and
workspace level; self-serve workspaces; invitations; API keys in the web app;
OAuth for MCP; passkeys; the hardening a public signup needs.

**Out of scope, with the door left open (section 7):** groups, record-level
access, field-level access, a permission service, multi-factor authentication
(4.11), billing. The seam billing will use is in scope (4.10); Stripe itself is
not.

**What does not change:** the workspace stays the security boundary. RLS stays
keyed on `workspace_id`. Records get no organization column. A `Caller` still
has exactly one workspace. Queries never cross workspaces. Retainer still calls
no language model.

**What is open source.** If one team running Retainer on its own server would
need something, it is open. If only someone selling Retainer as a service needs
it, it is not. Everything in this spec is open. Publishing cannot be undone, so
when unsure, decide first.

## 3. Decisions

| #   | Decision                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------ |
| A1  | Keep the backend and RLS. Clients never talk to the database (3.1).                                                      |
| A2  | People log in through Better Auth, running in our control function: magic link, Google, passkeys. No passwords.          |
| A3  | A session is a second way to build a `Caller`. Everything after `authenticate` is unchanged.                             |
| A4  | Sessions are Better Auth's: a signed cookie and a raw token in the database. The cookie no longer holds an API key.      |
| A5  | Organizations own workspaces and members. They are hidden in the UI until someone needs them.                            |
| A6  | Access is RBAC at workspace level (3.2). Roles are named bundles of the existing scopes.                                 |
| A7  | The client names the workspace on each request, and the server checks access each time.                                  |
| A8  | A narrow `retainer_control` role does account work. Nothing reachable from the internet uses the owner role.             |
| A9  | Only the control function has internet, through a NAT gateway. The api and consolidator functions stay without it (4.6). |
| A10 | MCP OAuth uses Better Auth's `mcp()` and `cimd()` plugins. Each request rechecks the person's role and consent (4.7).    |
| A11 | No third-party permission service for now, managed or self-hosted (3.3).                                                 |
| A12 | Whole workspaces are the finest thing to hide at launch, because first customers are small teams (3.2).                  |
| A13 | Passkeys ship in the first version. Multi-factor authentication does not (4.11).                                         |

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
  managed service would need internet from functions that have none, and would
  hold access data outside the AWS account. The open-source product cannot depend
  on our paid account.
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

### 3.4 Why Better Auth rather than WorkOS

Better Auth is an MIT library that runs in our process and keeps its data in our
Postgres. First customers are small teams, self-hosters get login with no vendor,
and it includes the OAuth server MCP needs. WorkOS would handle security fixes,
enforced MFA and enterprise SSO for us, and is the better fit if companies start
requiring those.

The cost we accept is upkeep: its project lists 49 security advisories, 4 of them
critical, including several in plugins we use (4.12). The choice can be reversed:
with no passwords there are no hashes to migrate, and everything past the
`Caller` stays the same.

### 3.5 Why stay on Lambda rather than Lightsail

A single Lightsail server would remove the separate functions and the NAT gateway,
and also the 29-second limit and cold starts. It costs about the same, though,
because the $15 database has no encryption. It also adds OS patching, a reverse
proxy and a single point of failure, and it puts Better Auth, internet access and
all customer data in one process. Its docs do not confirm Postgres 17 or the
extensions Retainer needs. It suits one team running Retainer for itself. If the
hosted service outgrows Lambda, look at ECS Fargate first.

## 4. System design

### 4.1 Two modes

| Mode          | When                          | People sign in with           | Workspaces come from   |
| ------------- | ----------------------------- | ----------------------------- | ---------------------- |
| Key (default) | No `RETAINER_AUTH_SECRET`     | A personal API key            | The operator CLI       |
| Accounts      | `RETAINER_AUTH_SECRET` is set | Magic link, Google or passkey | The CLI or the web app |

A self-hosted install that upgrades sees no change unless it sets that value.
Accounts mode also needs a way to send email. Google is optional. In accounts mode
`POST /auth/session` returns 404. API keys work for agents in both modes.

### 4.2 Data model

These tables are not tenant tables. Like `api_keys`, they have RLS enabled, no
policy for the runtime role and no grants to it.

**Owned by Better Auth.** `user`, `session`, `account`, `verification`, `passkey`,
`jwks` and the `oauth_*` tables, generated with its CLI into a Drizzle schema, then
through `pnpm db:generate` like any other table. IDs are UUIDs. The `user` table
gains `disabled_at` as an additional field. Its generated timestamps have no time
zone, so convert them to `timestamptz` to match the rest of the schema.

**Ours.**

| Table                  | Columns                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`        | `id`, `name`, `limits` (4.10), `created_at`                                                                                           |
| `organization_members` | `organization_id`, `user_id`, `role` (`owner`, `admin`, `member`), `created_at`                                                       |
| `workspace_members`    | `organization_id`, `workspace_id`, `user_id`, `role` (`admin`, `editor`, `viewer`), `created_at`                                      |
| `invitations`          | `id`, `organization_id`, `email`, `role`, `workspaces` (jsonb), `token_hash`, `invited_by`, `expires_at`, `accepted_at`, `revoked_at` |

We do not use Better Auth's organization plugin. It stores roles as comma-separated
strings, has no idea of workspaces, and cannot join the single transaction that
creates an organization, workspace and seed (4.5).

Changes to existing tables:

- `workspaces.organization_id`: required, `ON DELETE RESTRICT`, with a unique
  `(organization_id, id)`. Add it nullable, backfill, then make it required.
  Deleting an organization never cascades into workspaces.
- `workspaces.deletion_scheduled_at` (4.5).
- `api_keys.created_by_user`.

`workspace_members` has composite foreign keys to `organization_members` and to
`workspaces (organization_id, id)`. A person can therefore only hold a role in
a workspace of an organization they belong to, and leaving the organization
removes those roles in the same statement.

A person's identity is their verified email: a magic link proves it, and a Google
sign-in for the same address reaches the same user. Whoever controls that inbox
controls the account (4.11).

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

1. **`Authorization` header present:** an API key as today, or an OAuth token (4.7).
   It never falls back to the cookie.
2. **Better Auth session cookie:** requires `X-Retainer-Workspace`. The api
   function verifies the cookie's signature with `RETAINER_AUTH_SECRET`, then calls
   `retainer_session_access(session_token, workspace_id)`.
3. **Key-mode cookie:** as today.

The api function does not import Better Auth. A test fails if it does.

`retainer_session_access` is `SECURITY DEFINER`, fixes its `search_path` and is
granted only to `retainer_app`. It takes the session token, not a user ID, so the
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

**Session tokens are stored raw (A4).** Better Auth has no option to hash them. A
wrapper that hashed them made sign-out and single-session revocation stop working
without any error, so we do not use one. The signature is the protection: a token
read from the database alone is refused, because a valid cookie also needs the
secret. This has two costs. The api function holds the secret, and it relies on
Better Auth's cookie format, which is not documented. A test using real Better Auth
cookies must fail if an upgrade changes that format. Changing the secret signs
everyone out.

**Why the workspace is per request (A7).** If the session held an "active
workspace", switching in one tab would make another tab write to the wrong
place. The client chooses the workspace and never authorizes it. A bearer
request needs no header, because keys belong to one workspace, and a header
naming a different workspace is refused with a 400.

**Session lifetime.** 30 days, with `deferSessionRefresh` on so that reading a
session writes nothing. The web app refreshes through the control function when it
loads. `disabled_at` and "sign out everywhere" end all sessions.

### 4.5 Workspaces and account routes

Account routes live under `/account`, take a session cookie only, and are never
reachable with an API key. An agent's key can therefore never create a key,
add a member or create a workspace, as `ARCHITECTURE.md` 7.1 requires.

| Route                                                           | Who                         |
| --------------------------------------------------------------- | --------------------------- |
| `/account/auth/*`: Better Auth's own routes                     | As Better Auth defines them |
| `GET /account`: the user, organizations, workspaces, roles      | Signed in                   |
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
are no empty organizations and nothing half-created. A magic-link signup has no
name yet, so this screen also asks for one.

**One transaction.** `retainer_control` inserts the account rows and the
workspace, then runs `SET LOCAL ROLE retainer_app` and sets `app.workspace_id`
to seed through the schema engine under RLS. The template is optional, and
without one the first agent chooses as today (`ARCHITECTURE.md` 3.1).

**Slugs.** `workspaces.slug` is unique across all customers. A plain `slug_taken`
would reveal another customer's workspace name, so self-serve creation adds a
generated suffix, such as `sales-x7k2`. The CLI keeps exact slugs.

**Invitations.** A token is stored hashed and expires after 7 days. Accepting
requires a verified email that matches the invitation, so a forwarded link is
useless to anyone else. Accepting twice is a no-op. The control function emails the
link, and the web app also offers "Copy invite link".

**Removing a member.** Web access ends at the next request, and so do OAuth tokens
they granted (4.7). Agent keys belong to the workspace and keep working, and the
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
   │                         │ /account, /.well-known/oauth-authorization-server,
   │                         │ /.well-known/openid-configuration
   │                         ▼
   │                      control function ──► NAT ──► Google, email,
   │                      (Better Auth,                client metadata
   │                       retainer_control)
   │ /v1, /mcp, /app
   ▼
 api function (no internet, no Better Auth, retainer_app + RLS)
   │                         │
   └───► RDS Postgres ◄──────┘
```

- **Why the control function has internet.** Google sign-in and client metadata
  documents both need it, in the same process that writes to the database. Claude
  needs the second (4.7), so a design without internet would not serve it. A NAT
  gateway costs roughly $35 a month.
- **What stays isolated.** The api and consolidator functions keep no route to the
  internet. `docs/aws.md` needs its promise narrowed to those two.
- **Metadata routes.** OAuth clients look for the authorization server's metadata
  at the domain root, with the issuer's path appended
  (`/.well-known/oauth-authorization-server/account/auth`). Those root routes must
  reach the control function.
- **Rate limits on sign-in.** Better Auth counts in memory by default, which does not
  work across Lambda instances. Use its database storage, and set `trustedProxies`
  or `ipAddressHeaders` for API Gateway, since it otherwise trusts a header clients
  can set.
- **Container.** With `RETAINER_ROLE=all` everything runs in one process, including
  Better Auth. Self-hosters who want the separation run `api` and `control` apart.
- **Deploys.** `deploy.sh` also stops and starts `control`.

The cookie stays `SameSite=Strict`. Tested in Chrome: a magic link opened from
another site still sets it, and the app's own requests then send it.

### 4.7 MCP OAuth

Better Auth's `mcp()` and `cimd()` plugins are the authorization server, with the
JWT plugin signing access tokens. Claude's web app connected through them end to end
(section 12).

- **Registration.** Claude identifies itself with a client metadata document
  (`https://claude.ai/oauth/mcp-oauth-client-metadata`), which the server fetches
  from the internet, using the plugin's fetcher that pins the resolved address.
  Dynamic client registration stays on for other clients, rate limited. Whether
  Claude falls back to it when metadata documents are not offered is unknown.
- **Metadata.** A `401` from `/mcp` names the resource metadata in
  `WWW-Authenticate`. The api function serves that metadata, which is static.
- **Consent.** The authorize URL is opened from another site, so a `SameSite=Strict`
  cookie does not arrive. It redirects to our sign-in page, whose own requests carry
  the cookie and continue to `/app/oauth/consent`. The person picks a workspace there
  through the plugin's `postLogin` step, and `consentReferenceId` ties it to the
  consent. The page must not be framed (`frame-ancestors 'none'`). The test used one
  fixed workspace, so a real picker is still to build.
- **Tokens.** One-hour JWT access tokens (`at+jwt`, EdDSA) with the workspace as a
  claim, and rotating refresh tokens stored hashed. A rotated refresh token can be
  reused for 30 seconds by default, so that a retry can recover. We keep that.
- **Checking a token with no internet.** JWTs are not stored, and a valid signature
  says nothing about removal. So on every request the api function reads the public
  signing keys through `retainer_token_keys()`, verifies signature, issuer and
  audience, and then calls `retainer_token_access(subject, workspace, client)`, which
  returns the person's role only if their consent still exists.
- **The cap.** The request's scopes are the token's scopes intersected with that
  role's. Downgrading a person, removing them or revoking consent all apply at the
  next request.
- **Actor.** Always an `agent`, so the human-only rules apply. Its ID combines the
  client and the person, and its name reads like "Claude for Dana". In the test it
  used the client alone, which would make everyone's Claude the same actor.

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

Today every function connects with one login and switches role at connection start.
A hosted service gives each function its own login, with only what it needs.

| Function             | Logs in as         | Direct privileges                                                             |
| -------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `ops`                | Owner              | Migrations and the operator CLI; only the operator invokes it                 |
| `api`, `consolidate` | `retainer_app`     | As today, with no membership in any other role                                |
| `control`            | `retainer_control` | Account tables, `workspaces`, `api_keys`; can `SET ROLE retainer_app` to seed |

`retainer_control` has no `BYPASSRLS` and no DDL. It holds `retainer_app` with
`INHERIT FALSE, SET TRUE`, and RLS policies of its own on `workspaces` and
`api_keys`. It can still read tenant data by switching role, the same power the
api function has, so its code only does that to seed. Each role gets its own
secret. The test ran Better Auth under such a login and the api function under
`retainer_app` without problems.

The runtime role gets three `SECURITY DEFINER` functions beyond today's two:
`retainer_session_access`, `retainer_token_keys` and `retainer_token_access`.

The container keeps one URL by default, and an optional
`RETAINER_RUNTIME_DATABASE_URL` gives self-hosters the same separation.

### 4.10 The billing seam

`organizations.limits` holds quotas, and null means unlimited, so self-hosted
installs have no limits. Retainer enforces limits and does not know where they
come from. Plans, prices and Stripe code stay out of the open repo.

### 4.11 Sign-in methods, passkeys and MFA

| Method     | Protection                                                                 |
| ---------- | -------------------------------------------------------------------------- |
| Passkey    | Strongest: resists phishing, and uses the device plus a fingerprint or PIN |
| Google     | As strong as the person's Google account                                   |
| Magic link | As strong as their inbox                                                   |

**Passkeys** use `@better-auth/passkey`.

- A person adds one after a first sign-in by magic link or Google. Signing up with
  only a passkey stays off, because that first sign-in proves the email, and
  invitations rely on it.
- `userVerification` is `required`, so a device with no fingerprint, face or PIN is
  refused.
- Passkeys are tied to the domain (`rpID`). **Choose the permanent domain before
  anyone registers one**, because changing it breaks them. Do not offer them on the
  API Gateway URL.
- They make no outbound calls and add no need for internet.

**Email sign-in stays on after someone adds a passkey.** Adding a passkey does not
close the inbox as a way in. That keeps recovery simple for a lost device: sign in by
magic link and remove the old passkey. A setting to turn email sign-in off can come
later if teams ask, with a process for people locked out.

**No MFA at launch.** Better Auth's two-factor plugin only challenges password
sign-ins. Its docs say magic link, social and passkey sign-ins "are not gated by 2FA
by default", and its code confirms it. Turning it on would look like MFA and protect
nothing. Gating those methods means custom hooks and a session state the api function
must also check, which is security-critical code we should not own yet. A team that
needs stricter rules can later get an organization setting such as "passkey or Google
only".

MFA does not protect API keys on any provider. Scopes and revocation do.

### 4.12 Keeping Better Auth patched

- Pin exact versions of `better-auth` and every `@better-auth/*` package, which
  must move together.
- Follow its security advisories and update within days. Twelve advisories were
  published on one day, November 3, 2026.
- Load only magic link, Google, JWT, passkey, `mcp()` and `cimd()`. SSO and SCIM have
  some of its worst advisories, so add them only when a customer needs them, and lock
  down who can register a provider.
- Never install its `dash()` plugin, which calls Better Auth's own servers.
- Only the control function loads it, which limits what any bug can reach.
- Keep session cookie caching off, since revoked sessions can stay active until a
  cached cookie expires.

## 5. Frontend design

Plain words throughout, per the web app's rule. No screen says "RBAC", "scope",
"OAuth" or "tenant".

- **Sign in.** "Continue with Google", an email box for a magic link, and "Use a
  passkey". Key mode keeps today's screen.
- **First run.** Your name, then "Name your workspace", then the existing flow. The
  word organization does not appear.
- **URLs.** `/app/w/<slug>/...` in accounts mode, and `/app/...` as today in key
  mode. The router's base path is computed at startup from the location.
- **Switching workspaces** is a full page load. It clears cached data and needs
  no router or query changes, and a tab stays on its workspace. The switcher
  appears when a person has more than one.
- **Session state.** Inside a workspace, `Session` stays as it is, so scope checks
  and `canMutate` are unchanged. `GET /account` supplies the rest.
- **Your account.** "Add a passkey", and a list of passkeys to rename or remove. After
  a first sign-in, offer it once. Explain plainly that email sign-in still works.
- **Members** (workspace settings). Everyone with access and their role, each
  explained with the plain words in 4.3. While an organization has one workspace,
  inviting happens here too.
- **Organization** appears in settings only once there is a second member or a
  second workspace.
- **Agents** (workspace settings). Create and revoke keys, shown once with
  copyable connection instructions, and see who created each. OAuth connections appear
  here too, and can be revoked.

The Better Auth browser client with the passkey plugin adds about 16 KB gzipped.

## 6. Implementation order

Each step lands with its tests and can ship alone.

1. **Credentials (4.9).** Separate logins for each function. This is worth doing
   whether or not the rest goes ahead.
2. **Model.** Our account tables, the `Default` organization, the role tables in
   `shared`, the CLI.
3. **Sign-in.** Better Auth with magic link and Google, the control function, the NAT
   gateway, `authenticate`, the workspace header, URLs, Terraform. Choose the
   permanent domain here.
4. **Self-serve.** Workspace creation, members, invitations, keys in the web app.
5. **Passkeys.** Then try real devices by hand.
6. **MCP OAuth,** including the workspace picker.
7. **Hardening.** Rate and quota limits, scheduled deletion, a staging deployment
   (a second `name`), a larger instance with `db_multi_az` on, and a practised
   restore. The legal items in section 9.
8. **Private beta**, then billing when people want to pay.

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
- `ARCHITECTURE.md` 7.2 stays true apart from the three new `SECURITY DEFINER`
  functions (4.9), and a new test fails on any function outside the list.
- No generic permission tables or policy engine until a rule needs one.

## 8. Tests

In the layers of `ARCHITECTURE.md` section 12.

| Layer       | Proves                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Effective role, the role-to-scope tables, slug suffixes, OAuth scope capping, cookie signature checks                                                                                                                                                                       |
| Database    | The runtime role cannot read account or Better Auth tables; `retainer_session_access` answers only for its own token; expired and revoked sessions; the composite foreign keys; deleting an organization with workspaces fails                                              |
| Concurrent  | Two owners removing each other leave one; two first sign-ins make one user; two accepts of one invitation make one membership; two first workspaces make one organization                                                                                                   |
| API         | Every role against every route; an API key on `/account` is refused; a session with a workspace it cannot access gets 404; a forged cookie and a raw token without its signature get 401; header mismatch on a bearer request gets 400; removal applies at the next request |
| Contract    | Real Better Auth cookies pass the api function's check, so an upgrade that changes the format fails here; the api function imports no Better Auth; no unlisted `SECURITY DEFINER` function exists                                                                           |
| Credentials | The runtime login cannot `SET ROLE` to the owner, and `retainer_control` holds no DDL rights                                                                                                                                                                                |
| Agent       | An OAuth client registers both ways, is consented, connects and calls tools; its token ends when the person is removed or the consent is revoked                                                                                                                            |
| Browser     | Sign up, name a workspace, invite someone who accepts, each role sees the right buttons, two tabs on two workspaces write to the right ones; passkeys through Chrome's virtual authenticator: add, sign in, replay fails, another site fails, another user cannot remove it |

Every test uses real Postgres with a fresh cloned database. Tests capture magic links
instead of sending email, and no test needs the internet.

Claude's web app cannot run in CI. Repeat that connection by hand on staging before
launch and after each Better Auth upgrade that touches OAuth.

## 9. Open questions

**To confirm before starting:**

1. **Accounts live in the open repo (AGPL).** The auth path needs them, and
   self-hosters benefit. Billing stays private. This reverses the line in
   `ARCHITECTURE.md` 7 that puts provisioning and SSO outside the repository.

**Later:**

2. **Two sign-ins at once.** Two different magic links for a new email, opened at the
   same instant, make one user as they should, but the second person gets a 500. It
   should become a retry or a clear message.
3. **Agent write formats.** In the test Claude called `upsert_record` twice, then
   warned that names are `{first, last}` and emails `{primary, additional[]}`. The
   failed call's error was not logged, but the tool descriptions may need to state
   these formats more clearly.
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
   needs the rights to any outside contributions checked, so add a contributor
   agreement before the first outside pull request.

## 10. Acceptance

- A new person signs up, names a workspace and connects an agent, with no operator.
- They add a passkey and sign in with it on the same and on a second device.
- They invite a colleague, who accepts and sees only the workspaces they were
  given, with the right buttons for their role.
- Removing that colleague ends their web access and OAuth tokens at the next
  request, and agent keys keep working.
- No agent credential can create a key, a member or a workspace.
- Claude's web app connects to `/mcp` over OAuth on the real deployment.
- One tenant's traffic spike gets `429`s while others keep working.
- The api function's database login cannot become the owner.
- A self-hosted install that sets nothing behaves exactly as before.

## 11. Documents to update

Update these when the work lands, not before:

- `ARCHITECTURE.md`: section 7 (sessions, organizations, roles, the new functions)
  and 7.1 (self-serve alongside the CLI).
- `CLAUDE.md`: "Every write carries an Actor, taken from the API key" becomes "from
  the credential".
- `FRONTEND.md`: section 4.
- `docs/aws.md`: the control function, NAT gateway, credentials, the narrower "no
  internet" promise, and the OAuth limit it lists.
- `docs/self-hosting.md`: `RETAINER_AUTH_SECRET`, email and Google settings,
  `RETAINER_RUNTIME_DATABASE_URL`, the new CLI commands.
- `docs/rest-api.md`: `/account`, `X-Retainer-Workspace`.
- `docs/agents.md`: connecting over OAuth.

## 12. Test results

A throwaway test on November 6, 2026 ran Better Auth 1.7.18 against real Postgres 17,
real Retainer routes and MCP tools. It was deleted afterwards.

| Question                                | Result                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does it fit our stack?                  | Yes: Drizzle with `postgres.js`, TypeScript 7 with the repo's settings, `pnpm db:generate`, and a login limited to its own tables                                                           |
| Can the api function check a session?   | Yes, with no Better Auth import and no access to its tables, running real `/v1/me`, `/v1/schema` and scope checks under RLS                                                                 |
| Are session tokens hashed?              | No (4.4). A raw token without the signature was refused by both Better Auth and the api function                                                                                            |
| Can tokens be checked with no internet? | Yes. No outbound calls for magic link, sessions, dynamic registration, OAuth, MCP or passkeys                                                                                               |
| Does access end immediately?            | Yes, for downgrade, removal and revoked consent, at the next request                                                                                                                        |
| Do real clients work?                   | The official MCP client passed with dynamic registration and metadata documents (fetch stubbed). Claude's web app connected through metadata documents, then read schema and wrote a record |
| Does `SameSite=Strict` work?            | Yes, in Chrome: a magic link and an OAuth flow opened from another site both succeeded                                                                                                      |
| Do passkeys work?                       | Yes, in Chrome's virtual authenticator: adding, signing in, replay refused, another site refused, another user refused, lost-device recovery                                                |
| What did it fail?                       | Two different magic links opened at once: one user, but the second gets a 500 (section 9)                                                                                                   |

The server code loads in about 130 ms on a laptop and bundles to 3.3 MB (565 KB
gzipped), so cold starts should not be a concern, though Lambda will be slower.

**Not tested:** Google sign-in; real Lambda and API Gateway; passkeys on real devices
and synced passkeys; the rate-limit plugin; a workspace picker at consent;
`SET LOCAL ROLE` seeding by `retainer_control`; whether Claude falls back to dynamic
registration.
