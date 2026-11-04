# Self-hosting

Retainer is one Docker image and Postgres 17. The image runs the REST API, the
MCP endpoint, the background workers and, optionally, the web app. To run it
on AWS Lambda and RDS instead, see [Deploying to AWS](aws.md).

## Start it

```sh
git clone https://github.com/Tamloot-cc/Retainer.git
cd Retainer
docker compose -f docker/compose.yml up --build -d
curl localhost:8787/health
# {"status":"ok","version":"0.1.0","database":"ok"}
```

The container applies pending database migrations every time it starts, then
starts the server. On first boot it creates a workspace named `Default` and
prints an admin API key once:

```sh
docker compose -f docker/compose.yml logs retainer
```

Save that key; Retainer stores only its hash. It acts as `user:admin` with
every scope.

## Workspaces and API keys

Workspaces and keys are managed with the operator CLI inside the container. It
connects to the database directly; there is no admin HTTP API, and no API key
can create a workspace or another key.

```sh
alias retainer='docker compose -f docker/compose.yml exec retainer retainer'

retainer workspace create --name "Acme Clinic" --template clinic
retainer workspace list
retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
retainer key list --workspace acme-clinic
retainer key revoke <key-id>
```

`key create` prints the key (`rtn_…`) once. Add `--json` to any command for
machine-readable output.

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

Set these on the `retainer` service in `docker/compose.yml`, or in `.env`
when running from source.

| Variable                                | Default          | Purpose                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                          | —                | Postgres connection string. Required.                                                                                                                                                                                                                                                                                                                       |
| `RETAINER_ROLE`                         | `all`            | `api` (REST, MCP, web app), `worker` (scheduled consolidator) or `all`. Split them to run the API and the workers in separate containers.                                                                                                                                                                                                                   |
| `PORT`                                  | `8787`           | HTTP port.                                                                                                                                                                                                                                                                                                                                                  |
| `LOG_LEVEL`                             | `info`           | `debug`, `info`, `warn` or `error`.                                                                                                                                                                                                                                                                                                                         |
| `RETAINER_PUBLIC_ORIGIN`                | —                | The browser-facing origin when TLS ends at a reverse proxy, e.g. `https://retainer.example`. Used for CSRF checks and the session cookie. Forwarded headers are never trusted.                                                                                                                                                                              |
| `RETAINER_SUPPRESSION_KEY`              | —                | Needed for `forget`. At least 32 characters (`openssl rand -hex 32`). Keep it stable: erased emails, phones and event identities are stored only as an HMAC under this key. To rotate it, move the old key to `RETAINER_SUPPRESSION_PREVIOUS_KEYS`; dropping an old key lets its erased handles back in and blocks logging events until it is listed again. |
| `RETAINER_SUPPRESSION_PREVIOUS_KEYS`    | —                | Earlier suppression keys, comma-separated, still checked after a rotation so erased handles and events stay suppressed.                                                                                                                                                                                                                                     |
| `RETAINER_CONSOLIDATE_INTERVAL_MINUTES` | `60`             | How often the consolidator dedupes facts and suggests merges in each workspace.                                                                                                                                                                                                                                                                             |
| `RETAINER_WEB_DIR`                      | set in the image | Directory of the built web app, served at `/app`. Leave unset to serve no web app.                                                                                                                                                                                                                                                                          |
| `RETAINER_DB_POOL_MAX`                  | `10`             | Database connections the API process opens. Lower it when many processes share one database.                                                                                                                                                                                                                                                                |

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

## Upgrading

Pull the new release, rebuild and restart. Migrations run on start and are
forward-only, so back up the database before upgrading.

Run one version at a time: stop every Retainer container of the old version
before the new one starts. A migration can change what the server writes,
and an old server that keeps writing after it ran leaves rows the new one
does not expect. For example, search text written by an older server is
never rebuilt. With the single `retainer` container below, `up` does this.
With separate API and worker containers or several replicas, stop all of
them first, but not Postgres (for example
`docker compose -f docker/compose.yml stop retainer`).

```sh
docker compose -f docker/compose.yml exec postgres \
  pg_dump -U retainer retainer > retainer-$(date +%F).sql
git pull && docker compose -f docker/compose.yml up --build -d
```

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
