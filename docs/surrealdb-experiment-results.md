# SurrealDB experiment: first results

November 4, 2026. Implementation and commands:
[experiment README](../packages/server/experiments/surrealdb/README.md).

## Assessment

Native typed relations express the introduction path directly and can represent
Retainer's accepted relationship projection. The exercised assertion and event
rules also work on a persistent SurrealKV instance, including forced concurrent
writes and whole-transaction retries. This establishes feasibility for the small
slice, not equivalent coverage of the complete events/history spec.

There is no evidence from this experiment to choose a new primary database yet.
The first native history query still materializes candidates, and the workspace
revision used by the prototype serializes all writes. Both need further work
before a scalability comparison would be meaningful.

## Verified behavior

The scenario checks exercise payment-to-invoice attachment, one-hop company
rollup, precedence and deduplication, current grouping versus explicit links,
source retraction and restoration of earlier scalar/collection assertions,
pending-review exclusion from native edges, whole-set competing writes,
different-field competing writes, schema deprecation versus writes, event
retraction versus claims, event erasure versus logging, initial-value retry
identity, additive event links, polymorphic target validation, invalid-collection
rollback, native endpoint/type/cardinality constraints, equal-time pagination,
and separate workspace databases. Several checks have multiple assertions;
the runner reports the current check count.

Introduction paths, event pages and ordinary sorted invoice lists agree with a
real PostgreSQL JSONB/edge-table read reference. That reference is populated from
the accepted SurrealDB projection, so it is not an independent implementation of
Retainer's write rules or a comparison against the implementation branch.

## First measured run

- SurrealDB 4.0.0 Community, pinned container digest, one local node, SurrealKV.
- PostgreSQL 17 in a separate local container.
- 250 additional invoices and 250 payment events, plus the small CRM fixture;
  1,770 assertions and 52 explicit event links.
- Three warmup calls and 15 measured calls per query, page size 20.
- All 250 company payments retrieved exactly once across cursor pages.
- All stored fixture rows and the first event page survived a container restart.

| Query               | SurrealDB client median / p95 | PostgreSQL client median / p95 |
| ------------------- | ----------------------------- | ------------------------------ |
| Company event page  | 83.49 / 88.94 ms              | 7.88 / 8.75 ms                 |
| Introduction paths  | 48.72 / 50.34 ms              | 1.58 / 1.74 ms                 |
| Sorted invoice page | 48.25 / 51.83 ms              | 0.96 / 1.10 ms                 |

**Correction (November 5, 2026):** the harness authenticated every SurrealDB
request with Basic authentication, which costs about 48 ms per request locally;
a trivial query with a token takes 1.4 ms. The SurrealDB column is therefore
dominated by authentication and does not compare query work. See the
[migration spec's spike findings](surrealdb-migration-spec.md#12-local-spike-findings)
for token-authenticated measurements, including rollup fan-out.

These are observations of these implementations over different protocols
(SurrealDB HTTP and the PostgreSQL driver), including client overhead. They do
not establish an engine-level performance difference. The event query in
particular is an initial, unbounded-candidate implementation. The introduction
fixture is small and does not establish high-degree traversal performance.

Raw timings, dataset counts, restart checks and EXPLAIN output are written by
`measure.mjs` to the ignored `.results/measurements.json`. EXPLAIN of the event
query's final SELECT describes its materialized intermediate result; it does not
prove the upstream graph walk is bounded.

## Cloud status

Cloud access is now working through the direct HTTPS `/sql` endpoint, using a
short-lived token brokered by the signed-in Cloud connection and kept in memory.
The upstream instance MCP forwarding route still fails; management access works.

Verified in instance `retainer`, namespace `retainer_experiment`, database
`trial_cloud_6bf8d8446e14`:

- All 17 native schema tables exist.
- Synthetic company, invoice, payment and assertion transactions were applied;
  a sourced claim set the invoice to `paid`, and source retraction restored `sent`.
- The common experimental writer then added two companies in total, three people,
  one deal, one stakeholder, a meeting and a second active payment. There are 28
  assertions. The invoice is currently `paid` from the active payment's claim.
- The company history returns the active payment via its invoice, and the graph
  introduction query returns Alex's meeting with Dana.
- A fresh read verifies the stored schema, counts and business state. Reports are
  in `.results/cloud-verification.json` and `.results/cloud-exploration.json`.

The initial all-in-one setup request timed out, but its server-side work continued.
The direct runner now uses four-statement schema batches and revision checkpoints
to avoid duplicating completed data transactions. Timeouts are not evidence of
rollback. Resume is restricted to this generated trial, not arbitrary schemas.

Management advertises `4.0.0`; the live `/version` endpoint returns
`surrealdb-4.0.0-nightly`. The full concurrency, tenant authorization and restart
suite has not been run on Earth, and local SurrealKV results cannot establish
those guarantees for its backend. No instance deployment or credential change
was needed.

## Next decision gate

1. Implement an indexed event-attachment query that merges bounded streams before
   pagination; verify work at increasing fan-out, not just page length.
2. Replace the coarse revision with a tested schema/source/record coordination
   strategy and measure contention under unrelated and conflicting writes.
3. Run the same scenarios against the completed PostgreSQL implementation and
   compare total domain/query/coordination code, not only query text.
4. Extend Cloud checks to scoped authorization and concurrency before treating
   the prototype as a deployable backend candidate.

Association metadata, per-member relation operations and historical belief
snapshots remain outside this experiment, as they are outside the spec's current
committed scope. No application migration has been made.
