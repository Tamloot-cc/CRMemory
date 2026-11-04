# Event types and record history: spec

Status: **proposed**, not implemented. Written November 4, 2026.

This spec turns the open questions from the
[schema and memory design discussion](schema-and-memory-design-discussion.md)
into decisions. [ARCHITECTURE.md](../ARCHITECTURE.md) still describes current
behavior; each phase below updates it in the same change that implements it.

**Context.** Retainer is in early exploration: there are no users and no data
to preserve. Migrations in this spec may drop and recreate tables, rename
columns and remove APIs without compatibility shims or backfills. That freedom
covers Retainer's own storage only. The product guarantee that a *workspace's*
data survives its own schema changes (rule 3) stays.

## 1. Current state, verified against the code

The discussion's claims were checked against the code on November 4, 2026.
These points correct or extend it:

- **Base objects are protected; base fields are not.** `delete_object`
  refuses person, company and task (`schema-engine/apply.ts`), but any of
  their fields except the label field can be deleted or renamed, including
  `task.status` and `task.dueDate`, which context packs read by universal ID.
  Deleting `task.status` silently turns off the open-task status filter
  (`retrieval/context.ts`).
- **Open tasks** in a context pack are live Task records linked to the record
  in either direction through any active relation field, whose status is not
  `done`.
- **Facts always cite an interaction.** `remember` without a source creates a
  hidden `note` interaction on channel `retainer` for the fact to cite
  (`memory/facts.ts`). Field assertions cite an interaction or nothing (a
  direct write). Premise-fact sources and `inferred` facts are reserved in the
  schema with no write path.
- **`interactions.metadata` is dead.** The strict input schema rejects it, the
  insert never sets it, and nothing reads it.
- **Explicit links never move.** ARCHITECTURE.md 1.3 already rejects
  inferring `about` links from a participant's company, because a job change
  would move old meetings. Stored links are fixed at logging time.
- **Relations are many-to-one only** (`shared/src/schema.ts`). Interaction
  participant and `about` rows are the only many-to-many links in the system.
- **Field history is readable over REST but not MCP.**
  `GET /v1/records/:id/assertions` serves the web app; no MCP tool returns
  assertion history.
- **The consolidator** supersedes exact-duplicate facts and suggests record
  merges. Nothing else.

## 2. Decisions

| #   | Decision                                                                                                                      | Answers                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| D1  | Object types have a class, `entity` or `event`. Interactions become records of event-class object types.                     | Fixed kinds; custom interaction fields; one schema system     |
| D2  | Event types carry protected core fields that the schema engine creates.                                                       | Which interaction information stays protected                 |
| D3  | Server code protects exactly what it depends on: those objects and fields cannot be deleted or reshaped.                      | Base field gap (section 1)                                    |
| D4  | Evidence is event records. A claim derived from other data cites the assertions it rests on, never a whole entity record.     | Records as sources; keeping the cited version                 |
| D5  | An event and a managed workflow object are different things. Link them; do not merge them.                                   | One event serving a workflow and evidence                     |
| D6  | A relation field can opt in to rolling up events: events of the source record show on the target record, read-time, one hop. | Reliable inclusion of related events                          |
| D7  | A record timeline merges events, field changes and facts at read time, over REST and MCP.                                     | Event history versus field-change history; complete history   |
| D8  | Explicit links stay fixed at logging time. Rollups follow the current relation.                                               | Historical links                                              |
| D9  | Drop `interactions.metadata` and the separate interaction tables.                                                             | Metadata follow-up                                            |
| D10 | Background maintenance is deferred. The consolidator stays deterministic.                                                    | Scope of background maintenance                               |

Views, filters and dashboards over typed event information follow from D1:
they already work per object type.

## 3. Data model

### 3.1 Object classes (D1)

`object_types.class`: `entity` (default) or `event`. The class is set when
the object is created and never changes; turning an entity into an event is a
new object type, like a field type change (rule 3).

- **Entity** types are today's objects: people, companies, deals, invoices.
- **Event** types describe something that happened at a point in time: Meeting,
  Email, Call, Message, Note, and anything an agent or template defines, such
  as Form submission or Payment received.

Event records live in `records` and use the normal machinery: `records.data`
derived from `field_assertions`, custom fields, views, search, soft delete.

What differs for event records:

