// better-auth lists test and migration tools as optional peers. pnpm links
// them to the workspace's own copies (vitest at the root, drizzle-kit in the
// server's devDependencies), so `pnpm deploy --prod` ships them, and their
// build tools (esbuild, vite, rolldown), in the server package
// (deploy/aws/build.sh, the Docker image). Retainer uses neither entry point
// that needs them: better-auth's test utilities and its CLI.
const UNUSED_PEERS = ['vitest', 'drizzle-kit'];

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    for (const name of UNUSED_PEERS) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[name];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
