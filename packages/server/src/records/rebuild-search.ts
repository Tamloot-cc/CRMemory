import type { Backend } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { publicId } from '../db/names.js';
import { mutate } from '../db/protocol.js';
import { ident } from '../db/surreal.js';
import { liveFactSources } from '../memory/events.js';
import type { CompiledObject } from '../schema-engine/compiled.js';
import { factDocument, recordDocument } from './search-docs.js';
import { directoryEntries, rowFromNative } from './store.js';

/**
 * Rebuilds a workspace's `search_documents` (spec section 8) from what they
 * project: every live record of every active object, and every current fact
 * with a live source on a live record. Documents whose owner is gone are
 * removed. Each batch is its own write, keyed by record ID, so a rebuild
 * can stop and run again; writers keep documents current meanwhile, and
 * every search read still checks liveness. Returns how many documents it
 * wrote.
 */
export async function rebuildSearchDocuments(
  backend: Backend,
  workspaceId: string,
  { batch = 500 } = {},
): Promise<number> {
  let written = 0;
  const step = (plan: Parameters<typeof mutate<number>>[2]['plan']) =>
    mutate(backend, workspaceId, { kind: 'rebuild_search', noReceipt: true, plan }).then(
      (o) => o.result,
    );

  // Records, object by object, in ID order.
  let objects: CompiledObject[] = [];
  await step(async (op) => {
    objects = [...(await op.schema()).objectsById.values()].filter(
      (o) => o.state.status === 'active',
    );
    return 0;
  });
  for (const object of objects) {
    let after: RecordId | undefined;
    for (;;) {
      let last: RecordId | undefined;
      const count = await step(async (op) => {
        const rows = await op.rows<Parameters<typeof rowFromNative>[2]>(
          `SELECT * FROM ${ident(object.table)} WHERE deleted_at = NONE AND merged_into = NONE${
            after ? ' AND id > $after' : ''
          } ORDER BY id LIMIT ${batch};`,
          after ? { after } : {},
        );
        for (const native of rows) {
          const row = rowFromNative(workspaceId, object, native);
          const doc = recordDocument(object, row.id, row.data, op.now);
          op.batch.upsert('search_documents', row.id, doc);
        }
        last = rows.at(-1)?.id;
        return rows.length;
      });
      written += count;
      if (count < batch || !last) break;
      after = last;
    }
  }

  // Facts, in ID order: current ones get a document, the rest lose theirs.
  let afterFact: RecordId | undefined;
  for (;;) {
    let last: RecordId | undefined;
    const count = await step(async (op) => {
      const facts = await op.rows<{
        id: RecordId;
        record: string;
        content: string;
        valid_to?: Date | null;
        superseded_by?: string | null;
        deleted_at?: Date | null;
      }>(
        `SELECT id, record, content, valid_to, superseded_by, deleted_at FROM facts${
          afterFact ? ' WHERE id > $after' : ''
        } ORDER BY id LIMIT ${batch};`,
        afterFact ? { after: afterFact } : {},
      );
      const ids = facts.map((f) => publicId(f.id));
      const [owners, sources, docs] = await Promise.all([
        directoryEntries(
          op.db,
          facts.map((f) => f.record),
        ),
        liveFactSources(op, ids),
        op.rows<RecordId>('SELECT VALUE id FROM $ids;', {
          ids: ids.map((id) => new RecordId('search_documents', id)),
        }),
      ]);
      const existing = new Set(docs.map(publicId));
      for (const fact of facts) {
        const id = publicId(fact.id);
        const owner = owners.get(fact.record);
        const current =
          !fact.deleted_at &&
          !fact.superseded_by &&
          !fact.valid_to &&
          !!owner &&
          !owner.deleted_at &&
          (sources.get(id)?.length ?? 0) > 0;
        if (current && owner) {
          op.batch.upsert(
            'search_documents',
            id,
            factDocument(
              { id, record: fact.record, content: fact.content },
              owner.object_type_id,
              op.now,
            ),
          );
          written++;
        } else if (existing.has(id)) {
          op.batch.delete('search_documents', id);
        }
      }
      last = facts.at(-1)?.id;
      return facts.length;
    });
    if (count < batch || !last) break;
    afterFact = last;
  }

  // Documents whose record is gone (deleted or merged).
  let afterDoc: RecordId | undefined;
  for (;;) {
    let last: RecordId | undefined;
    const count = await step(async (op) => {
      const docs = await op.rows<{ id: RecordId; kind: string; owner: string }>(
        `SELECT id, kind, owner FROM search_documents WHERE kind = 'record'${
          afterDoc ? ' AND id > $after' : ''
        } ORDER BY id LIMIT ${batch};`,
        afterDoc ? { after: afterDoc } : {},
      );
      const entries = await directoryEntries(
        op.db,
        docs.map((d) => d.owner),
      );
      const gone = docs
        .filter((d) => {
          const entry = entries.get(d.owner);
          return !entry || entry.deleted_at || entry.merged_into;
        })
        .map((d) => publicId(d.id));
      op.batch.deleteIds('search_documents', gone);
      last = docs.at(-1)?.id;
      return docs.length;
    });
    if (count < batch || !last) break;
    afterDoc = last;
  }
  return written;
}
