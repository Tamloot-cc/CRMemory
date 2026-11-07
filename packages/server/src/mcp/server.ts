import { McpServer } from '@modelcontextprotocol/server';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { VERSION } from '../version.js';
import { INSTRUCTIONS } from './instructions.js';
import { registerReadTools } from './tools/read.js';
import { registerSetupTools } from './tools/setup.js';
import { registerWriteTools } from './tools/write.js';

/**
 * The MCP tools (6.2). They are generic, not one per object, and each calls
 * the same service as its REST route, so both interfaces share validation,
 * write rules and error messages; get_guide is the exception, serving static
 * text that only agents need. The workspace and actor come from the API
 * key, so no tool takes either.
 */

/** Builds the MCP server for one authenticated caller. */
export function createMcpServer(sql: Sql, caller: Caller): McpServer {
  const server = new McpServer(
    { name: 'retainer', title: 'Retainer', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerSetupTools(server, sql, caller);
  registerReadTools(server, sql, caller);
  registerWriteTools(server, sql, caller);

  return server;
}
