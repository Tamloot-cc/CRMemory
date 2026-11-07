#!/usr/bin/env bash
# Builds the Lambda package: the same production install the Docker image
# ships (pnpm deploy of @retainer/server) plus the built web app, zipped.
#   deploy/aws/build.sh            -> deploy/aws/.build/retainer.zip
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/deploy/aws/.build"
cd "$root"

pnpm install --frozen-lockfile
pnpm --filter @retainer/shared build
pnpm --filter @retainer/sdk build
pnpm --filter @retainer/web build
pnpm --filter @retainer/server build

rm -rf "$out"
mkdir -p "$out"
pnpm --filter @retainer/server deploy --legacy --prod "$out/package" >/dev/null
cp -R packages/web/dist "$out/package/web"

# Lambda runs dist/lambda/*.js as ES modules: package.json has "type": "module".
test -f "$out/package/dist/lambda/api.js"
test -f "$out/package/dist/lambda/control.js"
test -d "$out/package/drizzle"

# Only what runs: no sources, tests or tool configs.
(cd "$out/package" && rm -rf src test e2e ./*.config.ts tsconfig*.json)
# -y keeps pnpm's symlinks as links instead of copying their targets.
(cd "$out/package" && zip -qry -X "$out/retainer.zip" .)
# deploy.sh uploads the zip directly, which Lambda accepts up to 50 MB.
test "$(wc -c <"$out/retainer.zip")" -le $((50 * 1024 * 1024)) ||
  { echo "The package is over Lambda's 50 MB upload limit." >&2; exit 1; }
echo "Built $out/retainer.zip ($(du -h "$out/retainer.zip" | cut -f1))"
