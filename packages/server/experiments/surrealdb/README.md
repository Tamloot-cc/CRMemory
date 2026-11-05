# SurrealDB experiment

An isolated, AGPL-licensed correctness and query experiment. It is not imported
by Retainer, does not change the application database, and does not replace the
implementation of `docs/schema-events-and-history-spec.md` in progress elsewhere.

## Run

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
docker compose -f packages/server/experiments/surrealdb/compose.yml up -d --wait
node --test packages/server/experiments/surrealdb/scenarios.checks.mjs
node packages/server/experiments/surrealdb/measure.mjs
```

The measurement command restarts **only this Compose project's SurrealDB
container** to verify persistence. Do not run it concurrently with the checks.
It defaults to 250 additional invoices and payments. Set `EXPERIMENT_ROWS=1000`
to increase the dataset. Results and query plans are written to
`.results/measurements.json`, and the generated native schema to
`.results/schema.surql`. These files are ignored by Git.

The ports default to 18180 (SurrealDB) and 18181 (PostgreSQL), bound only to
127.0.0.1. `EXPERIMENT_SURREAL_PORT` and `EXPERIMENT_PG_PORT` override them for
both Compose and Node. The credentials in this directory are local synthetic
fixture credentials, not Cloud credentials. Both services have their own
persistent named volume. SurrealDB is pinned to 4.0.0 by image digest and uses
SurrealKV; PostgreSQL is pinned by image digest to the tested 17.11 build.

Each check creates a fresh, random `trial_*` database and deletes only that
database afterwards. PostgreSQL comparisons create and remove a random `trial_*`
schema. A failed schema initialization may leave an empty local trial database;
the harness never removes a database it did not name.

Stop the local services when finished:

```sh
docker compose -f packages/server/experiments/surrealdb/compose.yml stop
```

## Model and boundaries

- `schema.mjs` compiles the small fixture metadata into schemafull object tables,
  typed native relation tables, endpoint enforcement, and indexes. Physical
  object identifiers and `f_*` field keys are stable, independent of UI names.
- `model.mjs` validates claims and derives accepted scalar values and graph
  edges. Scalars and whole relationship sets have actor precedence, review and
  source retraction. Rejected transactions leave no partial projection behind.
  The trusted harness session supplies the actor; write payloads do not.
- Payment and Meeting are event records. Explicit participant/about edges are
  separate from ordinary assertion-backed relation edges. Event retries compare
  initial values, preserve subsequent edits and add missing links.
- All fixture events require an external identity. Erasure removes their initial
  values and citing assertions and retains only a keyed suppression digest. The
  fixed local HMAC key is solely for the fixture; this is not Retainer's complete
  person-erasure policy or a key-rotation implementation.
  Erasure checks inspect current rows, not MVCC history, backups, logs or storage
  pages; they do not establish physical removal of retained versions.
- The event query supports the exercised payment/invoice/company path and
  explicit invoice attachments. It selects one event row before page limiting,
  and chooses `participant`, `about`, `field`, then `rollup` with deterministic
  tie-breaking. It does not implement arbitrary metadata-driven rollup queries.
- The introduction query uses an ordinary Stakeholder object for its role and
  person/deal relations. It follows native graph adjacency to participating
  meetings and people. No association-property or per-member assertion semantics
  are introduced.

The correctness prototype takes a workspace snapshot and compares-and-increments
one workspace revision in the commit transaction. A conflicting transaction
re-reads and reruns the entire operation with a bounded retry budget. This is
intentionally coarse and serializes unrelated writes. It is **not** a proven,
scalable replacement for PostgreSQL schema and record locks. The race checks
force both contenders to read before either commits.

`PostgresReference` uses real PostgreSQL, JSONB records, foreign-key edges and SQL
queries. It imports SurrealDB's accepted projection. It checks query equivalence
and gives a read-performance reference; it is **not** an independent write-rule
oracle or a benchmark of the in-flight Retainer implementation. The same expected
business outcomes are checked separately by the scenario tests.

## What is deliberately unproven

This does not implement the full spec: facts, a merged timeline, context budgets,
merge redirection, hidden notes, full privacy lifecycle, arbitrary runtime type
creation, template upgrades and HTTP/MCP authorization are outside this slice.
Schema-race coverage exercises metadata field deprecation, not native type/index
migration. The two-workspace check proves database separation under the harness;
it does not prove authorization with tenant-scoped credentials. Root credentials
must never be treated as a tenant security boundary.

The current history query materializes event candidates before `LIMIT`.
Introduction result count is capped after expanding meeting contacts. Fixed path
length and bounded returned pages do not establish bounded query work. Plans and
the measured fan-out are recorded instead of declaring this requirement passed.
Local HTTP vs PostgreSQL driver timings include different protocol overhead and
are not production throughput estimates. Warmups and sample counts are recorded.

SurrealQL files were formatted with `@surrealdb/surql-fmt` 0.1.0-beta.3 and then
validated with the pinned server's CLI. That formatter dropped the comma in a
multi-table `FROM`; `events.surql` retains the manually restored comma. Always
validate after formatting. For example:

```sh
docker compose -f packages/server/experiments/surrealdb/compose.yml exec -T surrealdb \
  /surreal validate --stdin < packages/server/experiments/surrealdb/queries/events.surql
