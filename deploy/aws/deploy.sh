#!/usr/bin/env bash
# Ships a package built by build.sh to a deployment Terraform created.
#   AWS_REGION=eu-central-1 deploy/aws/deploy.sh [--name retainer] [--package path.zip]
#
# One version runs at a time (docs/self-hosting.md, Upgrading), so this:
#   1. updates the ops function, which runs migrations,
#   2. stops the api and consolidate functions (reserved concurrency 0),
#   3. migrates,
#   4. updates api and consolidate,
#   5. starts them again with the concurrency Terraform set.
# Requests during steps 2-5 get 503 from API Gateway, usually for well under
# a minute. If the migration fails, the functions stay stopped and the
# script exits non-zero: fix the cause, then run it again.
set -euo pipefail

name=retainer
package="$(cd "$(dirname "$0")" && pwd)/.build/retainer.zip"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --package) package="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
: "${AWS_REGION:?set AWS_REGION}"
test -f "$package" || { echo "No package at $package; run build.sh first." >&2; exit 1; }

update() {
  echo "Updating $1"
  aws lambda update-function-code --function-name "$1" --zip-file "fileb://$package" >/dev/null
  aws lambda wait function-updated --function-name "$1"
}

stop() {
  echo "Stopping $1"
  aws lambda put-function-concurrency --function-name "$1" \
    --reserved-concurrent-executions 0 >/dev/null
}

start() {
  local arn concurrency
  arn="$(aws lambda get-function-configuration --function-name "$1" --query FunctionArn --output text)"
  concurrency="$(aws lambda list-tags --resource "$arn" \
    --query 'Tags."retainer:reserved-concurrency"' --output text)"
  echo "Starting $1 (concurrency $concurrency)"
  aws lambda put-function-concurrency --function-name "$1" \
    --reserved-concurrent-executions "$concurrency" >/dev/null
}

update "$name-ops"

stop "$name-api"
stop "$name-consolidate"
# Stopping only blocks new invocations. Let API requests already running on
# the old version finish (the function times out after 29 seconds); the
# migration itself waits for a consolidator pass in flight (deploy-lock.ts).
sleep 30

echo "Migrating"
result="$(mktemp)"
trap 'rm -f "$result"' EXIT
error="$(aws lambda invoke --function-name "$name-ops" \
  --cli-binary-format raw-in-base64-out --payload '{"command":"migrate"}' \
  --cli-read-timeout 900 "$result" --query FunctionError --output text)"
if [ "$error" != "None" ]; then
  echo "Migration failed; $name-api and $name-consolidate stay stopped:" >&2
  cat "$result" >&2
  echo >&2
  exit 1
fi
cat "$result"
echo

update "$name-api"
update "$name-consolidate"
start "$name-api"
start "$name-consolidate"
echo "Deployed."
