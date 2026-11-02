import { describe, expect, it } from 'vitest';
import { RetainerClient } from './index.js';

describe('REST transport', () => {
  it('supports cookie credentials, the CSRF header, and abort propagation', async () => {
    let init: RequestInit | undefined;
    const controller = new AbortController();
    const client = new RetainerClient({
      baseUrl: 'http://localhost',
      credentials: 'include',
      fetch: async (_url, options) => {
        init = options;
        return Response.json({ records: [], nextCursor: null });
      },
    });
    await client.queryRecords('person', {}, controller.signal);
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBe(controller.signal);
    expect(init?.headers).toMatchObject({ 'X-Retainer-Client': 'web' });
    expect(init?.headers).not.toHaveProperty('authorization');
  });
  it('preserves typed API errors and bearer clients', async () => {
    let headers: RequestInit['headers'] | undefined;
    const client = new RetainerClient({
      baseUrl: 'http://localhost',
      apiKey: 'rtn_test',
      fetch: async (_url, init) => {
        headers = init?.headers;
        return Response.json(
          { error: { code: 'stale_write', message: 'Changed', details: { updatedAt: 'new' } } },
          { status: 412 },
        );
      },
    });
    await expect(client.patchRecord('id', { values: { name: 'Dana' } })).rejects.toMatchObject({
      status: 412,
      code: 'stale_write',
      details: { updatedAt: 'new' },
    });
    expect(headers).toMatchObject({ authorization: 'Bearer rtn_test' });
  });
});

it('keeps the existing health response contract for database outages', async () => {
  const expected = { status: 'error', version: '0.0.0', database: 'unreachable' };
  const client = new RetainerClient({
    baseUrl: 'http://localhost',
    fetch: async () => Response.json(expected, { status: 503 }),
  });
  expect(await client.health()).toEqual(expected);
});
