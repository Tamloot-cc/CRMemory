import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { NOTE_CHANNEL } from '../memory/facts.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';

/**
 * Keyword search across records, facts and interactions (5.1). Postgres
 * parses the query (`websearch_to_tsquery`: quoted phrases, `OR`, `-word`)
 * with the `simple` configuration the stored vectors use. Each list is
 * ranked on its own; scores are not comparable across lists, so results
 * stay grouped by type.
 */

export const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

export type RecordHit = {
  id: string;
  object: string;
  label: string | null;
  /** `text`: a full-text match. `similar_label`: the fuzzy fallback on the label. */
  match: 'text' | 'similar_label';
};

export type FactHit = { id: string; record: string; content: string; validFrom: string };

export type InteractionHit = {
  id: string;
  kind: string;
  occurredAt: string;
  title: string | null;
  summary: string | null;
  /** Live records matched to its participants; possibly none or several. */
  records: string[];
};

export type SearchResult = {
  records: RecordHit[];
  facts: FactHit[];
  interactions: InteractionHit[];
};

/**
 * Length normalization for `ts_rank_cd`: divide by 1 + log(document
 * length), so a long text does not outrank a short, precise match.
 */
const RANK_NORMALIZATION = 1;

export async function search(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
): Promise<SearchResult> {
  const query = () => tsQuery(tx, input.query);
  const [records, facts, interactions] = await Promise.all([
    searchRecords(tx, workspaceId, schema, input, query),
    searchFacts(tx, workspaceId, input, query),
    searchInteractions(tx, workspaceId, input, query),
  ]);
  return { records, facts, interactions };
}

/** A fresh fragment per use: postgres.js fragments are not shared between queries. */
function tsQuery(tx: Tx, text: string) {
  return tx`websearch_to_tsquery('simple', ${text})`;
}
type Query = () => ReturnType<typeof tsQuery>;

type RecordRow = { id: string; object_type_id: string; label: string | null };

async function searchRecords(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
  query: Query,
): Promise<RecordHit[]> {
  const present = (rows: RecordRow[], match: RecordHit['match']) =>
    rows.map((row) => ({
      id: row.id,
      object: schema.objectsById.get(row.object_type_id)?.name ?? 'unknown',
      label: row.label,
      match,
    }));

  const text = await tx<RecordRow[]>`
    select id, object_type_id, label from records
    where workspace_id = ${workspaceId} and deleted_at is null and search @@ ${query()}
    order by ts_rank_cd(search, ${query()}, ${RANK_NORMALIZATION}) desc, updated_at desc, id
    limit ${input.limit}`;
  if (text.length > 0) return present(text, 'text');

  // Nothing matched word for word: a misspelled name ("Dana Levy") can
  // still find its record by trigram similarity of the label.
  const similar = await tx<RecordRow[]>`
    select id, object_type_id, label from records
    where workspace_id = ${workspaceId} and deleted_at is null and label % ${input.query}
    order by similarity(label, ${input.query}) desc, updated_at desc, id
    limit ${input.limit}`;
  return present(similar, 'similar_label');
}

/** Current facts only: not retracted or superseded, on a live record, with a live source (2.1). */
async function searchFacts(
  tx: Tx,
  workspaceId: string,
  input: SearchInput,
  query: Query,
): Promise<FactHit[]> {
  const rows = await tx<{ id: string; record_id: string; content: string; valid_from: Date }[]>`
    select f.id, f.record_id, f.content, f.valid_from from facts f
    join records r on r.id = f.record_id and r.deleted_at is null
    where f.workspace_id = ${workspaceId} and f.search @@ ${query()}
      and f.deleted_at is null and f.superseded_by is null and f.valid_to is null
      and exists (
        select 1 from fact_sources s
        join interactions i on i.id = s.interaction_id and i.deleted_at is null
        where s.fact_id = f.id)
    order by ts_rank_cd(f.search, ${query()}, ${RANK_NORMALIZATION}) desc, f.valid_from desc, f.id
    limit ${input.limit}`;
  return rows.map((row) => ({
    id: row.id,
    record: row.record_id,
    content: row.content,
    validFrom: row.valid_from.toISOString(),
  }));
}

/**
 * Live interactions. The notes `remember` creates for uncited facts are left
 * out: their text is the fact's, found (or hidden) with the fact itself.
 */
async function searchInteractions(
  tx: Tx,
  workspaceId: string,
  input: SearchInput,
  query: Query,
): Promise<InteractionHit[]> {
  const rows = await tx<
    {
      id: string;
      kind: string;
      occurred_at: Date;
      title: string | null;
      summary: string | null;
      records: string[];
    }[]
  >`
    select i.id, i.kind, i.occurred_at, i.title, i.summary,
      array(
        select p.record_id from interaction_participants p
        join records r on r.id = p.record_id and r.deleted_at is null
        where p.interaction_id = i.id
        order by p.position) as records
    from interactions i
    where i.workspace_id = ${workspaceId} and i.deleted_at is null and i.search @@ ${query()}
      and not (i.kind = 'note' and i.channel = ${NOTE_CHANNEL})
    order by ts_rank_cd(i.search, ${query()}, ${RANK_NORMALIZATION}) desc, i.occurred_at desc, i.id
    limit ${input.limit}`;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    title: row.title,
    summary: row.summary,
    records: [...new Set(row.records)],
  }));
}
