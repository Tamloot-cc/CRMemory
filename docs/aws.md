# Deploying to AWS

`deploy/aws` runs Retainer on AWS without containers: the same server code as
the Docker image, as Lambda functions behind API Gateway, with PostgreSQL on
RDS. Everything stays in one AWS account and region, and nothing else
(no CDN, no other service) sees the traffic or the data.

For a single server, the Docker image in [Self-hosting](self-hosting.md) is
simpler. This deployment suits a hosted service: no server to patch, a
managed database with point-in-time recovery, and a bill that follows use.

## What it creates

| Piece                                        | AWS service                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| REST (`/v1`), MCP (`/mcp`), web app (`/app`) | `<name>-api` Lambda function behind an API Gateway HTTP API               |
| Consolidator                                 | `<name>-consolidate` function, run by EventBridge every 15 minutes        |
| Migrations and the operator CLI              | `<name>-ops` function, invoked by `deploy.sh` and `ops.sh`                |
| Database                                     | RDS PostgreSQL 17, encrypted, private, 14 days of point-in-time backups   |
| Network                                      | A VPC of its own with two private subnets, no internet gateway or NAT     |
| Monitoring                                   | Log groups (30 days), alarms on 5xx, consolidator errors and the database |
| Custom domain (optional)                     | ACM certificate and an API Gateway domain                                 |
| CI deploy role (optional)                    | IAM role a GitHub Environment assumes to ship code                        |

The functions reach only the database, and the database only accepts the
functions. Retainer makes no outbound calls, so there is no route to the
internet to pay for or secure.

With the defaults, a small deployment costs about $17–20 a month in
eu-central-1: the `db.t4g.micro` instance (about $14), 20 GB of storage, and
cents for Lambda, API Gateway and logs at personal volume.

## Before you start

- An AWS account and credentials that can create the resources above.
- Terraform 1.10 or later, AWS CLI v2, `jq`, Node 22 and pnpm.

All commands run from the repository root unless noted, with `AWS_REGION`
set:

```sh
export AWS_REGION=eu-central-1
```

## First deployment

1. Create the bucket for Terraform's state. It prints the backend
   configuration:

   ```sh
   deploy/aws/state-bucket.sh > deploy/aws/backend.hcl
   ```

2. Copy `deploy/aws/terraform.tfvars.example` to `deploy/aws/terraform.tfvars`
   and set at least `region`. Both files are gitignored. `name` (default
   `retainer`) prefixes every resource and must be unique in the AWS
   account, because IAM role names are account-wide: a second deployment,
   in this region or another, needs a name of its own (and
   `state-bucket.sh <name>`).

3. Build the Lambda package and create the infrastructure. The database takes
   5–10 minutes:

   ```sh
   deploy/aws/build.sh
   cd deploy/aws
   terraform init -backend-config=backend.hcl
   terraform apply
   cd ../..
   ```

4. Migrate the database and start the functions:

   ```sh
   deploy/aws/deploy.sh
   ```

