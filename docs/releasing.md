# Releasing

A release publishes three MIT packages to npm and the server's Docker image to
GitHub Container Registry, then creates a GitHub release. The server and the
web app are not published to npm; they ship inside the image.

| Artifact                      | Where                                   |
| ----------------------------- | --------------------------------------- |
| `@retainer/shared`            | npm                                     |
| `@retainer/sdk`               | npm                                     |
| `@retainer/mcp`               | npm (`retainer-mcp` binary)             |
| Server, workers, web app, CLI | `ghcr.io/tamloot-cc/retainer:<version>` |

All packages share one version. `.github/workflows/release.yml` does the work;
`scripts/check-release.mjs` refuses a release whose package versions or
changelog disagree with the tag, or that would publish a non-MIT package. Every
workspace package not marked `private` is published.

## One-time setup

1. Create the `retainer` organization on npmjs.com (the `@retainer` scope)
   and an automation token that can publish to it.
2. Add the token to the repository as the `NPM_TOKEN` Actions secret.
3. After the first image push, make the `retainer` package on GitHub
   Container Registry public if the image should be pullable without login.

## Cut a release

1. Set `version` in each `packages/*/package.json`. The server and the bridge
   read their version from there at runtime.
2. Add a `## <version>` section to `CHANGELOG.md`.
3. Check locally, then merge to `main`:

   ```sh
   pnpm release:check v0.2.0
   pnpm build && pnpm -r publish --dry-run --no-git-checks
   docker build -f docker/Dockerfile .
   ```

4. Optionally run the **Release** workflow by hand from the Actions tab with
   _dry run_ checked: it runs CI, packs the npm packages and builds the
   multi-architecture image without publishing anything.
5. Tag `main` and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow checks versions, runs the full CI suite, publishes to npm with
provenance and to GHCR (`<version>`, `<major>.<minor>` and `latest`), and
creates the GitHub release with the changelog section as its notes. A version
with a pre-release suffix (`0.2.0-rc.1`) is not tagged `latest` and is marked
as a pre-release.

npm versions cannot be reused: if a publish fails halfway, fix the cause and
release the next patch version rather than re-tagging.
