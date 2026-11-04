# PostgreSQL and SurrealDB for an agent-first CRM

Discussion and research date: November 4, 2026.

This document captures the database evaluation, product assumptions, comparison,
and proposed experiment from the Retainer discussion. It is exploratory, not a
migration decision or an implementation specification. Current behavior remains
documented in [ARCHITECTURE.md](../ARCHITECTURE.md).

## Product context and decision

Retainer is currently an experimental repository with no users. The goal is to
learn through experimentation over the next few weeks before building the real
product: a CRM maintained by AI agents, with people able to understand, review,
and use the resulting information.

That context changes the weighting of the decision:

- Existing PostgreSQL code is useful as a baseline, but is not a reason by itself
  to reject a different model.
- There is no customer-data migration burden today. The relevant costs are
  experiment time, implementation complexity, and proving correctness.
- PostgreSQL remains a strong default for structured records, trustworthy
  assertions, reporting, and bounded context retrieval.
- SurrealDB deserves a time-boxed trial because native graph modeling may make
  relationship-heavy agent workflows substantially easier to build.
- A trial is not authorization to migrate. No database migration was performed
  as part of this evaluation.

The initial recommendation was to retain PostgreSQL as the primary database.
After clarifying that the repository has no users and exists for experimentation,
the recommendation became: test SurrealDB now, and choose based on evidence
instead of protecting the existing implementation.

## Research scope and evidence limits

The evaluation covered SurrealDB's document/schema model, graph traversal,
transactions, permissions, full-text search, realtime behavior, licensing, and
separate Agent Memory product. Relevant source and tests were inspected alongside
Retainer's schema, assertion rules, transaction locks, and context retrieval.

SurrealDB v4.0.0 was verified as the latest non-prerelease through GitHub's release
API during the research. It was published on November 3, 2026. The inspected
`main` commit was `9577ac5f0caa60a39d5a334e9352aed0e232f9e6`, labeled
`4.1.0-nightly`; its diff from v4.0.0 contained version-related changes. Relevant
conflict-registration tests were also checked at the v4.0.0 tag.

This was a design and source review, not a runtime benchmark, load test, security
audit, production-readiness certification, or legal determination. Documentation
and product capabilities are version-sensitive; pin a release, SDK, storage
engine, and edition for the experiment. Claims of simpler queries do not establish
better performance.

## Requirements comparison

The rows include possible future requirements, not just current Retainer features.
“Strength” means a relevant capability; “tradeoff” means application work or a
limitation; “test” means the comparison needs experimental evidence.

