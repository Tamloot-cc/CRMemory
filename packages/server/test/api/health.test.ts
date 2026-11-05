import { describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();

describe('GET /health', () => {
  it('reports the database as reachable', async () => {
    const { request } = startTestApp(backend);
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'ok' });
  });

  // `current_database()` is replaced by a namespace per test file (helpers/backend.ts).
  it('runs against a namespace of its own', async () => {
    const [info] = (await backend.adminNamespace().query('INFO FOR NS;')) as [
      { databases: Record<string, unknown> },
    ];
    expect(backend.config.namespace).toMatch(/^rt_test_[0-9a-f]{12}$/);
    expect(Object.keys(info.databases)).toContain('catalog');
  });
});
