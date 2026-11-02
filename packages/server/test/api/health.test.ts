import { describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

describe('GET /health', () => {
  it('reports the database as reachable', async () => {
    const { request } = startTestApp(db);
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('runs against a database of its own', async () => {
    const [row] = await db.owner<{ name: string }[]>`select current_database() as name`;
    expect(row?.name).toBe(db.name);
  });
});
