import type { EventHit, FactHit, RecordHit, SearchResult } from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { publicId } from '../db/names.js';
import { loadLinksOf } from '../memory/event-links.js';
import { liveFactSources } from '../memory/events.js';
import { fold } from '../records/search-docs.js';
import { parseSearch, type SearchCondition, searchCondition } from '../records/search-sql.js';
import { directoryEntries, fetchRows } from '../records/store.js';
import { type CompiledSchema, eventText } from '../schema-engine/compiled.js';

/**
 * Keyword search across records, events and facts (5.1; spec section 8),
 * over `search_documents`. The query takes websearch syntax (quoted
 * phrases, `OR`, `-word`); every word also matches as a prefix ("Dan" finds
 * "Dana") and accents are ignored. Hits that match the words as typed rank
 * first, then by BM25. Each list is ranked on its own; scores are not
 * comparable across lists, so results stay grouped by type. Every hit is
 * checked for liveness and visibility when read, so a stale document never
 * surfaces a hidden record.
 */

export const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

/** Labels at least this close (Jaro-Winkler) are similar enough to suggest. */
export const SIMILAR_LABEL_THRESHOLD = 0.8;

type Hit = {
  id: RecordId;
  owner: string;
  object_type_id: string;
  label?: string | null;
  updated_at: Date;
  exact: number;
  score: number;
};

/**
 * Ranked hits of one kind, read in growing windows until `want` of them
 * survive `keep` (liveness, visibility) or the matches run out.
 */
async function rankedHits(
  db: Db,
  condition: SearchCondition,
  scope: string,
  vars: Record<string, unknown>,
  want: number,
  keep: (hits: Hit[]) => Promise<Hit[]>,
): Promise<Hit[]> {
  if (!condition.where) return [];
  const kept: Hit[] = [];
  for (let start = 0, size = Math.max(want * 2, 20); ; start += size, size *= 2) {
    const hits = await db.rows<Hit>(
      `SELECT id, owner, object_type_id, label, updated_at, ${condition.exact} AS exact,
         ${condition.score} AS score
       FROM search_documents WHERE ${condition.where} AND ${scope}
       ORDER BY exact DESC, score DESC, updated_at DESC, id ASC LIMIT ${size} START ${start};`,
      { ...condition.vars, ...vars },
    );
    kept.push(...(await keep(hits)));
    if (kept.length >= want || hits.length < size) return kept.slice(0, want);
  }
}

export async function search(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
): Promise<SearchResult> {
  const condition = searchCondition(parseSearch(input.query), 'all_text');
  const [records, facts, events] = await Promise.all([
    searchRecords(db, schema, input, condition),
    searchFacts(db, input, condition),
    searchEvents(db, workspaceId, schema, input, condition),
  ]);
  return { records, facts, events };
}

/** Hits on live records of some object types. */
async function liveRecordHits(db: Db, hits: Hit[], types: ReadonlySet<string>) {
  const entries = await directoryEntries(
    db,
    hits.map((h) => h.owner),
  );
  return hits.filter((h) => {
    const entry = entries.get(h.owner);
    return !!entry && !entry.deleted_at && types.has(entry.object_type_id);
  });
}

async function searchRecords(
  db: Db,
  schema: CompiledSchema,
  input: SearchInput,
  condition: SearchCondition,
): Promise<RecordHit[]> {
  const types = new Set(schema.entityTypeIds);
  const present = (rows: Hit[], match: RecordHit['match']) =>
    rows.map((row) => ({
      id: row.owner,
      object: schema.objectsById.get(row.object_type_id)?.name ?? 'unknown',
      label: row.label ?? null,
      match,
    }));
  const text = await rankedHits(
    db,
    condition,
    "kind = 'record' AND object_type_id IN $types",
    { types: [...types] },
    input.limit,
    (hits) => liveRecordHits(db, hits, types),
  );
  if (text.length > 0) return present(text, 'text');

  // Nothing matched, even as a prefix: a misspelled name ("Dana Levy") can
  // still find its record by trigram candidates of the label, reranked by
  // Jaro-Winkler similarity.
  const q = fold(input.query);
  if (q.replace(/\s/g, '').length < 3) return [];
  const candidates = await db.rows<Hit & { similarity: number }>(
    `SELECT id, owner, object_type_id, label, updated_at,
       string::similarity::jaro_winkler(string::lowercase(grams), $q) AS similarity
     FROM search_documents
     WHERE grams @OR@ $q AND kind = 'record' AND object_type_id IN $types
     ORDER BY similarity DESC, updated_at DESC, id ASC LIMIT ${Math.max(input.limit * 5, 50)};`,
    { q, types: [...types] },
  );
  const similar = await liveRecordHits(
    db,
    candidates.filter((c) => c.similarity >= SIMILAR_LABEL_THRESHOLD),
    types,
  );
  return present(similar.slice(0, input.limit), 'similar_label');
}

