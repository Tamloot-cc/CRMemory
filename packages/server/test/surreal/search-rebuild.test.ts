import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { remember } from '../../src/memory/service.js';
import { rebuildSearchDocuments } from '../../src/records/rebuild-search.js';
import { type Caller, createRecord, deleteRecord } from '../../src/records/service.js';
import { searchFor } from '../../src/retrieval/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/** Rebuilding the search projection from records and facts (spec section 8). */

const app = useTestBackend();
let workspaceId: string;
const AGENT: Actor = { type: 'agent', id: 'inbox' };
const as = (actor: Actor): Caller => ({ workspaceId, actor, scopes: ['read', 'write'] });

beforeAll(async () => {
  workspaceId = (await createWorkspace(app, { name: 'Rebuild', template: 'sales' })).id;
});

describe('rebuildSearchDocuments', () => {
  it('restores lost documents and removes those of deleted records', async () => {
    const kept = await createRecord(app, as(AGENT), 'company', { name: 'Zephyrine Labs' });
    const gone = await createRecord(app, as(AGENT), 'company', { name: 'Zephyrine Gone' });
    await remember(app, as(AGENT), kept.id, { text: 'Prefers quarterly invoicing' });
    await deleteRecord(app, as(AGENT), gone.id);
    const admin = await app.workspaceAdmin(workspaceId);
    // Lose every document, and leave a stale one for the deleted record.
    await admin.query('DELETE search_documents;');
    await admin.query(
      "CREATE type::record('search_documents', $id) CONTENT { kind: 'record', owner: $id, object_type_id: 'x', label: 'Zephyrine Gone', label_text: 'Zephyrine Gone', all_text: 'Zephyrine Gone', folded: 'zephyrine gone', grams: 'Zephyrine Gone', updated_at: time::now() };",
      { id: gone.id },
    );
    expect((await searchFor(app, as(AGENT), { query: 'zephyrine', limit: 10 })).records).toEqual(
      [],
    );
    const written = await rebuildSearchDocuments(app, workspaceId, { batch: 2 });
    expect(written).toBeGreaterThanOrEqual(2);
    const found = await searchFor(app, as(AGENT), { query: 'zephyrine', limit: 10 });
    expect(found.records.map((r) => r.id)).toEqual([kept.id]);
    const facts = await searchFor(app, as(AGENT), { query: 'quarterly', limit: 10 });
    expect(facts.facts.map((f) => f.record)).toEqual([kept.id]);
    const stale = await admin.rows("SELECT id FROM type::record('search_documents', $id);", {
      id: gone.id,
    });
    expect(stale).toEqual([]);
  });
});
