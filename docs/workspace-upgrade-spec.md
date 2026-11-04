# Upgrading existing workspaces to new built-in definitions

Date: November 5, 2026. Status: **decided; not implemented**.

## 1. Problem

The base objects, the base event types, the hidden internal-note type and the
templates ship as code with fixed `universal_id`s. The server applies them
through the schema engine only when a workspace is created or a template is
applied. A release that adds to those definitions leaves every older workspace
behind. ARCHITECTURE.md section 3 says so: "Upgrading existing workspaces to
newer definitions is not built yet", and template updates "have no upgrade path
yet".

PR #26 showed the cost. Workspaces created before it lack:

- the event types `meeting`, `call`, `email`, `message` and `note`, so
  `log_event` has nothing to log into;
- the hidden internal-note type, so `remember` without a source fails with
  `500 internal: this workspace has no internal-note type`;
- protection on `person`, `company`, `task`, `task.status` and `task.dueDate`.
  Migration 0012 added `is_protected` with default `false`, so these can be
  deleted or reshaped in old workspaces, although server code depends on them.

The deployed AWS workspace and every local workspace from before November 4
are in this state. The only fix today is a new workspace and new API keys.
From the first release on, that is not acceptable.

## 2. Goal

After a deployment's migrations run, every workspace has every built-in
element that the release defines and the workspace never had, and every
element server code depends on is protected. The upgrade never undoes a
workspace's own schema decisions. It never changes existing data.

## 3. Decisions

| Area          | Decision                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definitions   | For every workspace: the base operations, the base event types and the internal-note type, as `seedBaseObjects` applies them. Also the current operations of each template in `workspaces.templates`.                                                                                                                                                                             |
| Matching      | By `universal_id` only, never by name. An element whose ID exists in the workspace with any status, active or deprecated, counts as present. So a renamed element is matched, and a deleted element is not re-created.                                                                                                                                                            |
| What is added | Missing objects, with their fields. Missing fields on an object that is active in the workspace. Fields of a deprecated object are skipped with it. Inverse fields and the core fields of event types come with their owners, with the IDs the engine derives, as on creation.                                                                                                    |
| What is not   | Options, labels, descriptions, flags and settings of elements that exist, such as `rollUpEvents`. A removed option leaves no trace, so re-adding options could undo a workspace's decision. Changing what a workspace already has needs its own rules and is out of scope.                                                                                                        |
| Protection    | The trusted engine path sets `is_protected` on every element in `PROTECTED_OBJECT_IDS` and `PROTECTED_FIELD_IDS` that the workspace has, active or deprecated. Protection is never cleared. This is the only change to existing elements.                                                                                                                                         |
| Conflicts     | An element the workspace's schema cannot take is skipped and reported. Example: a custom active object named `meeting`, or a template field whose relation target was deleted. Everything else is still added. The workspace stays unstamped (below), so the next run reports the conflict again. After the workspace renames its own `meeting`, the next run adds the base type. |
| Path          | One `runSchemaChange` per workspace, as `SYSTEM_ACTOR`, owner `system`, `trusted: true`, reason `Upgrade built-in definitions`. It is recorded in `schema_changes` like any change and bumps `schema_version`. Additions only, so no approval is involved.                                                                                                                        |
| Templates     | After a workspace's upgrade, each of its `workspaces.templates` entries records the template's current version.                                                                                                                                                                                                                                                                   |
| Stamp         | `workspaces.definitions_digest`: SHA-256 of the definitions the workspace was last fully brought up to date with. That covers the base operations, the protection lists, and the names and operations of its applied templates. A workspace whose digest matches is skipped without loading its schema. A run that found conflicts or failed leaves the digest unchanged.         |
| When          | After migrations, wherever they run. `index.ts` boot runs it after `rebuildSearchText`, as the migration role. The ops Lambda's `migrate` command runs it inside the migration lock and adds the outcome to its result. Not on request: the API never writes schema on a read, and Lambda deploys already stop the API while `migrate` runs.                                      |
| Concurrency   | Each workspace upgrades in its own transaction, which holds the workspace's exclusive schema lock. It re-reads the digest and the schema under that lock. Two servers booting at once upgrade each workspace once; the second finds it current.                                                                                                                                   |
| Failure       | A workspace whose upgrade throws is logged and reported, and the others continue. Boot and `migrate` do not fail because of it. The workspace keeps its old schema, which stays usable, and the next run retries it.                                                                                                                                                              |
| Planning      | `planUpgrade(state, definitions)` is pure. It builds the candidate operations, applies and validates them in memory with the engine's own `applyOperations` and `validateSchema`, and removes the operations behind each issue until the rest validate. Those are the conflicts. `runSchemaChange` validates the result again.                                                    |

## 4. Interfaces

- `upgradeWorkspaces(sql)` in `packages/server/src/workspaces/upgrade.ts`
  returns `{ upgraded: string[]; conflicts: { workspace, element, message }[];
  failed: { workspace, message }[] }`, keyed by workspace slug.
- The ops Lambda's `migrate` result gains `workspaceUpgrade` with that shape.
  `deploy/aws/deploy.sh` already prints the result.
- Boot logs one line per upgraded workspace, conflict and failure.
- Schema change history (`GET /v1/schema/changes`) shows the upgrade as a
  change requested by `system:retainer`. Its diff can contain two new kinds,
  `protect_object` and `protect_field`.

No new REST, MCP or SDK operation. Clients cannot request protection: only the
trusted path sets it, as before.

## 5. Tests

Unit tests, pure, in `schema-engine` and `workspaces`:

- A workspace with only the base entity objects gets every event type and the
  internal-note type. One that has them gets nothing.
- A renamed base object is matched. A deleted (deprecated) base event type is
  not re-created.
- An active custom `meeting` entity is a conflict; the other event types are
  still planned.
- A template's missing object and a missing field on an existing object are
  planned. Fields of a template object the workspace deleted are not.
- A template field whose relation target is deprecated is a conflict.
- Protection is planned for unprotected base elements, and only on the trusted
  path.
- The digest changes when the base operations, the protection lists, or an
  applied template's operations change, and not when unrelated templates do.

Integration tests, real Postgres:

- A workspace built like a pre-#26 one (base entity objects only, protection
  cleared in the fixture) is upgraded. Then `log_event` and `remember` without
  a source both work, and `delete_object person` is refused. The change is in
  the history as `system:retainer`, and the digest is stamped.
- A second run changes nothing and records no change.
- Two upgrade runs at once produce exactly one schema change per workspace and
  no errors.
- A conflict leaves the digest unstamped, and adds everything else. After the
  custom object is renamed, the next run adds the missing type.
- The ops `migrate` result includes the upgrade outcome.

## 6. Out of scope

- Changing or removing existing elements, options or settings to match newer
  definitions.
- A command to upgrade one workspace on demand; deployments run it after
  migrations.
- Porting to the SurrealDB branch. That branch's spec (section 7) already
  requires each workspace to record its definitions revision and upgrade
  through its step runner; this behavior is what it will port.
