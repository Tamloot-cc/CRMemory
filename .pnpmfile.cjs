// better-auth lists vitest and drizzle-kit as optional peers. pnpm links them
// to the workspace's own copies, so `pnpm deploy --prod` shipped them and
// their build tools (esbuild, vite, rolldown) in the server package. Retainer
// uses neither entry point that needs them: the test utilities and the CLI.
const UNUSED_PEERS = ['vitest', 'drizzle-kit'];

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    for (const name of UNUSED_PEERS) {
      delete pkg.peerDependencies?.[name];
      delete pkg.peerDependenciesMeta?.[name];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
