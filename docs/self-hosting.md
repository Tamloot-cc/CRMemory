# Self-hosting

Retainer is one Docker image and SurrealDB 4.0.0. The image runs the REST
API, the MCP endpoint, the background workers and, optionally, the web app,
in one process. `docker/compose.yml` runs both: SurrealDB on a single node
with persistent SurrealKV storage, pinned to the image digest Retainer is
tested against, and the `retainer` container.

## Start it

Retainer signs its own SurrealDB sessions, so it needs a signing key before
it starts. The CLI makes one without any configuration:

```sh
git clone https://github.com/Tamloot-cc/Retainer.git
cd Retainer
docker compose -f docker/compose.yml build
docker compose -f docker/compose.yml run --rm --no-deps retainer retainer signing-key generate
```

Set the printed value as `RETAINER_SIGNING_KEY`, and choose a SurrealDB
password, in the environment Compose reads (for example your shell, or an
env file passed with `--env-file`):

```sh
export RETAINER_SIGNING_KEY='<the printed key>'
export RETAINER_SURREAL_PASS='<a long random password>'
docker compose -f docker/compose.yml up -d
curl localhost:8787/health
# {"status":"ok","version":"0.1.0","database":"ok"}
```

Without `RETAINER_SURREAL_PASS`, Compose uses the development password
`retainer` for SurrealDB's root user. SurrealDB listens only on
`127.0.0.1:8000` of the host (`RETAINER_SURREAL_PORT` changes the port).

On every start the server brings the catalog and every workspace up to date
(fixed tables, signing keys, built-in objects and templates), then serves.
On first boot it creates a workspace named `Default` and prints an admin API
key once:

```sh
docker compose -f docker/compose.yml logs retainer
```

Save that key; Retainer stores only its hash. It acts as `user:admin` with
every scope.

**Run one Retainer process per SurrealDB namespace.** At start the server
takes a lease in the catalog and renews it every 10 seconds. A second
process against the same namespace refuses to start while the lease is
live, and a process that loses its lease stops accepting writes and exits.
Replicas and separate API and worker containers are not supported.

## Workspaces and API keys

Workspaces and keys are managed with the operator CLI inside the container.
It connects to SurrealDB with the system credential (`RETAINER_SURREAL_USER`
and `RETAINER_SURREAL_PASS`); there is no admin HTTP API, and no API key can
create a workspace or another key.

```sh
alias retainer='docker compose -f docker/compose.yml exec retainer retainer'

retainer workspace create --name "Acme Clinic" --template clinic
retainer workspace list
retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
retainer key list --workspace acme-clinic
retainer key revoke <key-id>
retainer signing-key generate
```

`key create` prints the key (`rtn_…`) once. Add `--json` to any command for
machine-readable output.

Each workspace gets its own SurrealDB database in the namespace
(`ws_` followed by the workspace ID without dashes); the `catalog` database
holds workspaces and hashed keys. Agents and apps never talk to SurrealDB:
they call Retainer with an API key.

**Give every agent and every person their own key.** The key decides which
workspace a call acts on and who its writes are attributed to.

| Scope          | Allows                                                               |
| -------------- | -------------------------------------------------------------------- |
| `read`         | Reading the schema, records, events, facts, search and context packs |
| `write`        | Creating and updating records, logging events, `remember`, review    |
| `schema:write` | Applying templates and requesting schema changes                     |
| `admin`        | Everything above, plus deciding proposed schema changes and `forget` |

The actor type matters as much as the scope:

