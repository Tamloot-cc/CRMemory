#!/usr/bin/env node
import { ConfigError, readConfig, startBridge } from './bridge.js';
import { VERSION } from './version.js';

const USAGE = `retainer-mcp ${VERSION}: stdio bridge to a Retainer server's MCP endpoint.

Environment:
  RETAINER_URL      the server's base URL, e.g. https://retainer.example.com
  RETAINER_API_KEY  an API key for one workspace (rtn_...)

Speaks MCP on stdin and stdout; diagnostics go to stderr.`;

const arg = process.argv[2];
if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (arg === '--help' || arg === '-h') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

try {
  const bridge = await startBridge(readConfig(process.env), process.stdin, process.stdout);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void bridge.close());
  }
  await bridge.closed;
  // After a signal stdin is still open and would keep the process alive.
  process.stdin.destroy();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`retainer-mcp: ${error.message}\n\n${USAGE}\n`);
  process.exitCode = 1;
}
