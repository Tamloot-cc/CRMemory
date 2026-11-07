import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { type ServerType, serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_NAMES } from '../../src/mcp/guides.js';
import { callTool, startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * Layer 4 through `@retainer/mcp`: an MCP client speaks stdio to the bridge,
 * running as its own process, which relays to the server over real HTTP.
 */

const db = useTestDatabase();
const BRIDGE = fileURLToPath(new URL('../../../mcp/src/index.ts', import.meta.url));
const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
/** Runs the bridge from source; tsx resolves from the server package. */
const NODE_ARGS = ['--import', 'tsx', BRIDGE];

let t: TestApp;
let server: ServerType;
let baseUrl: string;
let agentKey: string;
let toolsOverHttp: string[];
const clients: Client[] = [];

function bridgeEnv(env: Record<string, string>) {
  return { PATH: process.env.PATH ?? '', ...env };
}

async function connect(env: Record<string, string>) {
  const client = new Client({ name: 'bridge-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: NODE_ARGS,
    cwd: SERVER_DIR,
    env: bridgeEnv(env),
    stderr: 'ignore',
  });
  clients.push(client);
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  t = startTestApp(db);
  const setup = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    { agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] } },
  );
  agentKey = setup.keys.agent;
  await new Promise<void>((resolve) => {
    server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const direct = await t.mcpClient(agentKey);
  toolsOverHttp = (await direct.listTools()).tools.map((tool) => tool.name).sort();
  await direct.close();
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('stdio bridge', () => {
  it('serves the same tools as the HTTP endpoint, acting as the key', async () => {
    const client = await connect({ RETAINER_URL: baseUrl, RETAINER_API_KEY: agentKey });
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual(toolsOverHttp);
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name).sort();
    expect(prompts).toEqual([...GUIDE_NAMES].sort());

    const written = await callTool(client, 'upsert_record', {
      object: 'person',
      match: { emails: 'tal@acme.test' },
      ifMissing: 'create',
      values: { name: 'Tal Cohen', emails: 'tal@acme.test' },
    });
    expect(written.isError).toBe(false);
    const found = await callTool(client, 'search', { query: 'Cohen' });
    expect(found.body.records).toEqual([expect.objectContaining({ id: written.body.id })]);

    const read = await t.request(`/v1/records/${written.body.id}`, { key: agentKey });
    expect(read.body.createdBy).toMatchObject({ type: 'agent', id: 'inbox' });
  });

  it('accepts a base URL with a trailing slash or the /mcp path', async () => {
    const results = await Promise.all(
      [`${baseUrl}/`, `${baseUrl}/mcp`].map(async (url) => {
        const client = await connect({ RETAINER_URL: url, RETAINER_API_KEY: agentKey });
        return callTool(client, 'describe_schema');
      }),
    );
    expect(results.map((result) => result.isError)).toEqual([false, false]);
  });

  it('reports a rejected key to the client', async () => {
    const attempt = connect({ RETAINER_URL: baseUrl, RETAINER_API_KEY: 'rtn_not_a_real_key' });
    await expect(attempt).rejects.toThrow(/rejected the API key \(401\)/);
  });

  it('reports an unreachable server', async () => {
    const closed = serve({ fetch: () => new Response(), port: 0, hostname: '127.0.0.1' });
    await new Promise((resolve) => closed.once('listening', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const attempt = connect({
      RETAINER_URL: `http://127.0.0.1:${port}`,
      RETAINER_API_KEY: agentKey,
    });
    await expect(attempt).rejects.toThrow(/cannot reach Retainer at http:\/\/127\.0\.0\.1/);
  });

  it('answers requests still in flight when stdin ends, then exits', async () => {
    const child: ChildProcess = spawn(process.execPath, NODE_ARGS, {
      cwd: SERVER_DIR,
      env: bridgeEnv({ RETAINER_URL: baseUrl, RETAINER_API_KEY: agentKey }),
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pipe', version: '0' },
      },
    };
    child.stdin?.end(`${JSON.stringify(initialize)}\n`);
    expect(await exited).toBe(0);
    const [line] = stdout.trim().split('\n');
    expect(JSON.parse(line as string)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: expect.objectContaining({
          name: 'retainer',
          title: 'Retainer',
          icons: [
            expect.objectContaining({
              src: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
              mimeType: 'image/svg+xml',
              sizes: ['any'],
            }),
          ],
        }),
      },
    });
  });

  it('exits with a usage message when it is not configured', () => {
    const run = spawnSync(process.execPath, NODE_ARGS, {
      cwd: SERVER_DIR,
      env: bridgeEnv({ RETAINER_API_KEY: agentKey }),
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('RETAINER_URL is not set');
    expect(run.stderr).toContain('RETAINER_API_KEY');
  });
});
