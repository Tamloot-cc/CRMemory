# SurrealDB backend migration spec

Date: November 5, 2026. Status: **implementation plan; not implemented**. A
spike on the pinned release and on Cloud (section 12) has revised the
transport, write protocol, schema evolution, rollup storage and search sections.

The design decisions in this document are settled for implementation. A phase
whose checks disprove one records the change here before continuing. The spec
covers a complete SurrealDB backend on a branch alongside PostgreSQL `main`. It
does not authorize replacing `main`, offering a hosted service on SurrealDB or
deploying over an existing database.

Baseline: `main` at `e5ec9f6`, including PR #26's schema protection, event
records, collection and polymorphic relations, rollups and timeline, and PR
#27's upgrades of existing workspaces to new built-in definitions. Until the new
backend lands, [ARCHITECTURE.md](../ARCHITECTURE.md) describes implemented
behavior. [Experiment results](surrealdb-experiment-results.md) describe a
limited prototype, not this migration's completion.

## 1. Product goal

Retainer is a CRM whose primary consumer is an AI agent. An agent discovers the
workspace schema, creates useful structures, resolves records, logs evidence,
asserts changes and retrieves enough context to act. A person can inspect the
CRM, correct information and approve changes through the existing web app.

Example: an agent reads a payment email, logs an Email event, creates or finds
its Invoice and Company, and asserts the invoice's status with that event as
evidence. Another agent retrieves the company context and can explain the status
from its source. Retracting the email recomputes the invoice; concurrent writes
cannot silently discard either agent's work.

Success is that complete workflow through MCP and REST, with a simpler native
graph implementation and predictable behavior. A shorter database query alone
is insufficient. The agent must not need Studio, database credentials, raw
SurrealQL or knowledge of physical table names to use Retainer.

## 2. Decisions and deliberate limits

| Area                | Decision                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch              | Start `codex/surrealdb-v1` from the PostgreSQL baseline. Keep `main` on PostgreSQL; keep the experiment branch as research.                                                                                                                                                                                                                |
| Runtime storage     | SurrealDB only, including auth/catalog data, views, jobs and operation receipts. No PostgreSQL sidecar or runtime backend switch.                                                                                                                                                                                                          |
| Deployment baseline | Single-node Community SurrealDB with persistent SurrealKV; start from the tested 4.0.0 image digest in the experiment Compose file.                                                                                                                                                                                                        |
| Cloud               | Use the same server through the supported database HTTP API. Cloud is a separate verification target, not the source of truth for a reproducible local release. Earth spent 160–250 ms of server-side time per request (section 12), so the serialized write protocol targets a self-hosted server, where a write transaction took 2–8 ms. |
| Topology            | One Retainer process (`RETAINER_ROLE=all`) per deployment, held to one by a catalog lease (section 9). `main`'s AWS Lambda deployment, separate API/worker processes and replicas are not supported on this branch.                                                                                                                        |
| Tenancy             | One catalog database and one database per workspace, under a Retainer namespace.                                                                                                                                                                                                                                                           |
| CRM storage         | One typed table per object, one native relation table per owning relation field, shared assertion/fact/event-link tables within each workspace.                                                                                                                                                                                            |
| Metadata            | Retainer metadata remains authoritative and generates database definitions, tool discovery and presentation.                                                                                                                                                                                                                               |
| Policy              | TypeScript owns validation, claim ranking, review, schema approval and lifecycle policy. Database constraints supplement it.                                                                                                                                                                                                               |
| Concurrency         | Intentionally serialize writes per workspace using a local queue plus a database revision check. Read only affected data, not the whole workspace.                                                                                                                                                                                         |
| Transport           | HTTP `/rpc` with CBOR parameters and token authentication. No JSON-RPC parameters, no per-request password authentication (section 9).                                                                                                                                                                                                     |
| Rollups             | Store one-hop rollup attachments at write time, so a record's history is an indexed page rather than a per-source fan-out at read time (section 5).                                                                                                                                                                                        |
| Interfaces          | Preserve existing REST/MCP/SDK behavior and the web app. Add one bounded traversal operation after core parity.                                                                                                                                                                                                                            |
| Intelligence        | External agents make model calls. Retainer performs no extraction, embeddings or model-based maintenance. Agent Memory is outside this migration.                                                                                                                                                                                          |

There is no production customer-data migration requirement. Seed fresh test
workspaces through Retainer's public tools; do not build a general PostgreSQL
importer, dual writes or backward-compatible storage adapters. Existing
PostgreSQL databases and Cloud experiment fixtures are separate resources.

Preserve the guarantee that a workspace's own schema changes retain its data.
Retainer's early development status does not waive that guarantee.

