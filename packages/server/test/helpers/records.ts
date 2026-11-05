import { expect } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { readWorkspace } from '../../src/db/protocol.js';
import { rowsByIds } from '../../src/records/store.js';
import { computeDataFromAssertions } from '../../src/records/write.js';

/**
 * A record's stored values must always equal what its assertions say
 * (rule 2.4): the typed columns, read back as `data`, against a fresh
 * computation from `field_assertions`.
 */
export async function expectDataMatchesAssertions(
  backend: Backend,
  workspaceId: string,
  id: string,
): Promise<void> {
  await readWorkspace(backend, workspaceId, async ({ db, schema }) => {
    const compiled = await schema();
    const row = (await rowsByIds(db, workspaceId, compiled, [id])).get(id);
    const object = compiled.objectsById.get(row?.object_type_id as string);
    if (!row || !object) throw new Error('record not found');
    expect(await computeDataFromAssertions(db, object, id)).toEqual(row.data);
  });
}
