import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { authenticate } from '../auth/middleware.js';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { AppEnv } from '../http/response.js';
import { log } from '../log.js';
import { createMcpServer } from './server.js';

/**
 * Serves MCP over Streamable HTTP at `/mcp` (6.2). The API key is checked by
 * the same middleware as REST; the caller it yields reaches the tools through
 * the handler's auth info, never through the request body. Serving is
 * stateless: each request gets a server built for its caller.
 */
export function mcpRoute(app: Hono<AppEnv>, sql: Sql, publicOrigin?: string) {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.caller as Caller | undefined;
      // Unreachable behind authenticate(); fail closed if that ever changes.
      if (!caller) throw new Error('MCP request reached the server without a caller');
      return createMcpServer(sql, caller);
    },
    { onerror: (error) => log.error(error) },
  );

  app.use('/mcp', authenticate(sql, { publicOrigin }));
  app.all('/mcp', (c) => {
    const caller = c.get('caller');
    const authInfo: AuthInfo = {
      // The key itself never travels past the middleware.
      token: '',
      clientId: caller.actor.id,
      scopes: [...caller.scopes],
      extra: { caller },
    };
    return handler.fetch(c.req.raw, { authInfo });
  });
}