| Feature or requirement | PostgreSQL | SurrealDB |
| --- | --- | --- |
| Agents create new objects and fields | Strength: Retainer's metadata and JSONB already support this without per-field database migrations. Tradeoff: dynamic validation and discovery live in application code. | Strength: flexible documents and typed schema definitions fit evolving models. Tradeoff: controlled schema evolution still needs product rules. |
| Rich relationships among people, companies, deals, and interactions | Strength: foreign keys and edge tables provide explicit integrity. Tradeoff: increasingly complex relationship paths require more involved queries. | Strength: native edges, edge properties, and bidirectional traversal express relationships directly. |
| Explore several relationships deep | Strength: recursive SQL is available. Tradeoff: query construction and maintenance can become cumbersome. | Strength: recursive traversal is a natural fit. Test: realistic CRM graphs, traversal limits, and performance. |
| Agents discover the schema and allowed operations | Strength: Retainer exposes workspace schema through API/MCP. Tradeoff: meaning and allowed operations need application descriptions. | Strength: database schema and graph structure provide useful primitives. Tradeoff: CRM-specific tool descriptions and policy remain necessary. |
| Typed, validated writes | Strength: constraints for fixed structure, application validation for dynamic fields. | Strength: native field types and assertions. Tradeoff: workspace-specific rules still need deliberate modeling. |
| Provenance: who claimed what, based on which source | Strength: assertion and source tables represent provenance explicitly. | Strength: claims, actors, and sources map naturally to connected records. Tradeoff: provenance semantics remain application responsibility. |
| Conflicting claims, confidence, and human review | Strength: fits Retainer's current implementation. Tradeoff: custom business logic. | Strength: can represent the workflow. Tradeoff: does not automatically supply Retainer's precedence or review rules. |
| Concurrent agents update the same records | Strength: row locks and transactions provide direct coordination mechanisms. | Strength: transactions detect conflicting writes. Tradeoff: whole-transaction retries and different coordination mechanisms. |
| Prevent duplicate contacts and repeated operations | Strength: unique constraints and idempotency records. | Strength: unique indexes and deterministic IDs. Tradeoff: concurrent transaction conflicts require retry handling. |
| Merge entities and retract incorrect evidence | Strength: transactions and explicit relations support consistent recomputation. Tradeoff: substantial domain logic. | Strength: traversal may simplify locating affected relations. Tradeoff: merge and retraction semantics still require substantial domain logic. |
| Forget a person and prevent accidental re-ingestion | Strength: Retainer already coordinates erasure and suppression with locks. | Strength: references and graph structure help locate connected data. Tradeoff: design and prove an erasure/ingestion boundary. |
| Tenant isolation and future record-level access | Strength: row-level security supplies a database enforcement boundary; record-level policy remains future work in Retainer. | Strength: table and field permissions. Tradeoff: system users bypass these permissions, so backend identity design matters. |
| Structured filters, sorting, reporting, and analytics | Strength: SQL joins, aggregation, window functions, and established reporting tooling. Tradeoff: arbitrary JSONB ranges and sorts still need workload-driven indexing. | Strength: filtering and aggregation. Tradeoff: SurrealQL differs from SQL; evaluate complex reports and tool compatibility. |
| Keyword search without model calls | Strength: built-in full-text search, already used by Retainer. | Strength: built-in full-text search and BM25. Test: relevance, multilingual behavior, and tenant-scoped performance. |
| Possible future vector or hybrid retrieval | Tradeoff: requires extending the current stack and revisiting Retainer's no-embeddings design. | Strength: native vector and hybrid-search primitives. Tradeoff: embedding generation remains separate; this is not a current requirement. |
| Live UI showing agent activity | Tradeoff: requires an application delivery layer for database changes. | Strength: built-in live queries. Tradeoff: subscribe appropriately to relationship changes; distributed live queries require Enterprise. |
| Durable triggers and background workflows | Strength: transactional job/outbox tables provide a foundation. Tradeoff: implement workers and delivery guarantees. | Strength: events and changefeeds provide primitives. Tradeoff: orchestration, retries, and idempotency are still needed. |
| Self-hosting and operation | Strength: broad operational knowledge, hosting options, and tooling. | Strength: single-server and embedded options. Tradeoff: storage-engine and edition choices affect capabilities. |
| Licensing for a customizable hosted CRM | Strength: permissive PostgreSQL license. | Tradeoff: the BSL restriction concerning customer-controlled schemas/tables needs clarification for Retainer's intended use. |
| Learning value in this experimental phase | Strength: a baseline for correctness and conventional CRM workloads. | Strength: tests whether treating relationships as a primary building block materially simplifies agent workflows. |

## What SurrealDB could simplify

An agent-managed CRM naturally contains a graph: people work at companies,
participate in meetings, influence deals, introduce other people, and supply
evidence for claims. SurrealDB represents edges as records with their own
properties and supports forward, reverse, and recursive traversal.

Candidate workflows that would exercise this advantage:

- Find who could introduce us to a buyer.
- Find people connecting two accounts.
- Trace the interactions supporting a conclusion.
- Find deals dependent on the same stakeholder.
- Follow related records when assembling an agent's context.

Retainer's current context retrieval is bounded and rule-based: current field
values with provenance, open tasks, current facts, and recent interactions fitted
to a token budget. That workload alone has not demonstrated a need to switch.
Graph exploration becomes more persuasive if it is central to the intended
product experience.

## What the database does not decide

Retainer already adds fields through metadata rather than PostgreSQL DDL.
SurrealDB's document flexibility would not unlock a capability currently absent.
Safe schema evolution still needs stable field identities, rename safety,
approval of destructive changes, schema versions, and clear agent-facing tools.

Likewise, graph storage does not replace claim governance. For example:

1. A person sets Dana's company to Acme.
2. An agent finds a newer email suggesting Dana moved to Globex.
3. Retainer retains the conflicting claim for review.
4. The source email is retracted and affected values are recomputed.

Actor precedence, confidence thresholds, review, source retraction, and rebuilding
derived state remain Retainer's responsibility with either database. Native graph
storage may simplify navigation without simplifying those decisions.

The key question is whether SurrealDB reduces total application complexity once
these rules are included, rather than merely shortening relationship queries.

## Technical findings that affect an experiment

### Transactions and concurrency

SurrealDB defaults to snapshot isolation and detects conflicting writes at commit.
Its `SELECT ... FOR UPDATE` registers named records for commit-time conflict
detection; it does not block competing writers like a PostgreSQL row lock.
Explicit multi-statement transactions require whole-transaction retry handling.
The v4.0.0 repository includes tests for these conflict-registration semantics.