5. Create a workspace and keys. `ops.sh` takes the same commands as the
   [operator CLI](self-hosting.md#workspaces-and-api-keys):

   ```sh
   deploy/aws/ops.sh workspace create --name "Acme" --template sales
   deploy/aws/ops.sh key create --workspace acme --name "Maya (web)" \
     --actor user:maya --scopes read,write,admin
   deploy/aws/ops.sh key create --workspace acme --name "Inbox agent" \
     --actor agent:inbox --scopes read,write,schema:write
   ```

   Unlike the container, this deployment creates no workspace and prints no
   key on its own: a key printed at boot would land in the logs.

6. Check it, using the `public_origin` output:

   ```sh
   curl "$(terraform -chdir=deploy/aws output -raw public_origin)/health"
   # {"status":"ok","version":"0.1.0","database":"ok"}
   ```

Connect agents to `<public_origin>/mcp` as in
[Connecting agents](agents.md), and open the web app at
`<public_origin>/app/`.

## A custom domain

The API Gateway URL works as is. To serve Retainer on your own domain:

1. Set `domain_name` in `terraform.tfvars` and apply. The `dns_records`
   output lists the certificate's validation record.
2. Create that record at your DNS provider and wait until the certificate
   shows as issued in ACM (usually a few minutes).
3. Set `domain_certificate_validated = true` and apply again. `dns_records`
   now also lists the CNAME for the domain itself; create it.

The domain becomes the only way in: the API Gateway URL is turned off, and
`RETAINER_PUBLIC_ORIGIN` is set to the domain, so sign-in from the web app
works only there. Create the records as DNS only: a proxy in front (such as
Cloudflare's orange cloud) would see every request.

## Shipping new versions

`deploy.sh` ships the package `build.sh` made. Because one version runs at
a time (see [Upgrading](self-hosting.md#upgrading)), it stops the API and
the consolidator, migrates, upgrades existing workspaces to the release's
built-in definitions (printed under `workspaceUpgrade` in the migration
result), updates them and starts them again. Requests in
that window, usually under a minute, get `503`. If the migration fails, the
functions stay stopped; fix the cause and run `deploy.sh` again. Stopping a
function only blocks new runs, so the migration first waits, up to 330
seconds, for a consolidator pass already running on the old version to
finish (a Postgres lock each pass holds); if one is still running, nothing
is migrated and the deploy fails, to be run again.

```sh
deploy/aws/build.sh && deploy/aws/deploy.sh
```

Terraform creates the functions with the package and then leaves their code
alone, so `terraform apply` never rolls a deployment back to an old package.

### From GitHub Actions

The **Deploy to AWS** workflow runs CI, builds and runs `deploy.sh`, by hand
only. To use it:

1. Set `github_repository = "<owner>/<repo>"` in `terraform.tfvars` and
   apply. This creates a role that can update, stop, start and invoke this
   deployment's functions and nothing else. It trusts the account's OIDC
   provider for GitHub Actions. An account holds one, shared by every
   repository's roles, so this deployment uses it but never creates or
   deletes it. If `aws iam list-open-id-connect-providers` shows none for
   `token.actions.githubusercontent.com`, create it once:

   ```sh
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```
2. In the repository's settings, create the `production` environment.
   Under deployment branches, allow only the default branch: the role trusts
   every job in that environment.
3. Add the environment variables `AWS_ROLE_ARN` (the
   `github_deploy_role_arn` output) and `AWS_REGION`, and `RETAINER_NAME` if
   you changed `name`.

Infrastructure changes are not deployed from CI; run `terraform apply`
yourself.

## Operating it

**Logs.** Each function logs to `/aws/lambda/<name>-<function>`, and API
Gateway's access log (no headers or bodies) to `/aws/apigateway/<name>`.

**Alarms** publish to the `alarm_topic_arn` SNS topic. Set `alarm_email` to
subscribe an address; AWS emails a confirmation link first.

**Backups.** RDS keeps automated backups for `db_backup_retention_days`
(14 by default) and can restore to any second in that window, as a new
instance. Practise a restore before you need one. Deleting the instance
takes a final snapshot, named with a suffix of its own. To replace the
instance by hand, replace the suffix with it, so the new instance's final
snapshot gets a new name:
`terraform apply -replace=aws_db_instance.this -replace=random_id.final_snapshot`.

**Secrets.** Terraform generates the database password and
`RETAINER_SUPPRESSION_KEY` and keeps them in its state, so treat the state
bucket as secret. Never let Terraform replace `random_id.suppression_key`:
erased emails and phones are stored only as an HMAC under that key, so a new
key lets them back in.

**Connections.** Each API function instance holds up to `api_db_pool_max`
connections (2), and at most `api_reserved_concurrency` instances (10) run
at once. Keep their product, plus a few for the consolidator and ops
functions, under the instance's limit: about 80 on a `db.t4g.micro`. The
`database-connections` alarm warns at 60. `deploy.sh` owns the functions'
concurrency (it stops and starts them), so a new `api_reserved_concurrency`
takes effect at the next deploy, and `terraform apply` never restarts
functions that a failed deploy left stopped.

**Rate limiting.** Retainer has none of its own; API Gateway throttles at
`api_throttle_rate` requests per second (25) with bursts of
`api_throttle_burst` (50).

## Limits of this deployment

- A request runs for at most 29 seconds, and bodies are limited to API
  Gateway's 10 MB (Lambda's 6 MB once decoded).
- The first request to an idle function starts a new instance, which takes
  a second or two.
- The functions connect to the database over TLS without verifying the
  server's certificate (`sslmode=require`). The database is reachable only
  inside the VPC.
- MCP clients authenticate with an API key as a bearer token. Clients that
  only support OAuth, such as connectors added in Claude's web app, cannot
  connect yet.

## Removing it

```sh
cd deploy/aws
terraform apply -var db_deletion_protection=false
terraform destroy
```

`destroy` keeps a final snapshot of the database (`<name>-final-<suffix>`,
a suffix of its own per database, so a recreated deployment can be
destroyed again), and the
state bucket; delete those yourself when you no longer need them. Removing
the functions' network interfaces can take AWS up to half an hour, so the
subnets and security groups may be the last to go.
