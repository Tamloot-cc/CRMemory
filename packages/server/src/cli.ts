#!/usr/bin/env node
import { loadConfig } from './config.js';
import type { Backend } from './db/backend.js';
import { backendFromConfig } from './db/connect.js';
import { ensureCatalog } from './db/provision.js';
import { runCli } from './operator/commands.js';
import { installUpgrader } from './workspaces/upgrade.js';

/**
 * `retainer`: the operator CLI (7.1). Talks to SurrealDB with the system
 * credential. The configuration is loaded only by commands that use the
 * database, so `signing-key generate` works before one exists.
 */
let backend: Backend | undefined;
const connect = () => {
  if (!backend) {
    backend = backendFromConfig(loadConfig());
    installUpgrader(backend);
  }
  return backend;
};
const [group] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (group === 'workspace' || group === 'key' || group === 'search') await ensureCatalog(connect());
process.exitCode = await runCli(process.argv.slice(2), {
  backend: connect,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
