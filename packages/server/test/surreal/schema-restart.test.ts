import type { Actor } from '@retainer/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readState } from '../../src/db/protocol.js';
import { type Caller, createRecord, readRecord } from '../../src/records/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * A process that stops in the middle of a schema change (spec sections 7
 * and 11). New tables and indexes are defined before the transaction that
 * publishes the metadata; if the process dies between the two, the
 * published schema is unchanged, the new tables are empty and unused, and
 * running the change again applies it once.
 */
const backend = useTestBackend();
const USER: Actor = { type: 'user', id: 'maya' };
let workspaceId: string;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeAll(async () => {
  workspaceId = (await createWorkspace(backend, { name: 'Restart', template: 'sales' })).id;
});

const createProject: SchemaOperation[] = [
  {
    op: 'create_object',
    object: {
      nameSingular: 'project',
      namePlural: 'projects',
      labelSingular: 'Project',
      labelPlural: 'Projects',
      labelField: 'name',
      fields: [{ name: 'name', label: 'Name', type: 'text', isUnique: true }],
    },
  } as SchemaOperation,
];

describe('schema change interrupted before its commit', () => {
  it('publishes nothing, then applies once when run again', async () => {
    const before = await readState(await backend.workspace(workspaceId));
    // The process "dies" when it sends the publishing transaction.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      if (body instanceof Uint8Array && Buffer.from(body).includes(Buffer.from('COMMIT;'))) {
        throw new Error('connection reset');
      }
      return realFetch(input, init);
    }) as typeof fetch;
    await expect(
      runSchemaChange(backend, {
        workspaceId,
        actor: USER,
        scopes: ['schema:write', 'admin'],
        operations: createProject,
      }),
    ).rejects.toThrow(/unreachable|connection reset/);
    globalThis.fetch = realFetch;

    const db = await backend.workspace(workspaceId);
    const after = await readState(db);
    expect(after.schema_version).toBe(before.schema_version);
    expect(after.mode).toBe('active');
    const objects = await db.rows<{ name_singular: string }>(
      "SELECT name_singular FROM object_types WHERE name_singular = 'project';",
    );
    expect(objects).toEqual([]);

    // A new process runs it again.
    const other = backend.another();
    const result = await runSchemaChange(other, {
      workspaceId,
      actor: USER,
      scopes: ['schema:write', 'admin'],
      operations: createProject,
    });
    expect(result.status).toBe('applied');
    expect(result.schemaVersion).toBe(before.schema_version + 1);
    const caller: Caller = { workspaceId, actor: USER, scopes: ['read', 'write'] };
    const project = await createRecord(other, caller, 'project', { name: 'Apollo' });
    expect((await readRecord(other, caller, project.id)).fields.name).toBe('Apollo');
    await expect(createRecord(other, caller, 'project', { name: 'Apollo' })).rejects.toMatchObject({
      code: 'unique_conflict',
    });
    const published = await db.rows<{ name_singular: string }>(
      "SELECT name_singular FROM object_types WHERE name_singular = 'project';",
    );
    expect(published).toHaveLength(1);
  });
});
