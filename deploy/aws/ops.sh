#!/usr/bin/env bash
# Runs the operator CLI (docs/self-hosting.md) against an AWS deployment,
# through the ops function: the database is not reachable from outside.
#   AWS_REGION=eu-central-1 deploy/aws/ops.sh [--name retainer] workspace list
#   AWS_REGION=eu-central-1 deploy/aws/ops.sh key create --workspace acme \
#     --name "Inbox agent" --actor agent:inbox --scopes read,write,schema:write
#
# The output, including a new key, comes back in the function's response
# only: the function does not log it.
set -euo pipefail

name=retainer
if [ "${1:-}" = "--name" ]; then
  name="$2"
  shift 2
fi
: "${AWS_REGION:?set AWS_REGION}"

# Arguments go through stdin, NUL-separated, so jq never reads them as its
# own options (--name, --json…).
payload="$(printf '%s\0' "$@" | jq -Rsc '{command: "cli", args: (split("\u0000") | .[:-1])}')"
result="$(mktemp)"
trap 'rm -f "$result"' EXIT

error="$(aws lambda invoke --function-name "$name-ops" \
  --cli-binary-format raw-in-base64-out --payload "$payload" \
  "$result" --query FunctionError --output text)"
if [ "$error" != "None" ]; then
  cat "$result" >&2
  echo >&2
  exit 1
fi

jq -r '.stdout | select(. != "")' "$result"
jq -r '.stderr | select(. != "")' "$result" >&2
exit "$(jq -r '.exitCode' "$result")"
