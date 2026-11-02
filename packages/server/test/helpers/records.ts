import { expect } from 'vitest';
import type { Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { computeDataFromAssertions } from '../../src/records/write.js';
import { getSchema } from '../../src/schema-engine/compiled.js';

/** records.data must always equal what the assertions say (rule 2.4). */
export async function expectDataMatchesAssertions(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<void> {
  await inWorkspace(sql, workspaceId, async (tx) => {
    const schema = await getSchema(tx, workspaceId);
    const [row] = await tx<{ object_type_id: string; data: Record<string, unknown> }[]>`
      select object_type_id, data from records where id = ${id}`;
    const object = schema.objectsById.get(row?.object_type_id as string);
    if (!object) throw new Error('object not found');
    expect(await computeDataFromAssertions(tx, object, id)).toEqual(row?.data);
  });
}