| Actor type    | Use for                  | Notes                                                                                                                                                                                                                                     |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`        | People, and the web app  | Highest precedence. Only users can accept or reject pending values, merge records, dismiss merge suggestions and run `forget`; only a user with `admin` applies destructive schema changes or approves proposed ones.                     |
| `integration` | Syncs from other systems | Outranks agents, ranks below people.                                                                                                                                                                                                      |
| `agent`       | AI agents                | Cannot silently overwrite a value a person or integration set: a newer agent value waits in review. Destructive schema changes it requests (rename, remove, make required or unique) are proposed, not applied, even with an `admin` key. |
| `system`      | Retainer's own jobs      | Lowest precedence. Not for keys you hand out.                                                                                                                                                                                             |

## Configuration

Set these on the `retainer` service in `docker/compose.yml` (most are passed
through from the environment), or in `.env` when running from source.

| Variable                                | Default                 | Purpose                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETAINER_SURREAL_URL`                  | `http://127.0.0.1:8000` | SurrealDB's HTTP endpoint. Compose sets `http://surrealdb:8000`.                                                                                                                                                                                                                                                                                            |
| `RETAINER_SURREAL_NAMESPACE`            | `retainer`              | The namespace holding the catalog and every workspace database.                                                                                                                                                                                                                                                                                             |
| `RETAINER_SURREAL_USER`                 | `root`                  | The system user. Used only for definitions, provisioning, upgrades and the operator CLI; requests run on short-lived sessions signed with the signing key.                                                                                                                                                                                                  |
| `RETAINER_SURREAL_PASS`                 | —                       | The system user's password. Required. Compose passes the same value to SurrealDB (`retainer` if unset).                                                                                                                                                                                                                                                     |
| `RETAINER_SURREAL_AUTH_LEVEL`           | `root`                  | `root`, or `namespace` for a system user defined on the namespace.                                                                                                                                                                                                                                                                                          |
| `RETAINER_SIGNING_KEY`                  | —                       | Required. Signs the server's database sessions; `retainer signing-key generate` prints one. See [Rotating the signing key](#rotating-the-signing-key).                                                                                                                                                                                                      |
| `RETAINER_SIGNING_PREVIOUS_KEYS`        | —                       | Earlier signing keys, comma-separated, still accepted during a rotation.                                                                                                                                                                                                                                                                                    |
| `RETAINER_SIGNING_REVOKED_KEY_IDS`      | —                       | IDs of compromised signing keys, comma-separated; each workspace drops them in its next upgrade.                                                                                                                                                                                                                                                            |
| `PORT`                                  | `8787`                  | HTTP port.                                                                                                                                                                                                                                                                                                                                                  |
| `LOG_LEVEL`                             | `info`                  | `debug`, `info`, `warn` or `error`.                                                                                                                                                                                                                                                                                                                         |
| `RETAINER_PUBLIC_ORIGIN`                | —                       | The browser-facing origin when TLS ends at a reverse proxy, e.g. `https://retainer.example`. Used for CSRF checks and the session cookie. Forwarded headers are never trusted.                                                                                                                                                                              |
| `RETAINER_SUPPRESSION_KEY`              | —                       | Needed for `forget`. At least 32 characters (`openssl rand -hex 32`). Keep it stable: erased emails, phones and event identities are stored only as an HMAC under this key. To rotate it, move the old key to `RETAINER_SUPPRESSION_PREVIOUS_KEYS`; dropping an old key lets its erased handles back in and blocks logging events until it is listed again. |
| `RETAINER_SUPPRESSION_PREVIOUS_KEYS`    | —                       | Earlier suppression keys, comma-separated, still checked after a rotation so erased handles and events stay suppressed.                                                                                                                                                                                                                                     |
| `RETAINER_CONSOLIDATE_INTERVAL_MINUTES` | `60`                    | How often the consolidator dedupes facts and suggests merges in each workspace.                                                                                                                                                                                                                                                                             |
| `RETAINER_WRITE_QUEUE_LIMIT_MS`         | `10000`                 | How long a write waits for its workspace's write queue before a retryable `workspace_busy` error. Writes to one workspace run one at a time.                                                                                                                                                                                                                |
| `RETAINER_WEB_DIR`                      | set in the image        | Directory of the built web app, served at `/app`. Leave unset to serve no web app.                                                                                                                                                                                                                                                                          |

Keep `RETAINER_SURREAL_PASS`, the signing keys and the suppression keys in
your deployment's secret storage, not in Git or next to database exports.

## The web app

The image serves the review and records app at `http://<host>:8787/app/`.
Create a personal key for each reviewer with a `user` actor:

