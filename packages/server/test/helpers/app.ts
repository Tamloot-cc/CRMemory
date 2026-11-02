import type { Actor } from '@retainer/shared';
import { createApp } from '../../src/api/app.js';
import { createApiKey } from '../../src/auth/keys.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import type { ApiKeyScope } from '../../src/db/schema.js';
import { createWorkspace, type Workspace } from '../../src/workspaces/workspaces.js';
import type { TestDatabase } from './db.js';

export type TestResponse<T = any> = {
  status: number;
  body: T;
  headers: Headers;
};

export type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Sent as `Authorization: Bearer <key>`. */
  key?: string;
  headers?: Record<string, string>;
};

/**
 * Builds the Hono app against a test database and calls it in-process, the
 * way layer 3 (API) tests use it. No port is opened. The app runs as the
 * runtime role, as in production, so RLS applies.
 */
export function startTestApp(db: TestDatabase) {
  const sql = db.connect({ role: RUNTIME_ROLE, max: 20 });
  const app = createApp({ sql });

  async function request<T = any>(
    path: string,
    options: RequestOptions = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await app.request(path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      headers: response.headers,
    } as TestResponse<T>;
  }

  /**
   * Creates a workspace (operator path) and one key per entry, e.g.
   * `{ agent: { actor: 'agent:bot', scopes: ['read', 'write'] } }`.
   */
  async function setupWorkspace<K extends string>(
    options: { name: string; template?: string },
    keys: Record<K, { actor: Actor; scopes: ApiKeyScope[] }>,
  ): Promise<{ workspace: Workspace; keys: Record<K, string> }> {
    const workspace = await createWorkspace(db.owner, options);
    const issued = {} as Record<K, string>;
    for (const [name, spec] of Object.entries(keys) as [
      K,
      { actor: Actor; scopes: ApiKeyScope[] },
    ][]) {
      issued[name] = (await createApiKey(db.owner, { workspace: workspace.id, name, ...spec })).key;
    }
    return { workspace, keys: issued };
  }

  return { app, sql, request, setupWorkspace };
}

export type TestApp = ReturnType<typeof startTestApp>;