In v4.0.0, standalone statements can be retried automatically by the server under
documented conditions. That does not remove the need to handle conflicts for
explicit transaction blocks or exhausted retries.

Serializable isolation is available on SurrealMX and SurrealDS, but not SurrealKV
or TiKV according to the reviewed documentation. SurrealDS is an Enterprise
storage engine. Testing only the in-memory engine would therefore be insufficient
evidence for a persistent SurrealKV deployment.

Retainer currently coordinates schema changes, writes, privacy deletion, and
consolidation through shared/exclusive advisory locks and record locks. Those
boundaries require a new design on SurrealDB. Named-record conflict checks alone
do not protect query predicates or prevent new matching records from appearing.
Unique indexes protect duplicate claims, but are not substitutes for every
cross-record invariant.

### Relationships and referential integrity

SurrealDB permits relation endpoints that do not yet exist unless the relation is
defined with `ENFORCED`. Record references have configurable deletion behavior;
the documented default is `ON DELETE IGNORE`.

Retainer still needs to enforce same-workspace relationships, valid target object
types, live targets, and the distinction between soft deletion and hard erasure.
An edge expressing a winning relation must remain derived from eligible claims,
so a rebuild cannot restore a retracted or erased relationship.

### Authorization

Table and field permissions apply to record users. System users use roles and
bypass those permissions. Retainer cannot assume that a database-level service
identity preserves an equivalent of its PostgreSQL RLS boundary.

Choose and test a tenant model and authentication strategy explicitly. Keep actors
derived from authenticated credentials, not request payloads. Test indirect reads,
traversal, search, context, and subscriptions as well as direct record reads.

### Realtime and durable processing

Live queries are useful for an interactive CRM, but watching a node does not
automatically notify subscribers when a separate edge record changes. Watch the
appropriate edge tables as well. Community live queries receive changes from the
node holding the subscription; distributed live queries are an Enterprise feature.

Changefeeds support replay within a configured retention window and are the
relevant primitive for catching up after downtime. Live notifications alone are
not a durable workflow queue. Asynchronous events run outside the originating
transaction and should not maintain invariants that must commit atomically.

### Search and the separate Agent Memory product

SurrealDB's full-text search and BM25 can be used without embeddings or model
calls. Native vector/hybrid search is a possible future option, not a reason by
itself to change Retainer's current scope.

SurrealDB Agent Memory is a separate layer with extraction, reconciliation,
provenance, retrieval, and forgetting. Its documented pipelines include model
calls and embeddings. Study it as a product reference, but distinguish adopting
that layer from choosing SurrealDB as storage. Retainer currently leaves
intelligence with external agents and makes no language-model or embedding calls.

### License

The reviewed server license is Business Source License 1.1, not an OSI open-source
license. Its additional use grant restricts a “Database Service,” with language
covering third parties creating, managing, or controlling schemas or tables.

Because customizable schemas are central to Retainer, obtain written clarification
about the intended hosted product before adopting it for production. This is an
unresolved applicability question, not a conclusion that Retainer is prohibited.
The reviewed license lists Apache 2.0 as the change license and January 1, 2030
as the change date; license terms must be checked for the version actually used.

## Proposed time-boxed experiment

Set the time budget before implementation. Keep the trial isolated and retain the
PostgreSQL implementation as the comparison baseline. No duration was agreed in
the discussion.

Use a realistic synthetic account dataset containing people, companies, deals,
tasks, interactions, source claims, and duplicate or conflicting identifiers.
Include both ordinary CRM reporting and relationship-heavy queries so the trial
does not favor only graph-shaped examples.

| Scenario | Evidence to collect |
| --- | --- |
| Relationship-heavy context | Query clarity, implementation effort, result correctness, bounded traversal, and latency compared with PostgreSQL. |
| Two agents create the same contact | One canonical contact, consistent identifier claims, no orphan provisional record, and predictable retries. |
| Two agents update different fields of one record | Both updates survive with correct assertions and derived state. |
| Conflicting assertions followed by source retraction | Precedence and review behavior remain correct; retracted claims never win again; materialized values and edges rebuild consistently. |
| Merge races with interaction ingestion | Links end at the survivor; retained IDs resolve correctly; no lost or duplicated links. |
| Erasure races with a new write | No erased handle, claim, or relationship is restored; suppression and related cleanup remain consistent. |
| Schema change races with a record write | No write commits against an invalid or stale schema. |
| Tenant isolation and restricted access | No cross-tenant results through direct queries, graph paths, search, context, or subscriptions. |
| Worker/subscriber disconnect and restart | Defined catch-up behavior, idempotent processing, and no reliance on live delivery for durable work. |
| Typical filtered lists and reports | Sorting, pagination, counts, aggregation, index usage, and behavior at representative data sizes. |