The SurrealDB server license (BSL 1.1) restricts a "Database Service" in terms
that may cover customer-controlled schemas, which is Retainer's model
([evaluation](postgres-surrealdb-evaluation.md#license)). Request SurrealDB's
written answer for the intended hosted service in Phase 0. Branch work may
proceed while it is pending; replacing `main` or offering a hosted service may
not.

## 3. What carries forward

Port the behavior in ARCHITECTURE.md and the tests merged through PR #27:

- Runtime-defined objects and fields, stable universal IDs and field keys,
  protected base identities, templates and destructive-change approval.
- Upgrading existing workspaces to a release's built-in definitions: match by
  universal ID whatever the status, add only what a workspace never had, protect
  listed elements, skip and report conflicts, and record a definitions digest
  so current workspaces are skipped (ARCHITECTURE.md 3).
- Public record IDs and existing composite value shapes. Database IDs and
  native numeric/date types are converted at the boundary; they do not leak into
  the MIT SDK or change JSON precision, money units or null/omitted semantics.
- Assertions as the source of current values, with `user > integration > agent
  > system`, source-derived observation time and deterministic tie-breaking.
  Pending/rejected/retracted claims cannot create accepted values or edges.
- Whole-set collection assertions, allowed target types, read-only inverses,
  merge resolution, normalized identifiers and explicit uniqueness claims.
- Event identity and retry rules, immutable initial-value comparison, specialized
  participant/about links, custom event fields, source retraction, facts and
  hidden internal notes.
- Explicit historical attachment versus current relation grouping, configured
  one-hop event rollups, deterministic `via`, deduplication before page limits,
  unified timeline and existing context priorities/budgeting.
- Review, soft deletion, hard erasure and suppression, including historical
  assertions and initial event values. Preserve the current distinction between
  participant and about links during forgetting.

This is not a redesign of collection mutation or claim governance. Association
properties, member-level add/remove assertions, assertion premises and exact
historical winner snapshots remain deferred. A relationship needing its own
fields can still be an ordinary object, such as Deal Stakeholder.

## 4. Catalog, identities and authorization

The catalog stores workspaces, their database routes and provisioning state,
hashed Retainer API keys, scopes, actors and revocation. CRM records never live
there. A workspace route is derived from authenticated key lookup, never from a
request-supplied namespace/database name.

Workspace creation is a small resumable sequence: catalog entry `provisioning`,
database/core definitions, runtime principal/access method, base template,
catalog entry `active`. Only active workspaces receive normal requests. There
is no cross-database transaction or distributed provisioning coordinator.
Provision one workspace at a time: on Cloud, a workspace-sized schema took 11 s,
and eight parallel provisions dropped their connections (section 12).

Retainer API keys and browser sessions keep their existing external behavior.
The server checks key revocation on every request and derives the actor from
that key. Short-lived internal database sessions do not replace this check.
Already accepted requests are not promised cancellation when a key is revoked.

Use database-scoped **record-access JWTs** for workspace runtime access, signed
by Retainer with a server-side key pair (rotation below). Tokens bind namespace,
database, access method and the backend principal. Keep them inside the server;
refresh them on expiry. No external identity provider or per-workspace secret
vault is needed. The catalog client is separately scoped and confined to
auth/routing.

In a workspace database, every table grants the backend principal `FULL`
permissions. The isolation boundary is the token's database and the refusal of
definitions to record users, both verified in section 12; per-table rules would
add generated surface whose failures are silent. In the catalog, the runtime
client may read key hashes, scopes, actors, revocation and workspace routes,
and maintain the process lease (section 9). Workspace and key management use
the administrative client, as the operator CLI does today. Definition and
provisioning operations use that separate administrative client behind the
validated schema/provisioning code paths. Never fall back to administrative
credentials after a runtime permission error.
Plain `TYPE JWT` system access is not an equivalent substitute for record
access: system identities bypass table/field permissions [S2, S3].

On the pinned release, a record-access token is confined to the database named
in its claims: a request header naming another database is ignored, `USE DB` is
refused, and definitions, `REMOVE` and `INFO` are refused. Refused data
operations do not fail: `SELECT`, `CREATE`, `UPDATE` and `DELETE` return an empty
result with status OK, and an enclosing transaction still commits. A table
defined without a permissions clause (which defaults to none) therefore
silently drops writes unless the write protocol checks their effects (section 6).

Each signing key has an ID, and each workspace database has one access method
per accepted key, named after it (`backend_<key id>`). Rotate a key in three
steps:

1. Configure the new key as current and keep the old one listed as previous.
2. Upgrade each workspace through the same runner as other fixed-table
   upgrades (section 7). The runner defines the new access method and records
   it in `workspace_state`; the server signs with the newest key a workspace
   has.
3. Once every workspace records the new key, remove the old access methods
   and drop the old key from configuration.

For a compromised key, the worker's pass removes the old access method in the
same upgrade that adds the new one, rather than after every workspace has
moved. Requests for workspaces it has not reached wait for their upgrade.

Provisioning/schema administration uses a configured namespace-scoped system
credential; the server signing keys are separate. All of them stay in
deployment secret configuration. A manually brokered Cloud token is suitable for
experiments, not a long-lived application's credential or automatic
credential-refresh strategy.

API/MCP clients continue to call Retainer, not the database. Runtime DB sessions
are trusted backend identities, not a claim that every business rule is enforced
against a malicious database owner. Actor attribution and domain policy still
flow through the single Retainer writer.

## 5. Physical model

Native names use immutable IDs, not business names: object tables derived from
object universal IDs, relation tables from owning field IDs, and scalar fields
from permanent field keys. Renaming Company or its fields changes metadata and
discovery, not physical identity or saved-view references.

| Workspace storage                   | Responsibility                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object table per type               | Typed current scalar projection plus protected identity/lifecycle columns; event types use the same assertion and field machinery.                                      |
| `record_directory`                  | Resolve a public UUID to its object/native record ID, liveness and merge survivor without scanning every object table.                                                  |
| `field_assertions`                  | Canonical claimed values, actor, source, status and ranking inputs; use public identities for portable values.                                                          |
| Relation table per owning field     | Accepted native edges derived from its winning assertion, with the assertion ID for provenance.                                                                         |
| `event_identity`                    | Shared immutable event core, deduplication across event types, initial-assertion references and chronological indexes; no duplicate raw identity on object projections. |
| `event_links` / `event_attachments` | Canonical specialized links, including unresolved participant handles; native attachments project only resolved links, referring back to the canonical entry.           |
| `rollup_attachments`                | Derived one-hop rollup entries: target record, event, event time, rollup field and source record. Indexed by target and time; rebuilt from attachments and edges.       |
| Identifier tables                   | Normalized lookup entries and a separate unique-claim table, retaining claims through soft deletion.                                                                    |
| Fixed metadata/memory tables        | Object/field/schema metadata, facts/sources, views/lists, suppression, jobs, receipts and workspace state.                                                              |
| `search_documents`                  | Rebuildable text and identifier-search projection for visible records, events and facts.                                                                                |

Define object tables as schemafull. Map existing composites to their current
typed nested shapes; arbitrary content is confined to fields explicitly typed
as JSON. Native projections may be absent when no eligible assertion exists;
logical required-field validation remains consistent with existing write rules.
Compile explicit null and missing values separately: native `option<T>` alone
is not a substitute for a nullable JSON value; `option<T | null>` keeps the two
apart on the pinned release. A winning null assertion remains an explicit clear,
while absence means no eligible value. Collections keep the existing distinction
between an empty set and a rejected null.

Relation tables use enforced endpoints, allowed native target types, uniqueness
of source/target membership and an additional unique source index for
single-target fields. Expose inverses by reading the same edges. Native
constraints must reject invalid direct edge inserts, not only normal API calls.
On the pinned release, an `ENFORCED` relation table with a unique `(in, out)`
index rejects missing targets, wrong target types, duplicate pairs and a plain
`CREATE` into the relation table. A schemafull table rejects undeclared fields
rather than dropping them.

The unique-claim table contains only actual uniqueness reservations, with a
unique `(field ID, canonical typed value)` index; nonunique candidates stay in
ordinary identifier lookup storage. This avoids assuming support for PostgreSQL
partial indexes. Preserve normalization, duplicate-create rollback/retry and
ambiguous-match responses; a native scalar email index is not sufficient.

Assertions, current values, identifier claims, directory entries and edges change
atomically. Rebuilds cannot resurrect retracted, deprecated or forgotten data.

Event identity has a shared unique `(channel, external ID)` reservation for
externally identified events, independent of their object table. Unresolved
participants remain valid canonical link entries without a native edge; resolving
them creates the attachment projection atomically. Keep initial-assertion and
merge-alias retry comparison behavior rather than adding another raw event blob.

Store one-hop rollups instead of computing them per read. PostgreSQL reads each
source record's newest page through a lateral join. The closest bounded
SurrealDB form, one indexed statement per source, measured 259 ms for 1,000
source records and 1.4 s for 5,000, against 5.1 and 22 ms in PostgreSQL. An `IN`
list over the sources scanned the whole table, and per-source subqueries inside
closures scan it once per source (section 12). So
whenever an event attaches to a record with a configured rollup field, or such a
relation edge is created, removed or merged, the same transaction writes or
removes the matching `rollup_attachments` entries. A record's history then reads
two indexed streams, direct attachments and rollup entries; a page of a single
stream measured about 2 ms at 50,000 events.

Moving a source record to another target rewrites its events' entries, a cost
bounded by that record's events. Handle it like the other large operations in
section 6: one atomic transaction or a clean failure. Liveness, visibility and
event-type filters still apply at read time, so a deleted source or hidden type
does not need an eager rewrite. Recomputation rebuilds entries from attachments
and edges and must agree with them, as for other projections.

## 6. Write protocol: simple and intentionally coarse

Each workspace has `workspace_state` with a revision, published schema version
and mode (`active` or `schema_update`). Every workspace mutation, including
review, merge, retraction, forgetting, derived-state repair and worker changes,
uses this protocol. No module writes around it.

1. Enter the process-local workspace write queue. Do only database work while
   holding it, never model or third-party service calls. Other workspaces and
   ordinary reads proceed. A caller that waits longer than the queue limit
   (default 10 s) gets a retryable `workspace_busy` error, shaped like
   `schema_busy`. Record queue wait and hold time for every operation.
2. Read the revision first, then the published schema and the operation's
   records, sources, identifier candidates and other dependencies. Each request
   is its own snapshot, so several reads may see different states; the revision
   check in step 4 rejects a plan built on them. Before returning a domain
   error found while planning (not found, ambiguous identifier, failed
   precondition), re-read the revision. If it changed, replan rather than
   report an error that may come from a torn read.
3. Compute the mutation in TypeScript. Fetch only dependencies needed for it;
   remove the experiment's full-workspace snapshot/recomputation approach.
4. Submit one explicit transaction: verify the revision/mode/schema still match,
   increment the revision, write claims and all affected projections, and record
   the operation outcome. A mismatch or database conflict rolls back the batch.
   Every multi-statement write is wrapped in `BEGIN`/`COMMIT`: outside a
   transaction, a failed statement does not stop the statements after it. Each
   write statement checks the number of records it affected and `THROW`s on a
   mismatch, because a refused or misdirected write returns an empty result
   with status OK (section 4).
5. Retry from a fresh planning snapshot on a recognized conflict, at most five
   attempts with short jittered backoff. Return a structured retryable conflict
   if exhausted. Never replay a partially observed plan. The pinned release
   reports `Transaction write conflict. This transaction can be retried`;
   recognize it through one classifier in the transport module.

Revalidate caller preconditions such as expected `updated_at` on every attempt;
a conflict retry must not turn stale intent into an unconditional overwrite.
Keep allocated identities and server-assigned direct observation times stable
for that operation across retries.

All application writers touch the same workspace state record, so an intervening
write invalidates a stale plan, including predicate decisions such as identifier
absence. This is a protocol requirement, not protection supplied by registering
only the record IDs a query happened to return. SurrealDB conflict behavior and
explicit-transaction retries must be tested on the chosen engine [S1].

This intentionally sacrifices parallel writes within one workspace for a small,
auditable implementation. It replaces the earlier recommendation to design
fine-grained coordination immediately. Optimize only after measured queue wait
or conflict rates show a real problem; do not introduce distributed reader/writer
locks, multi-node coordination leases or serializable-engine dependencies in
this phase. The single-process lease (section 9) only detects a second process.

For potentially large merge/retraction/forget operations, gather dependencies
before the commit and retain one atomic business transaction. If a tested engine
limit is exceeded, fail without partial erasure or partial retraction. Do not
silently turn these into eventually consistent chunked jobs.

## 7. Schema evolution and interrupted operations

Keep the existing apply/propose/approve rules and stable IDs. Compile approved
metadata into physical definitions; do not let agents submit raw DDL.

Definitions are transactional on the pinned release: a `DEFINE` commits with the
data writes and revision increment around it, and a failure rolls all of it back
(section 12). An additive change with bounded physical work goes through the
normal write protocol as one administrative transaction, with no
`schema_update` mode. Such changes include a new field, object table or relation
table. That transaction verifies and advances the revision, applies the
definitions, publishes metadata and increments the schema version. Agents adding
fields during ingestion therefore do not pause the workspace.

Indexes are the exception. On Cloud (Earth), a unique index defined inside an
explicit transaction accepted duplicates, while the same index defined on its
own was enforced (section 12). So define every index as its own statement,
outside a transaction, before the publishing transaction. A new table and its
indexes are not yet in published metadata, so nothing writes to them and no
pause is needed. Then verify each index before publishing: `INFO FOR INDEX`
reports `ready`, and for a unique index a duplicate probe inside a cancelled
transaction is refused. Provisioning follows the same rule.

For changes whose physical work depends on existing data, notably index builds
and required/unique checks over existing records, acquire the workspace queue
and atomically set mode to `schema_update`, reserving a schema-change ID and
advancing the revision. Existing stale writes must then fail their commit check.
While this mode is set, normal writes return a retryable `schema_busy` result;
reads use the previous published schema.

Release the local queue between physical steps so callers can observe
`schema_busy` promptly. Only the reserved schema-change ID may advance that plan;
competing schema requests are refused. Catalog key/provisioning mutations use
their own catalog transactions and constraints, not a cross-database write gate.

Apply and verify a short persisted list of physical steps, then atomically
publish metadata, increment schema version and restore active mode. Keep the old
published metadata separately from the desired plan. On restart, resume the
recorded change before admitting writes. Provisioning uses the same step runner.
No separate migration service is needed.

Adding fields/types and building indexes must leave the old published model
readable. Existing required/unique-field checks run while writes are paused.
Deprecation retains assertions and physical fields/tables; no eager destructive
drop is needed. Type, target and multiplicity changes continue to require a new
field. Fail a plan safely if it cannot preserve these rules.

Every step compares actual and desired definitions. `IF NOT EXISTS` alone does
not verify equivalence. The catalog records an internal schema revision for
fixed tables. Each workspace records three things: its fixed-table revision, its
business schema version, and the definitions digest of the built-in
definitions it was last fully upgraded to (section 3).

At start, the worker brings each workspace up to date, one at a time, using this
runner: fixed tables first, then built-in definitions, then signing-key access
methods. A request for a workspace the worker has not reached yet triggers that
workspace's upgrade first. Nothing else schedules upgrades.

A failed fixed-table or access-method upgrade is reported. Because the code
expects the new tables, that workspace's requests get a retryable error until
the upgrade succeeds. A failed built-in definition upgrade behaves as on
`main`: the workspace keeps its current schema and keeps running, conflicts are
skipped and reported, and the next start retries the upgrade.

Validate the logical plan before pausing. On a failed physical step, record its
error and progress. Restore active mode only after verifying the previous
published model and its constraints remain usable; otherwise retain the paused
state for explicit repair/resumption. Do not drop retained fields to undo a plan.

Every public mutation gets an operation ID. Callers may provide an idempotency
key. As on `main` (`idempotency.ts`), its scope is the workspace and operation
kind, so a retry after a key rotation or from another of the workspace's keys
still deduplicates. Its canonical request digest detects reuse with different
inputs. A completed
receipt commits with the mutation. Retries use stable allocated IDs and check
the receipt inside the commit transaction before applying effects.

Return the receipt's original result for matching retries. Retain completed
receipts for 24 hours and expose a scoped `get_operation` REST/SDK/MCP read.
Requests without a caller key are not promised deduplication across client
retries. A lost response has an unknown outcome until resolved: timeout is not
rollback, as the Cloud experiment demonstrated. Do not indiscriminately retry
timeouts as though they were confirmed transaction conflicts.

`get_operation` accepts either the operation ID or the idempotency key plus
operation kind. It is scoped to the authenticated key's workspace, like every
other read: every key in a workspace sees all of its records (ARCHITECTURE.md
7.2). A missing receipt means `not_observed`,
not confirmed rollback: the original request may still commit. Repeating the
same idempotency key must remain safe in that case. SDK retries reuse their
original key; MCP guidance tells agents to retain it before a write.

Receipts, job payloads and schema-plan errors must not become extra copies of
erased CRM content. Store minimal references/results, sanitize on erasure, and
never expose an old receipt that restores forgotten data. Retained receipts
whose original result was erased return an explicit erased-result status.

## 8. Reads, search and the agent contract

Preserve discovery, identifier resolution, structured filters, sorting,
pagination, reference hydration, review and provenance before adding new tools.
An agent must distinguish `applied`, `superseded`, `pending_review`, conflict and
unknown outcome. Responses include the operation ID where relevant; schema
discovery includes schema version, stable IDs, writable directions, cardinality,
target types and protection. Existing names remain accepted at API boundaries.

Implement rollups/timeline/context with indexed, keyset-paginated candidate
streams. Deduplicate before limits and counts. Do not load all related events
into an application array or a SurrealQL intermediate and then truncate. Merge
bounded streams and fetch another bounded page when duplicate removal needs it.
Preserve current visibility and cursor semantics; do not promise historical
snapshot reads. High-fan-out query plans are an acceptance condition, not a
performance claim inferred from graph syntax.

On the pinned release, an indexed `WHERE … ORDER BY … LIMIT` becomes an index
scan that stops at the limit only when the filter value is a literal or a
top-level parameter. The same statement inside a `.map()` closure or a `FOR`
loop, or filtered by an inline subquery, becomes a table scan; a 100-source
closure took 82 s over 150,000 attachments. An `IN` list never stops at the
limit: the planner either scans the table, as it did for lists of 100 to 5,000
sources, or looks up every listed record's entries before sorting. Generate one
top-level statement per stream from validated identifiers. Each read shape gets
a test that asserts its `EXPLAIN` operator, so a planner change or a rewritten
query cannot silently fall back to a scan.

Use a shared native full-text/BM25 index over `search_documents`, plus explicit
normalized identifier lookup. Reuse normalization and preserve existing search
syntax, prefix/typeahead, accent and domain behavior through contract fixtures.
Label/exact identifier precedence must remain useful; PostgreSQL numerical
scores need not match. Internal notes, deprecated types and retracted material
stay out of public search. Tokenization differences are documented with examples,
not hidden behind embeddings or an LLM fallback.

The spike settled the analyzer design. An edge-n-gram analyzer (`blank, class,
punct` tokenizers; `lowercase, ascii, edgengram` filters) provides prefixes,
accent folding and email/host domain words through the index, as do `AND`,
`@OR@` and negation. A second, exact-word index ranks words as typed above
prefix matches. Quoted phrases are not supported natively: match every word
through the index, then check the phrase against the folded text. Fuzzy label
matching ("Dana Levy" finds "Dana Levi") and the consolidator's similar-name
merge suggestions use a trigram index (`ngram(3, 3)` with `@OR@`) for
candidates, reranked by `string::similarity::jaro_winkler`. Its results and
threshold differ from `pg_trgm`'s similarity; fix them with contract fixtures.

Add one operation, `traverse_records`, to REST/MCP/SDK after parity. It accepts
start record IDs and an explicit path of owning/inverse relation fields or
participant/about attachment steps. Validate paths through visible schema; return
records, paths and supporting assertion/event IDs. This supports questions such
as who connects a deal's decision-maker to someone we have met.

Use `POST /v1/records/traverse`, SDK `traverseRecords` and MCP
`traverse_records`. The request has `starts` and `path`; each step names a
`field` or built-in `link` and an `in`/`out` direction. Resolve inverse names to
their owning field/direction. The response includes schema version, ordered
paths of record references and step evidence, examined-edge count and truncation
reason. Select/filter start records through existing `query_records`; do not
add a second general filter language to traversal.

Initial hard caps: 20 starting records, three steps, 500 examined edges total and
50 returned paths. Apply storage-side limits at each expansion and count examined
edges, including discarded ones. Return explicit truncation/budget information;
fetch indexed adjacency windows before applying non-indexed predicates. Each
expansion uses top-level statements per frontier record, as above, never a
closure or `IN` list over the frontier. A
`LIMIT` after scanning an arbitrary filtered graph does not satisfy the budget.
Do not imply completeness when capped. Use deterministic ordering, without a
general traversal cursor in v1. It does not change timeline rollup depth. No
arbitrary SurrealQL, natural-language query compiler or unrestricted recursion.

## 9. Jobs, transport and operations

Keep the deterministic consolidator and existing maintenance behavior in the
single application process. Persist pending jobs, attempts and completion in the
owning workspace and make handlers idempotent. Enqueue jobs with the originating
mutation where needed. On restart, resume unfinished work; use a simple polling
worker. Live subscriptions and database triggers do not replace durable jobs.

Use the HTTP `/rpc` endpoint with CBOR encoding for request-scoped reads and
complete transaction batches; the official JS SDK's HTTP engine qualifies. Do
not pass parameters as JSON-RPC: on the pinned release, strings such as
`INV:2026`, `Order:12345` and `2026-11-05`, and UUID-shaped text, arrive as
record IDs, datetimes and UUIDs, including inside nested objects. Such a value
fails a string field and is stored as the wrong type in a flexible one. `/sql`
query-string variables are strings only. Pass every caller value as a CBOR
parameter, with explicit tags for datetimes, record IDs and decimals; generate
identifiers only from validated metadata; never interpolate caller text as
SurrealQL. Authenticate with tokens, never per-request passwords: Basic
authentication cost 48 ms per request locally, against 1.4 ms with a token.
Check both HTTP status and every statement result. Keep transport/auth/retry
code in one module. Do not depend on the currently failing Earth instance MCP
forwarding route or add a WebSocket requirement in v1.

One process runs per deployment. At start, the server writes a lease to the
catalog: process ID, a heartbeat every 10 s and expiry after 30 s. It refuses
to start while another live lease exists, and it releases the lease at
shutdown. A process that cannot renew its lease stops admitting writes and
exits.

The lease only detects a mistaken second process, such as an overlapping
deploy or a separately started worker. It is not coordination. Correctness
across processes still rests on the revision check, which holds even if a
stalled process outlives its lease. Workspace upgrades, schema-plan
resumption and job resumption run only under the lease.

Local development/CI runs a pinned persistent SurrealDB image and requires no
Cloud credentials. Cloud checks use an isolated new workspace, never overwrite
the existing experiment. Record actual `/version` output, engine/edition where
known and capabilities; management labels are not sufficient. The earlier Earth
endpoint reported `4.0.0-nightly`, so local results do not certify its behavior.

Backup/restore includes the catalog, workspace databases and required secret
configuration, preserving logical workspace IDs and suppression keys. Practice
restoring into an isolated instance and verify key routing and recomputation.
For this single-process version, stop writes and drain the queues before taking
the catalog and workspace exports; no online cross-database snapshot protocol.
Keep secret backups in deployment secret storage, outside database export reports
and Git. A small documented procedure and restore check are sufficient; do not
build a backup orchestration service.
Do not derive suppression identities from a physical database name that changes
on restore. Preserve the existing suppression-key lifecycle and domain separation.

Erasure tests inspect current rows, all Retainer-readable history, search,
assertions, event initial values, receipts and job payloads. Check native version
retention on the supported engine and document backup/log retention separately;
do not claim physical removal of storage pages from a successful DELETE.
Database version/time-travel APIs are not exposed to CRM consumers.

## 10. Implementation order

Each phase has a runnable agent scenario and real-database checks. Keep pure
domain functions where useful; replace PostgreSQL persistence directly rather
than designing a universal ORM or maintaining two runtime implementations.

| Phase                                       | Deliverable and exit condition                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Spike                                    | Local and Cloud checks (section 12): done. License question sent to SurrealDB on November 5, 2026; awaiting a written answer (section 2).                                                                                                                                                                                                                                                                            |
| 1. Foundation                               | New branch, pinned Compose/CI, catalog/workspace provisioning, runtime access and signing-key rotation, process lease, API-key bootstrap/revocation, CBOR transport, transaction/receipt module. Boot and authenticate without PostgreSQL. Prove cross-workspace denial, duplicate retry handling and a refused second process. Record write latency and queue wait for a 200-event ingestion burst as the baseline. |
| 2. Agent-managed schema and records         | Metadata compiler/step runner, base templates/protection, built-in definition upgrades, IDs/directory, all existing field shapes, assertions/review, identifiers/uniqueness and single/collection/polymorphic native relations. An agent creates a custom object and safely writes it through MCP.                                                                                                                   |
| 3. Evidence and lifecycle                   | Event logging/retries/links, facts/internal notes, source retraction, merge, delete and forget/suppression, including queue/receipt cleanup. Competing operations preserve the existing invariants.                                                                                                                                                                                                                  |
| 4. Retrieval and human use                  | Search, filtered lists/aggregates, bounded rollups/timeline/context, saved views/lists, SDK and existing web flows. Port browser checks alongside backend reads.                                                                                                                                                                                                                                                     |
| 5. Native graph value and operational proof | Bounded traversal, payment/invoice and introduction scenarios, large-fan-out plans, restart/restore and representative Cloud checks. Agent can complete and explain the workflow end to end.                                                                                                                                                                                                                         |

During the port, mark unported surfaces unavailable explicitly. The branch is
not described as a complete replacement until all phases pass. Remove PostgreSQL
runtime imports, Drizzle migrations, default services and required PG test setup
by completion. Historical comparison fixtures may remain optional research tools
outside the application dependency graph.

Reuse SDK/client/API types and the current UI. Update branch documentation and
startup commands with the phase that changes them. That includes the
PostgreSQL-specific rules in `CLAUDE.md` and ARCHITECTURE.md: `records.data`,
"search is Postgres full-text only", Drizzle commands and the PostgreSQL testing
rules. Agents working on the branch must not follow rules for code that no
longer exists.

Do not port the AWS Lambda deployment (`packages/server/src/lambda`,
`deploy/aws`, `docs/aws.md`) or the separate `api` and `worker` roles: they run
several processes, which this topology does not support. Remove them from the
branch with the PostgreSQL runtime. The container image with `RETAINER_ROLE=all`
is the only launch path. A new cloud deployment pipeline and horizontal scaling
are deferred. Periodically merge `main` into this branch and
port behavior changes deliberately; do not merge backend replacement into `main`
without a separate decision.

## 11. Completion gates

- Port existing behavioral fixtures instead of replacing them with narrower
  SurrealDB-only happy paths. Unit tests may isolate pure logic; integration/API
  tests use real SurrealDB and a fresh catalog/workspace namespace per test file.
- Force competing creates, same/different-field writes, whole-set replacement,
  schema changes versus writes, retraction versus claims, merge versus logging,
  erasure versus ingestion and concurrent use of the same idempotency key. Use
  separate database sessions so the local queue cannot hide commit conflicts.
- Verify source/identifier assertions, current values and native graph agree
  after every lifecycle operation and after recomputation. Confirm direct native
  edge/unique-claim constraints reject invalid writes, on every target, for
  indexes created both at provisioning and by later schema changes.
- Test unknown/revoked keys, spoofed actors, runtime denial of schema changes,
  wrong database contexts, cross-workspace reads/writes/traversals/search and
  internal-note visibility. Permission refusal may return no rows; verify effects,
  not only transport success.
- On 1,000 and 10,000 synthetic events, verify correctness and inspect measured
  candidates/plans for ordinary lists and history/context pages. Include a
  record whose history rolls up from 5,000 source records, and a source record
  moved between rollup targets. No complete materialization before page
  limiting. Record queue wait/conflicts and p50/p95; set a performance target
  after the first correct implementation, not from the prototype's unequal
  HTTP/PostgreSQL-driver timings.
- A live agent must discover schema, add a custom type, resolve an ambiguous
  contact without guessing, log/cite evidence, distinguish pending review,
  retrieve context/history and explain a bounded introduction path. Browser
  checks cover human correction, approval, records and views.
- Restart during a schema plan and after a lost mutation response. Resume safely
  without duplicate claims or exposing half-published metadata. Restore a backup
  and verify identities, routes and suppression.
- Start a second process against a live lease and confirm it refuses to start.
  Rotate the signing key across several workspaces, including one that is
  mid-upgrade. Upgrade a workspace created by an older release's built-in
  definitions, including a renamed, a deleted and a conflicting element.

The release gate is a functioning agent-first CRM with no PostgreSQL dependency,
not a graph demo. Production adoption additionally requires SurrealDB's written
license answer (section 2), and verification of the actual hosted backend's
authorization, concurrency and retention behavior.

## 12. Local spike findings

November 5, 2026: SurrealDB 4.0.0 Community (pinned digest, SurrealKV, one local
node) and PostgreSQL 17 from the experiment's Compose file. Each check used
fresh databases and removed them. The scripts and how to rerun them are in the
[experiment README](../packages/server/experiments/surrealdb/README.md#migration-spike).
Timings are client-side medians on one machine and are not production targets.

| Question                | Finding                                                                                                                                                                                                                                                                                                  | Spec change                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Request latency         | `RETURN 1` took 48 ms with Basic authentication, 1.4 ms with a token over `/sql` and 1.5 ms over `/rpc`. The experiment's earlier SurrealDB timings were dominated by per-request password verification.                                                                                                 | Token authentication only (section 9).         |
| Record-access isolation | The token's database claim overrides the request header. `USE DB`, definitions, `REMOVE` and `INFO` are refused. Expired tokens get 401.                                                                                                                                                                 | None; confirms section 4.                      |
| Refused writes          | Refused `SELECT`/`CREATE`/`UPDATE`/`DELETE` return `[]` with status OK. A transaction committed its revision increment while a refused update did nothing; an affected-row check with `THROW` rolled it back.                                                                                            | Effect checks in every write (section 6).      |
| Statement failures      | Outside a transaction, a failed statement does not stop the statements after it.                                                                                                                                                                                                                         | Every write in `BEGIN`/`COMMIT` (section 6).   |
| Parameter types         | JSON-RPC turns `INV:2026`, `Order:12345`, `acme:corp`, `2026-11-05` and UUID-shaped strings into record IDs, datetimes and UUIDs, also inside nested objects. CBOR keeps strings as strings and carries tagged datetimes, record IDs and exact decimals. `/sql` query-string variables are strings only. | CBOR `/rpc` (section 9).                       |
| Definitions             | `DEFINE` statements commit or roll back with the data writes and revision increment around them. A unique index over duplicates fails and rolls back. A definition racing 20 writers on the revision record gets the normal retryable conflict.                                                          | Additive changes without a pause (section 7).  |
| Typed tables, relations | Undeclared fields are rejected. `option<T \| null>` distinguishes null from missing. `ENFORCED` relation tables reject missing or wrong-type targets, duplicate pairs and plain `CREATE`.                                                                                                                | None; confirms section 5.                      |
| Search                  | Prefix, accent, domain, `AND`, `@OR@` and negation use the index. An exact-word index ranks typed words first. Quoted phrases return nothing. Trigram `@OR@` candidates reranked by Jaro-Winkler find "Dana Levi" for "Dana Levy".                                                                       | Analyzer design (section 8).                   |
| Rollup page, one source | Newest page of one record's attachments: about 2 ms at 1,000, 10,000 and 50,000 events, as an index scan with the limit pushed down.                                                                                                                                                                     | Basis for stored rollups.                      |
| Rollup page, fan-out    | With 100,000 unrelated attachments: one statement per source took 12/259/1,390 ms for 100/1,000/5,000 sources; an `IN` list took 58/219/3,392 ms (planner chose a table scan); a closure took 82 s for 100 sources (table scan per source). The PostgreSQL lateral join took 1.1/5.1/22 ms.              | Stored rollups; plan rules (sections 5 and 8). |
| Test provisioning       | 338 definitions (access, 22 fixed tables, 6 object tables, 10 relation tables, search indexes) took 350 ms; 8 in parallel took 1.2 s wall time; removal took 6 ms.                                                                                                                                       | None; per-file and per-test databases suffice. |

### Cloud (Earth)

The same checks ran on November 5, 2026 against the `retainer` Earth instance
(EU residency) in a separate `retainer_spike` namespace, through short-lived
owner tokens over HTTPS; the instance MCP query route still failed. `/version`
reported `surrealdb-4.0.0-nightly` while management reported `4.0.0`. Rollup
sizes were reduced, without the PostgreSQL baseline. The namespace was removed
afterwards.

| Question                 | Cloud result                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same as local            | JSON-RPC coercion and CBOR, statement failures outside transactions, transactional `DEFINE`, typed tables and relation constraints, record-access isolation and silent refusal, search. `/sql` query-string variables arrive as `none`, which CBOR `/rpc` makes irrelevant.                                                                      |
| Unique indexes           | Enforced when defined on their own: single-field, composite, relation `(in, out)`, over existing rows, and against 10 concurrent creates. **A unique index defined inside `BEGIN`/`COMMIT` accepted duplicates**, and one defined there over existing duplicates was created.                                                                    |
| Write conflicts          | Per record, as locally: concurrent transactions on different records, tables or databases did not conflict. The message reads `Transaction conflict: conflict (409). This transaction can be retried`.                                                                                                                                           |
| Request latency          | `/health` 11 ms. `RETURN 1`: 249 ms with the owner token, 160 ms with a record-access token. Write transactions: 179 ms for 1 write, 251 ms for 10, 342 ms for 50. The time is server-side, not network.                                                                                                                                         |
| Rollup plans and timings | Same plan shapes as locally. One record's newest page took 252/262 ms at 1,000/5,000 events: flat, and equal to the request overhead. With 10,000 unrelated attachments: one statement per source took 480/882 ms for 100/500 sources; an `IN` list 419/599 ms (table scan; a 10-item list used index lookups); a closure 8.3 s for 100 sources. |
| Provisioning             | 338 definitions in one transaction took 11.4 s; removal took 355 ms. Eight parallel provisions dropped their connections.                                                                                                                                                                                                                        |

On Earth, a write needs at least two requests (plan, commit), about 0.4 s, so
one workspace's serialized writes top out at a few per second. The time is
spent in the service, so moving Retainer closer would not remove it. That is why
the spec targets a self-hosted server (section 2). The index result is the one
correctness difference; section 7's rule avoids it on every target.

Not covered by the spike: conflict rates under realistic load, stored-rollup
write cost, erasure and version retention, backup and restore.

## 13. Implementation notes and deviations

Recorded while implementing on `codex/surrealdb-v1`. Each is a choice the
sections above left open, or a place where the code differs from them.

| Area | What the branch does | Why |
| --- | --- | --- |
| Business schema changes | Every approved business change commits as one administrative transaction: new object and relation tables, their fields and their indexes are defined first, alone and verified (section 7's index rule), then the metadata, the `DEFINE FIELD` changes, the follow-ups (claims, rollups, search, views) and `schema_version` commit together. Nothing sets `schema_update` mode on this branch: fixed-table upgrades are additive `DEFINE … OVERWRITE` statements applied with the system credential, which then advance the fixed-table revision. Upgrade order per workspace is fixed tables, then access methods (so runtime sessions with the current key can route), then built-in definitions as one administrative mutation. | Uniqueness lives in `unique_claims`, and new indexes only ever cover new, empty tables, so no business change needs a data-dependent index build inside the pause. The existing-record checks run in the plan, against the revision the commit verifies. |
| Receipts | A receipt stores the plan's result, which for record writes is minimal (`{ id, created, fields }`); the full record is presented from a fresh read after the commit. A replay therefore shows the record as it is now, with the original per-field statuses. `log_event`, `remember`, merges and deletions store their whole result. | Keeps receipts from becoming copies of CRM content (section 7) without a second sanitizing step for most writes. |
| Erasure of receipts | `operations.refs` lists the public IDs a result mentions, element-indexed; `forget` sets `status = 'erased'` and clears `result` on every receipt that mentions an erased record, event or fact. Replays and `get_operation` then answer `result_erased` / `erased`. | Indexed lookup instead of scanning result text. |
| Relation claims lookup | `field_assertions.refs` holds the record IDs a relation value points at (`[]` for other fields), with a `refs.*` element index. Merge and forget find every claim pointing at a record, current or historical, by that index. | The value column is `any`; an element index on a derived array is the indexed way to find them. Empty arrays add no index entries (measured: a 2,000-row table with `[]` refs and two matches reads two rows). |
| Uniqueness claims | `unique_claims` (one row per held unique value, unique on `(field_id, value)`) is separate from `record_identifiers` (lookup rows for matching and merge suggestions). | A lookup identifier is not always a reservation (e.g. secondary emails of a non-unique field), and section 7's duplicate probe runs only on the claims table. |
| Event core | `event_identity` holds `occurred_at`, channel and external ID per event, unique on `(channel, external_id)`; `occurred_at` is also projected onto the event's object-table row and `event_attachments` rows so history pages are one index scan. Erasure clears channel and external ID (NONE never collides). | Point lookups for dedupe and source checks; stored attachments for history (section 5). |
| Routing keys | The catalog's `workspaces.access_keys` mirrors which signing keys each workspace database accepts; routing picks the newest accepted key and answers `workspace_upgrading` when none matches yet. | Lets a process route without opening every workspace database during a rotation. |
| Erasure sweeps | `forget` gathers everything in the plan and commits one transaction. Primary rows (directory, object row, event identity, claims it removes) are deleted by ID with exact effect checks; derived rows (assertions, identifiers, links, attachments, rollups, edges, search documents, fact sources) are swept by indexed `DELETE … WHERE` with a `min 0` check, after every plan step. | Earlier steps (recomputation, attachment moves) may already have removed some derived rows in the same batch; a sweep keeps "nothing derived survives" without double-counting. |
| Direct writes in maintenance | The consolidator and receipt cleanup are operations under the write protocol (no receipt), so they queue behind the workspace's writes. First boot needs no lock: the process lease and the catalog's unique slug serialize it. | One write path, as section 6 requires. |
| Similar-name suggestions | Candidates: up to 20 trigram (`@OR@`) matches per changed record's label; kept when the Jaro-Winkler similarity of the folded labels, computed in TypeScript (`similarity()` in `worker/consolidate.ts`), is at least 0.9. The directory's `updated_at` (indexed) drives the "changed since the last run" scan. | Section 8's design; pg_trgm's 0.6 threshold has no equivalent on this scale. "Dana Cohen"/"Dana Coheen" pass; "Dana Cohen"/"Ron Peretz" do not. |
| Operation IDs | Every `/v1` response that ran a write carries `Retainer-Operation-Id`; `unknown_outcome` errors carry it in `details`. `get_operation` is `GET /v1/operations/:id` or `GET /v1/operations?kind=&idempotencyKey=`, SDK `getOperation`, MCP `get_operation`; an expired receipt reads as `not_observed`. | Bodies keep their existing shapes. |
| `traverse_records` | Field steps read the relation table by its `in` or `out` index, ordered by the other endpoint; `in` with an owning field's name finds the records whose field points at the current ones, and an inverse name with `out` follows its owning field backwards. Link steps read `event_attachments` by `target` (newest first) or by `event`, and check the kind after reading, so discarded rows still count against the 500-edge budget. A window that would exceed the budget is cut and the result says `truncated: "edge_budget"`; more than 50 complete paths say `"path_limit"`. Paths never revisit a record. | Section 8's caps, with every expansion an indexed window per frontier record. |
| Signing keys | `retainer signing-key generate [--id]` prints a new `RETAINER_SIGNING_KEY` value and works without a configuration. | Operators need a way to create the first key. |
| Key rotation and stale processes | The configuration is the source of truth: each boot defines access methods for its accepted keys and removes the others, in the catalog and (on first use) in each workspace. A process booted later with an old configuration therefore rotates back. The lease prevents two at once; a process left with only a removed key loses its catalog session, so its lease heartbeat fails and it stops. | Rotation without a separate registry of keys. |
| Commit conflicts | A conflict detected at `COMMIT` is reported only on the `COMMIT` result, after every earlier statement reads "not executed"; the protocol checks every result for a retryable conflict before classifying the failure. | Found by the two-process tests (section 11). |
| Unique-index probes | The two probe rows share values only in the probed index's fields; every other field differs, so another unique index on the table cannot refuse the duplicate first. | A re-run of catalog provisioning failed its `workspaces.slug` probe on `workspaces.database`. |
| Durable jobs | The `jobs` table and its `(status, run_after)` index exist in every workspace, but no operation enqueues work yet: every lifecycle step (rollups, search, retraction, erasure) completes inside its own transaction, and the consolidator and receipt cleanup are scheduled, not queued. A job kind lands with its handler and a restart test. | Section 9 asks for durable jobs only "where needed"; none is needed yet. |
| Backup and restore | Back up with SurrealDB's export of the catalog database and of each workspace database (`GET /export` per database, or `surreal export`); restore by importing each into the same database names in an empty namespace, then boot. Signing keys are the configuration's, so restore with the same `RETAINER_SIGNING_KEY` (or rotate after). `test/surreal/backup.test.ts` checks keys, routes, records, unique claims and suppression after a restore. | Section 11's restore gate. |
| Reserved word | `value` as the first projection of a `SELECT` parses as `SELECT VALUE`; queries put another column first. | Pinned-release parser behavior. |

### Phase 1 baseline: 200-event burst

November 5, 2026, local pinned SurrealDB (SurrealKV, one node), one workspace,
200 concurrent `log_event` calls each matching two participants, from
`packages/server/test/surreal/baseline.test.ts`:

| Measure | Result |
| --- | --- |
| Wall time | 8.0 s for 200 events (about 25 writes per second) |
| Queue hold per write (plan + commit) | p50 40 ms, p95 48 ms |
| Queue wait | p50 4.1 s, p95 7.7 s |
| Caller latency | p50 4.1 s, p95 7.7 s |
| Revision conflicts / `workspace_busy` | 0 / 0 |

The hold time is the throughput limit, as section 6 expects. A burst much
larger than 200 into one workspace reaches the 10 s queue limit and gets
retryable `workspace_busy`; that is the first number to improve.

## Sources and implementation anchors

- [Current architecture and write rules](../ARCHITECTURE.md), especially sections
  1-3, 5, 7 and 12; [merged event/schema spec](schema-events-and-history-spec.md).
- [Existing agent interface](agents.md), [MCP implementation](../packages/server/src/mcp/server.ts),
  [assertion ranking](../packages/server/src/records/winner.ts),
  [PostgreSQL coordination being replaced](../packages/server/src/db/tx.ts).
- [Experiment results and their limits](surrealdb-experiment-results.md).
- [Spike scripts](../packages/server/experiments/surrealdb/spike/) behind section 12.
- S1: [SurrealDB transactions](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions):
  snapshot isolation, conflict detection and explicit retries.
- S2: [Permissions and row-level security](https://surrealdb.com/docs/learn/security/authorization/permissions-and-row-level-security):
  record-user permissions versus system-user roles.
- S3: [JWT access](https://surrealdb.com/docs/reference/query-language/statements/define/access/jwt):
  use RECORD access WITH JWT for record-user permission enforcement.

Vendor capabilities are version-sensitive. These references informed the plan;
native definitions, permissions and transaction semantics must be verified on
the pinned release before the corresponding phase is accepted.
