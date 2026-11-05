import { describe, expect, it } from 'vitest';
import { mutate } from '../../src/db/protocol.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();

describe('foundation', () => {
  it('provisions a workspace with its base objects', async () => {
    const workspace = await createWorkspace(backend, { name: 'Acme' });
    expect(workspace.schemaVersion).toBe(1);
    const db = await backend.workspace(workspace.id);
    const [info] = (await backend.adminDb((await backend.route(workspace.id)).database).query(
      'INFO FOR DB;',
    )) as [{ tables: Record<string, string> }];
    expect(Object.keys(info.tables).filter((t) => t.startsWith('o_')).length).toBeGreaterThan(3);
    const objects = await db.rows<{ name_singular: string }>('SELECT name_singular FROM object_types;');
    expect(objects.map((o) => o.name_singular)).toContain('person');
  });

  it('serializes and retries writes on the revision', async () => {
    const workspace = await createWorkspace(backend, { name: 'Writes' });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mutate(backend, workspace.id, {
          kind: 'test',
          plan: async (op) => {
            op.batch.create('jobs', op.newId(), {
              kind: 'noop',
              payload: { i },
              status: 'done',
              attempts: 0,
              run_after: op.now,
              created_at: op.now,
              updated_at: op.now,
            });
            return i;
          },
        }),
      ),
    );
    expect(results.map((r) => r.result).sort()).toEqual([0, 1, 2, 3, 4]);
    const other = backend.another();
    // A second process's sessions conflict on the revision and replan.
    const [a, b] = await Promise.all([
      mutate(backend, workspace.id, { kind: 'test', plan: async () => 'a' }),
      mutate(other, workspace.id, { kind: 'test', plan: async () => 'b' }),
    ]);
    expect([a.result, b.result].sort()).toEqual(['a', 'b']);
  });
});