```

## Migration spike

`spike/` holds the local and Cloud checks behind section 12 of
[the migration spec](../../../../docs/surrealdb-migration-spec.md#12-local-spike-findings).
Locally they use the same Compose services and only the `retainer_spike` namespace; each
script creates fresh databases and removes them, including after a failure.
Every script prints its observations rather than asserting them.

```sh
docker compose -f packages/server/experiments/surrealdb/compose.yml up -d --wait
cd packages/server/experiments/surrealdb/spike
node latency.mjs       # auth methods, /sql vs /rpc, write transactions by size
node access.mjs        # record-access JWTs, permissions, silent refusal, database confinement
node transport.mjs     # JSON-RPC type coercion vs CBOR; failures outside a transaction
node schema.mjs        # transactional DEFINE, relation constraints, null vs none
node search.mjs        # full-text parity with ARCHITECTURE.md 5.1
node rollup.mjs        # rollup fan-out vs the Postgres lateral join (several minutes)
node provisioning.mjs  # time to provision a workspace-sized database
node integrity.mjs     # unique-index enforcement by definition style; conflict granularity
node cleanup.mjs       # remove the retainer_spike namespace after an interrupted run
```

To run checks against SurrealDB Cloud, mint a short-lived database token
through the Cloud MCP tool `get_instance_database_token` and send it to
`cloud.mjs` as one JSON line on standard input, never as an argument or a file:
`{"token": "…", "endpoint": "https://<host>", "checks": ["latency", "integrity"]}`.
Tokens last about 10 minutes, so run a few checks per token. For `rollup`, set
`SPIKE_POSTGRES=0` and smaller sizes (for example `SPIKE_SINGLE=1000,5000
SPIKE_FANOUT=100,500 SPIKE_NOISE=10000`), since Earth bills by use. Finish with
the `cleanup` check.

`rollup.mjs` also creates and drops a `spike_*` schema in the Compose
PostgreSQL, unless `SPIKE_POSTGRES=0`. `SPIKE_SINGLE` (default
`1000,10000,50000`), `SPIKE_FANOUT` (default `100,1000,5000`) and `SPIKE_NOISE`
(default 100,000 unrelated attachments) change its sizes. Its closure variant scans the
table once per source, so it runs once, at the smallest fan-out. `cbor.mjs` is a
minimal encoder/decoder for these checks, not a client to reuse.

## Cloud smoke fixture

```sh
node packages/server/experiments/surrealdb/cloud-fixture.mjs
```

This generates `.results/cloud-smoke.surql`, `cloud-smoke-steps.json` and
`cloud-smoke-meta.json`. It first
executes the common writer locally, then exports its successful transactions for
replay. The fixture creates a fresh namespace/database context, synthetic company,
invoice, payment, claims and native relations; checks application of a sourced
value; retracts its source; and checks restoration of the prior value. It does
not read credentials, deploy instances or modify any existing database.

On November 4, 2026, the connected Earth instance advertised `query` support but
both `call_instance_tool(query)` and `list_instance_tools` failed at the instance
MCP route. Management access and the direct HTTPS `/sql` endpoint worked.

`cloud.mjs` provides the direct SQL fallback. An agent requests a short-lived
database token through the authenticated Cloud MCP tool
`get_instance_database_token`, then sends one JSON request to the runner on
standard input with `token`, `endpoint` and `mode`. Tokens must stay in memory:
do not put them in source files, environment files, shell command arguments or
reports. When using an interactive terminal, disable echo before sending the
stdin line. The runner restricts the destination to this experiment's known
Cloud instance and redacts the supplied token from errors.

Supported modes:

- `probe`: verifies a read-only query and root metadata access.
- `smoke`: applies schema definitions in batches of four using `IF NOT EXISTS`;
  creates the fixture control row only if absent; checks the current revision
  before replaying each data transaction; verifies sourced status and retraction.
- `explore`: uses the same `CRM` writer as local checks to add people, a deal, a
  stakeholder, a meeting and a second active payment, then checks native history
  rollup and introduction paths. Existing scalar fixture values are checked
  rather than overwritten. Once this advances the database beyond the smoke
  checkpoint, use `query` or `explore` instead of replaying the earlier smoke.
- `query`: executes `query` text with explicit `namespace` and `database` values.

Inspect every statement status. A request timeout does **not** establish rollback:
the first large request continued running on the server after the client timed
out. Its completed transactions were detected and skipped on resumption. Never
reset the control revision or recreate a partially populated trial to retry it.
Only resume this generated experiment after inspecting its state; `IF NOT EXISTS`
does not establish equivalence for an arbitrary existing schema.

### Verified Cloud database

In SurrealDB Studio, open instance **retainer**, namespace
**retainer_experiment**, database **trial_cloud_6bf8d8446e14**.

The schema and data are now verified there: 17 tables, two companies, three
people, one invoice, one deal, one stakeholder, one meeting, two payment records
(one retracted, one active), 28 assertions and native relation edges. Source
retraction first restored the invoice to `sent`; the active exploration payment
then supplied the current `paid` claim. The company history returns the active
payment through the invoice rollup, and the introduction query returns Alex's
meeting with Dana.

```surql
SELECT uid, f_name FROM o_company;
SELECT uid, f_name, f_status FROM o_invoice;
SELECT uid, f_name, f_email FROM o_person;
SELECT * FROM r_invoice_company;
SELECT * FROM assertion WHERE subject = o_invoice:one;
```

`.results/cloud-verification.json` records the schema and retraction checks;
`.results/cloud-exploration.json` records the subsequent live graph queries and
row counts. Management reports `4.0.0`, while the public `/version` endpoint
returns `surrealdb-4.0.0-nightly`; the actual response is retained in the report.
The complete local concurrency suite and restart tests have **not** been rerun
against Earth's storage backend. This fallback does not fix the upstream MCP
data route, deploy an instance or persist credentials.