```sh
retainer key create --workspace acme-clinic \
  --name "Dana (web)" --actor user:dana --scopes read,write,admin
```

The key is entered once on the sign-in screen and kept in an HTTP-only,
same-site cookie, never in browser storage. Outside localhost, serve Retainer
over HTTPS; Secure cookies require it. Revoking the key ends access at once.

## Backups

A backup is a SurrealDB export of every database in the namespace (the
`catalog` and one per workspace), plus the secrets: the signing keys and the
suppression keys. Database exports alone cannot be used without them, and
the suppression keys must stay the same after a restore, or erased handles
come back.

Stop Retainer first, so no write lands between the exports; leave SurrealDB
running. `surreal export` writes one database per call:

```sh
compose='docker compose -f docker/compose.yml'
ns=${RETAINER_SURREAL_NAMESPACE:-retainer}
export_db() {
  $compose exec -T surrealdb /surreal export --user "${RETAINER_SURREAL_USER:-root}" \
    --pass "$RETAINER_SURREAL_PASS" --ns "$ns" --db "$1" > "backup/$1.surql"
}
ids=$($compose exec -T retainer retainer workspace list --json | jq -r '.[].id')
$compose stop retainer
mkdir -p backup
export_db catalog
for id in $ids; do export_db "ws_$(echo "$id" | tr -d -)"; done
$compose start retainer
```

To restore, import each file into the database of the same name with
`surreal import --ns retainer --db <name> <file>`, then start Retainer
with the same signing and suppression keys. Practice a restore into a
separate SurrealDB instance, and check that `/health` is ok, that existing
API keys still authenticate and that each workspace's records read back.
Erasure (`forget`) does not reach backups taken before it, and Retainer
does not claim that a delete removes data from SurrealDB's storage files;
backup retention is the operator's responsibility.

## Upgrading

Pull the new release, rebuild and restart. There are no migration files: on
start, the server brings the catalog's and each workspace's fixed tables to
the release's definitions, and adds the base objects, event types and template
fields the release defines to workspaces created before it. It logs each
workspace it upgraded. It never re-creates what a workspace deleted. If a
workspace's own object already uses a new built-in name, the log says so;
rename that object and restart to add the built-in one. A request for a
workspace the server has not reached yet upgrades that workspace first.

If release notes say search changed, or search results look stale, rebuild the
search documents with `retainer search rebuild` (every workspace) or
`retainer search rebuild --workspace <slug>`. It writes in small batches under
the normal write rules, so the server can keep running.

Run one version at a time. The process lease already stops a second
server from starting while the first runs, so stop the old container before
the new one starts; with the single `retainer` container, `up` does this.
Back up first:

```sh
# Back up as above, then:
git pull && docker compose -f docker/compose.yml up --build -d
```

### Rotating the signing key

1. Generate a new key with `retainer signing-key generate`. Set it as
   `RETAINER_SIGNING_KEY` and move the old value to
   `RETAINER_SIGNING_PREVIOUS_KEYS`. Restart.
2. On start, every workspace accepts the new key as it is upgraded; the log
   shows each one. Workspaces keep working through the change.
3. Once every workspace has been upgraded, remove the old key from
   `RETAINER_SIGNING_PREVIOUS_KEYS` and restart. Its access is removed from
   every workspace.

If a key is compromised, also list its ID (the part before the `:`) in
`RETAINER_SIGNING_REVOKED_KEY_IDS`: each workspace then drops it in the same
upgrade that adds the new key, and a request for a workspace not yet
upgraded waits for that upgrade. The current key cannot be revoked.

## Privacy requests

`POST /v1/records/:id/forget` hard-deletes a person: the record with its
facts and assertions, and the events they took part in, along with the
claims and facts that rested only on those events. Their emails and phones
are kept only as keyed hashes, so agents cannot recreate the person from old
email, and so are the source IDs of erased events, so logging the same
source again is refused. It needs a `user` key with the `admin` scope and
`RETAINER_SUPPRESSION_KEY` set. The response gives counts only, plus other
rows that may still mention the person for someone to review; Retainer does
not edit free text on its own.
