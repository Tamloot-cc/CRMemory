import { createApp } from '../../src/api/app.js';
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
 * way layer 3 (API) tests use it. No port is opened.
 */
export function startTestApp(db: TestDatabase) {
  const sql = db.connect();
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

  return { app, sql, request };
}

export type TestApp = ReturnType<typeof startTestApp>;