Record the release, SDK, edition, storage engine, data size, query plans where
available, retry/conflict counts, implementation changes, and measured latency.
Run correctness races as concurrent operations rather than sequential examples.
Exercise persistence and restart on the intended storage backend.

Compare total code and operational complexity, not just line counts or isolated
query speed. A shorter query is useful, but does not justify moving policy into
harder-to-test database functions or weakening guarantees.

## Decision criteria and open questions

Favor SurrealDB if relationship exploration is central to the product, the trial
shows meaningful simplification across complete agent workflows, correctness
holds on the intended persistent backend, and licensing/deployment choices fit.

Favor PostgreSQL if the near-term product remains primarily structured records,
assertions, interactions, reporting, and bounded context packs, or if graph query
convenience is offset by coordination and authorization complexity.

Questions the experiment should resolve:

- Are multi-hop questions frequent enough to shape the core model?
- Which schema and tenant layout makes customization manageable?
- Can schema and privacy boundaries be enforced without excessive contention?
- Which capabilities require an edition or engine unsuitable for self-hosting?
- Does SurrealDB simplify agent-facing tools, or only backend query syntax?
- How do search relevance, reporting, debugging, backup/restore, and upgrades feel
  in practice?
- Does the license permit the intended customizable hosted CRM?

Neither a primary-database migration, a second production graph database, nor a
vector-search feature was selected. The purpose of the trial is to make the next
architecture decision better informed.

## Sources

SurrealDB sources were consulted during the November 4, 2026 evaluation:

- [Documentation overview](https://surrealdb.com/docs)
- [Repository](https://github.com/surrealdb/surrealdb)
- [v4.0.0 release](https://github.com/surrealdb/surrealdb/releases/tag/v4.0.0)
- [Schema modes](https://surrealdb.com/docs/learn/data-models/document/schema-modes)
- [Field validation and flexible objects](https://surrealdb.com/docs/learn/schema-management/tables-and-fields/fields-and-validation)
- [Creating relations and enforced endpoints](https://surrealdb.com/docs/learn/data-models/graph/creating-relations)
- [Graph traversal](https://surrealdb.com/docs/learn/data-models/graph/graph-traversal)
- [Recursive traversal](https://surrealdb.com/docs/learn/data-models/graph/recursive-traversals)
- [Record references and deletion behavior](https://surrealdb.com/docs/reference/query-language/language-primitives/record-references)
- [Transactions, retries, and engine-specific isolation](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions)
- [Released conflict-registration tests](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/core/src/kvs/tests/select_for_update_test.rs)
- [Released isolation-level tests](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/core/src/kvs/tests/isolation_level_test.rs)
- [Released unique-claim concurrency tests](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/core/src/kvs/tests/doc_id_claim_test.rs)
- [Permissions and row-level security](https://surrealdb.com/docs/learn/security/authorization/permissions-and-row-level-security)
- [Search functions](https://surrealdb.com/docs/reference/query-language/functions/database-functions/search)
- [Index definitions and uniqueness](https://surrealdb.com/docs/reference/query-language/statements/define/indexes)
- [Live-query limitations](https://surrealdb.com/docs/reference/query-language/statements/live-select)
- [Changefeeds](https://surrealdb.com/docs/learn/querying/real-time/changefeeds)
- [Enterprise capabilities](https://surrealdb.com/docs/manage/enterprise/product/database-enterprise)
- [Agent Memory architecture and models](https://surrealdb.com/docs/agent-memory/architecture/surface-security-and-models)
- [Server license at v4.0.0](https://github.com/surrealdb/surrealdb/blob/v4.0.0/LICENSE)
- [PostgreSQL license](https://www.postgresql.org/about/licence/)

Retainer implementation references:

- [Architecture and write rules](../ARCHITECTURE.md)
- [Database schema](../packages/server/src/db/schema.ts)
- [Workspace transaction and locking boundaries](../packages/server/src/db/tx.ts)
- [Assertion precedence and review rules](../packages/server/src/records/winner.ts)
- [Record write coordination](../packages/server/src/records/write.ts)
- [Context retrieval](../packages/server/src/retrieval/context.ts)
- [Related schema and memory discussion](schema-and-memory-design-discussion.md)