/** Current facts only: not retracted or superseded, on a live record, with a live source (2.1). */
async function searchFacts(
  db: Db,
  input: SearchInput,
  condition: SearchCondition,
): Promise<FactHit[]> {
  const facts = new Map<string, { record: string; content: string; valid_from: Date }>();
  const hits = await rankedHits(db, condition, "kind = 'fact'", {}, input.limit, async (rows) => {
    const ids = rows.map((r) => publicId(r.id));
    if (ids.length === 0) return [];
    const [stored, live, owners] = await Promise.all([
      db.rows<{
        id: RecordId;
        record: string;
        content: string;
        valid_from: Date;
        valid_to?: Date | null;
        superseded_by?: string | null;
        deleted_at?: Date | null;
      }>('SELECT id, record, content, valid_from, valid_to, superseded_by, deleted_at FROM $ids;', {
        ids: ids.map((id) => new RecordId('facts', id)),
      }),
      liveFactSources(db, ids),
      directoryEntries(
        db,
        rows.map((r) => r.owner),
      ),
    ]);
    for (const f of stored) {
      const owner = owners.get(f.record);
      if (
        !f.deleted_at &&
        !f.superseded_by &&
        !f.valid_to &&
        owner &&
        !owner.deleted_at &&
        (live.get(publicId(f.id))?.length ?? 0) > 0
      ) {
        facts.set(publicId(f.id), f);
      }
    }
    return rows.filter((r) => facts.has(publicId(r.id)));
  });
  return hits.map((hit) => {
    const fact = facts.get(publicId(hit.id)) as {
      record: string;
      content: string;
      valid_from: Date;
    };
    return {
      id: publicId(hit.id),
      record: fact.record,
      content: fact.content,
      validFrom: fact.valid_from.toISOString(),
    };
  });
}

/**
 * Live events of visible types, by their searchable fields (title and
 * summary at least). Internal notes are left out: their text is the fact's,
 * found (or hidden) with the fact itself.
 */
async function searchEvents(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
  condition: SearchCondition,
): Promise<EventHit[]> {
  const types = new Set(schema.eventTypeIds);
  const hits = await rankedHits(
    db,
    condition,
    "kind = 'record' AND object_type_id IN $types",
    { types: [...types] },
    input.limit,
    (rows) => liveRecordHits(db, rows, types),
  );
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.owner);
  const entries = await directoryEntries(db, ids);
  const [rows, links] = await Promise.all([
    fetchRows(db, workspaceId, schema, entries.values()),
    loadLinksOf(db, ids),
  ]);
  const visible = new Set(schema.visibleObjectIds);
  const linked = await directoryEntries(
    db,
    [...links.values()].flat().flatMap((l) => (l.record_id ? [l.record_id] : [])),
  );
  return hits.flatMap((hit): EventHit[] => {
    const row = rows.get(hit.owner);
    if (!row?.occurred_at) return [];
    const object = schema.objectsById.get(row.object_type_id);
    const records = (links.get(hit.owner) ?? []).flatMap((l) => {
      const entry = l.record_id ? linked.get(l.record_id) : undefined;
      return entry && !entry.deleted_at && visible.has(entry.object_type_id) ? [entry.id] : [];
    });
    return [
      {
        id: row.id,
        type: object?.name ?? 'unknown',
        occurredAt: row.occurred_at.toISOString(),
        ...eventText(object, row.data),
        records: [...new Set(records)],
      },
    ];
  });
}