| Concern               | Event records                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Created by            | `log_event` only; `upsert_record` refuses event types on create                                   |
| Identity columns      | `occurred_at`, `channel`, `external_id` (section 3.2); immutable after logging                    |
| Links                 | Participants and `about` records (section 3.3)                                                    |
| Citable as a source   | Yes; entity records are not                                                                       |
| Deleting              | Retracts every claim citing it (today's interaction retraction, rule 2.1); same permissions       |
| Merging               | Not allowed; deduplication is by `(channel, external_id)`; no merge suggestions                   |
| Updating fields       | Non-core and core text fields through `upsert_record`, as assertions; identity columns never     |

### 3.2 Event core (D2)

Every event type has:

- **Identity columns** on a 1:1 table `event_records` (`record_id` primary
  key, `workspace_id`, `occurred_at`, `channel`, `external_id`). These are
  built-in columns, like `created_at` on every record: real columns, not
  schema fields, filterable and sortable in queries and views. They keep
  today's indexes: unique `(workspace_id, channel, external_id)` where
  `external_id` is not null, and `(workspace_id, occurred_at)`.
- **Core fields** the engine adds on `create_object` with class `event`:
  `title` (text, searchable) and `summary` (text, searchable), and `title` as
  the label field. They are marked `fields.core` (`title` or `summary`), so
  server code finds them by role, not by name or universal ID.

Agents and templates add any other fields: `durationMinutes` on Meeting,
`amount` on Payment received, `formName` on Form submission.

The re-logging rules of ARCHITECTURE.md 1.3 carry over: logging the same
`(channel, external_id)` again with the same `occurred_at`, title and summary
returns the existing event and adds missing links; any difference is an
`event_conflict`. Custom field values in a re-log follow the same rule.

### 3.3 Event links

`interaction_participants` becomes `event_links`, with `event_record_id`
referencing an event-class record. Columns, `link` values (`participant`,
`about`), handle matching, unmatched reasons, ordering, locking and the
person-only removal rule are unchanged. An `about` target can be any live
record, entity or event.

### 3.4 Base event types

The base template adds five event types beside person, company and task:
`meeting`, `call`, `email`, `message`, `note`, with fixed universal IDs.

- `note` is protected (D3): `remember` writes its uncited facts' notes there.
- The other four are ordinary base-template objects: a workspace can delete
  the ones it never uses.

Industry templates may add event types and fields to the base ones.

### 3.5 Protection rule (D3)

`fields.is_protected` and `object_types.is_protected` are set by the engine
for exactly what server code reads:

- objects: person, company, task, note;
- fields: `task.status`, `task.dueDate`, and every event core field.

A protected object refuses `delete_object`. A protected field refuses
`delete_field` and any `update_field` other than `label` and `description`.
Renaming stays allowed, since server code never reads by name. New server
code that reads a schema element by universal ID or core role must mark it
protected in the same change.

### 3.6 Sources and premises (D4)

- `field_assertions.source_interaction_id` becomes `source_record_id`;
  `fact_sources.interaction_id` becomes `source_record_id`. Both must
  reference an event-class record in the same workspace.
- A derived claim cites **assertions**: a new `assertion_premises
  (assertion_id, premise_assertion_id)` table, and `fact_sources.premise_fact_id`
  is replaced by `premise_assertion_id`. Assertions are never edited, only
  superseded, so a premise pins the exact value it relied on even after the
  record changes. A fact with premises has `kind = 'inferred'`.
- Writes take `source` (an event record ID), `premises` (assertion IDs), both,
  or neither (a direct write).

Not decided: whether a superseded or retracted premise should flag the claims
built on it. Premises are the last phase (section 5), and only start when an
agent workflow needs them.

### 3.7 Rollups (D6, D8)

A `many_to_one` relation field gains `settings.rollUpEvents` (default
`false`). When true, events linked to a source record also appear on the
target record: on `appointment.patient`, the emails about an appointment
appear on the patient.

- **Read-time, one hop.** Nothing is copied. Correcting the relation corrects
  what is shown. Rollups do not chain.
- **Stable relations only.** Enable it where the source belongs to the target
  for good (`appointment.patient`, `invoice.company`, `deal.company`), not on
  affiliations that change (`person.company`), where a job change would move
  old meetings. That is why it is opt-in per field.
- **Explicit links stay fixed** (D8). A rollup follows the current relation;
  that is acceptable because only stable relations enable it.
- Every rolled-up item says how it arrived: `via: { field, record }`. An event
  linked both directly and through a rollup appears once, as direct.

Template defaults: `true` on `task.person`, `task.company`,
`appointment.person`, `deal.company`, `deal.pointOfContact`,
`project.company`, `project.primaryContact`, `proposal.company`,
`proposal.project`, `viewing.person`, `viewing.property`, `job.company`,
`application.person` and `application.job`. `false` on `person.company` and
`property.owner`, which change when people move jobs or properties are sold.

### 3.8 Timeline (D7)

`GET /v1/records/:id/timeline`, MCP `get_timeline` and the SDK return one
stream for a record, newest first, cursor-paginated:

| Item type      | Comes from                                                                             | Time            |
| -------------- | -------------------------------------------------------------------------------------- | --------------- |
| `event`        | Events linked to the record, and rolled-up events (with `via`)                         | `occurred_at`   |
| `field_change` | The record's assertions that are or were the winning value (`active`, `superseded`)    | `observed_at`   |
| `fact`         | The record's facts, including superseded ones                                          | `valid_from`    |

Filters: item types, field names, event types, and a time range. Field changes
of related records do not roll up; open the related record's timeline.

Timeline reads are built from existing tables. No history table is added.

### 3.9 Removed

`interactions`, `interaction_participants` (renamed), `interactions.metadata`,
`fact_sources.premise_fact_id` (replaced), the
`query_interactions` MCP tool and `POST /v1/interactions/query` (replaced by
`query_records` over event types and by the timeline), and
`log_interaction` (renamed `log_event`).

## 4. Interfaces

- **`log_event`** (MCP) and `POST /v1/events` (REST): `type` (an event
  object's name), `occurredAt`, `channel`, `externalId`, `title`, `summary`,
  `fields` (custom values), `participants`, `about`. The reserved channel
  `retainer` stays reserved for `remember` notes.
- **`query_records`** works on event types, with the built-in identity columns
  and a `linked: { record, link? }` filter. Cross-type questions ("everything
  that happened with Dana") go to the timeline.
- **`get_context`**: `recentInteractions` becomes `recentEvents`, including
  rollups, with `via`.
- **`describe_schema`** lists event types among objects, with their class, and
  stops listing `interaction` as a built-in. `fact` stays built-in.
- **Search** covers event records through their searchable fields; `remember`
  notes stay excluded from search and queries, as now.
- **Privacy** (ARCHITECTURE.md 2.1): `forget` applies to event records exactly
  as it applies to interactions today, including keeping events that are only
  `about` the forgotten record. Port its tests unchanged in intent.

## 5. Implementation order

Each phase is one PR that leaves `main` working, and updates ARCHITECTURE.md,
the agent guides (`mcp/guides.ts`), `docs/` and the SDK for what it changes.
Phases 1 to 3 change storage together and may share one generated migration
series; no data migration is needed.

| Phase | Scope                                                                                                                                                                                       | Depends on | Why here                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| 0     | Protection rule (3.5) for today's schema: `is_protected` on objects and fields; protect `task.status` and `task.dueDate`.                                                                  | None       | Fixes a real gap now; small; independent of everything else                                 |
| 1     | Schema engine: `class`, event core fields, `core` role, protection of core fields; base event types (3.4); event types in templates. No storage of event records yet.                     | 0          | Every later phase needs event types to exist                                                |
| 2     | Write path: `event_records`, `event_links`, `log_event`, re-log and conflict rules, participant matching, `remember` notes on `note`, sources re-pointed (3.6, first bullet), event deletion as retraction, `forget`. Drop the old tables and `metadata`. | 1          | Moves storage in one step, while nothing depends on the old tables                          |
| 3     | Read paths: `query_records` over events, search, `get_context` `recentEvents`, `describe_schema`; web app interaction screens moved to event records.                                    | 2          | Restores every read the old tables served                                                   |
| 4     | Rollups (3.7): field setting, template defaults, rollups in event lists and context packs.                                                                                                 | 3          | Needs event reads; the timeline consumes it                                                 |
| 5     | Timeline (3.8): REST, MCP, SDK; a web timeline tab.                                                                                                                                        | 4          | Closes the MCP field-history gap and the "complete history" question                        |
| 6     | Premises (3.6, second bullet): `assertion_premises`, `premise_assertion_id`, `inferred` facts.                                                                                            | 2          | Last: nothing needs it until an agent workflow derives claims from other claims             |

Testing, per CLAUDE.md and ARCHITECTURE.md 12:

- Phases 0 and 1: engine unit tests for class immutability, core fields and
  every protection refusal.
- Phase 2: port every interaction integration test to events, against real
  Postgres. Keep the concurrency tests: concurrent `log_event` with the same
  `(channel, external_id)` lands once; concurrent link additions each land
  once; retraction racing a citing write.
- Phase 4: a rollup appears through an opted-in relation, disappears when the
  relation changes, and never appears through `person.company`.
- Phase 5: timeline ordering and pagination across all three item types, with
  rollups.

## 6. Deferred and not decided

- **Background maintenance** (D10): deduplication, link repair, schema
  evolution and backfills stay agent work through the public API, plus an
  agent guide. Revisit with real workloads. The consolidator stays
  deterministic and never calls a model.
- **Premise invalidation:** what happens to claims whose premises are later
  superseded or retracted (3.6).
- **Field changes on related records** in a timeline (3.8).
- **Showing participants and `about` links as view columns** for event types
  in the web app.
