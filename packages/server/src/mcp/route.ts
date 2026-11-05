import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import type { AppEnv } from '../api/http.js';
import { authenticate } from '../auth/middleware.js';
import type { Backend } from '../db/backend.js';
import { log } from '../log.js';
import type { Caller } from '../records/service.js';
import { createMcpServer } from './server.js';

/**
 * Serves MCP over Streamable HTTP at `/mcp` (6.2). The API key is checked by
 * the same middleware as REST; the caller it yields reaches the tools through
 * the handler's auth info, never through the request body. Serving is
 * stateless: each request gets a server built for its caller.
 */
export function mcpRoute(app: Hono<AppEnv>, backend: Backend, publicOrigin?: string) {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.caller as Caller | undefined;
      // Unreachable behind authenticate(); fail closed if that ever changes.
      if (!caller) throw new Error('MCP request reached the server without a caller');
      return createMcpServer(backend, caller);
    },
    { onerror: (error) => log.error(error) },
  );

  app.use('/mcp', authenticate(backend, publicOrigin));
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
