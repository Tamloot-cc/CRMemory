import type { Backend } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { publicId } from '../db/names.js';
import { mutate, NoChange, type Operation } from '../db/protocol.js';
import { liveFactSources } from '../memory/events.js';
import { fold } from '../records/search-docs.js';
import { directoryEntries } from '../records/store.js';

/**
 * The consolidator (4.2), run per workspace on a schedule. It never calls a
 * model and never changes what a claim says:
 *
 * - Exact duplicate facts (same record, same normalized text, same validity
 *   interval) are superseded by the oldest of them, which gains every
 *   duplicate's source links. The duplicates are kept. Near-duplicates and
 *   contradictions are left alone.
 * - Duplicate records are suggested, never merged: two live records of one
 *   object that share an email, phone or website domain, or whose labels
 *   are similar. A person decides (`POST /v1/records/:id/merge` or dismiss).
 *   A decided pair is never suggested again. Events are never suggested:
 *   each is something that happened, logged from its own source.
 *
 * One run is one operation under the write protocol (section 6): it reads
 * what changed, plans, and commits against the revision it read, so no
 * write (and no `forget`) interleaves with it.
 */

/**
 * Labels at least this similar suggest a duplicate. Candidates come from
 * the trigram label index and are reranked by Jaro-Winkler similarity of
 * the folded labels (spec section 8); the scale differs from pg_trgm's.
 */
export const NAME_SIMILARITY = 0.9;
/** Shorter labels are too generic to compare. */
const MIN_LABEL_LENGTH = 3;
/** Trigram candidates read per changed record. */
const NAME_CANDIDATES = 20;
/** At most this many new suggestions per kind and run, so one run cannot flood review. */
export const MAX_NEW_SUGGESTIONS = 500;
/**
 * The next run compares records changed since this long before this run
 * started. Comparing a pair twice is harmless.
 */
const COMPARE_OVERLAP_MS = 5 * 60 * 1000;

export type ConsolidationStats = { supersededFacts: number; mergeSuggestions: number };

export type ConsolidateOptions = {
  /** Skip the workspace when its last run started less than this long ago. */
  minIntervalMs?: number;
  /** Overrides MAX_NEW_SUGGESTIONS (tests). */
  maxNewSuggestions?: number;
};

type RunRow = { started_at: Date; compared_until: Date };

/** Runs one statement per value in one request; results in order. */
async function perValue<T>(
  op: Operation,
  values: readonly unknown[],
  statement: (v: string) => string,
): Promise<T[][]> {
  if (values.length === 0) return [];
  const vars: Record<string, unknown> = {};
  const statements = values.map((value, i) => {
    vars[`v${i}`] = value;
    return statement(`$v${i}`);
  });
  return (await op.db.query(statements.join('\n'), vars)) as T[][];
}

/**
 * Runs the consolidator for one workspace. Returns null when it ran within
 * `minIntervalMs`.
 */
export async function consolidateWorkspace(
  backend: Backend,
  workspaceId: string,
  options: ConsolidateOptions = {},
): Promise<ConsolidationStats | null> {
  const { result } = await mutate<ConsolidationStats | null>(backend, workspaceId, {
    kind: 'consolidate',
    noReceipt: true,
    plan: async (op) => {
      const [last] = await op.rows<RunRow>('SELECT * FROM consolidator_runs:current;');
      if (
        last &&
        options.minIntervalMs !== undefined &&
        op.now.getTime() - last.started_at.getTime() < options.minIntervalMs
      ) {
        throw new NoChange(null);
      }
      const since = last?.compared_until ?? null;
      const changed = await changedRecords(op, since);
      const supersededFacts = await supersedeDuplicateFacts(op, changed.withFacts);
      const merges = await suggestMerges(
        op,
        changed.records,
        options.maxNewSuggestions ?? MAX_NEW_SUGGESTIONS,
      );
      const stats: ConsolidationStats = { supersededFacts, mergeSuggestions: merges.added };
      // A capped run leaves pairs unsuggested, so the next run compares the
      // same records again instead of moving on.
      const comparedUntil = merges.capped
        ? (since ?? new Date(0))
        : new Date(op.now.getTime() - COMPARE_OVERLAP_MS);
      op.batch.upsert('consolidator_runs', 'current', {
        started_at: op.now,
        compared_until: comparedUntil,
        stats,
      });
      return stats;
    },
  });
  return result;
}

type Changed = {
  /** Live records changed since the last run (all on a first run). */
  records: { id: string; object_type_id: string }[];
  /** Records that changed or gained a fact: where new duplicates can be. */
  withFacts: string[];
};

async function changedRecords(op: Operation, since: Date | null): Promise<Changed> {
  type Row = { id: RecordId; object_type_id: string; deleted_at?: Date | null };
  const rows =
    since === null
      ? await op.rows<Row>('SELECT id, object_type_id, deleted_at FROM record_directory;')
      : await op.rows<Row>(
          'SELECT id, object_type_id, deleted_at FROM record_directory WHERE updated_at > $since;',
          { since },
        );
  const records = rows
    .filter((r) => !r.deleted_at)
    .map((r) => ({ id: publicId(r.id), object_type_id: r.object_type_id }));
  const factRecords =
    since === null
      ? []
      : (
          await op.rows<string>('SELECT VALUE record FROM facts WHERE created_at > $since;', {
            since,
          })
        ).filter((r) => typeof r === 'string');
  return { records, withFacts: [...new Set([...records.map((r) => r.id), ...factRecords])] };
}

type FactRow = {
  id: RecordId;
  record: string;
  content: string;
  valid_from: Date;
  valid_to?: Date | null;
  superseded_by?: string | null;
  deleted_at?: Date | null;
  created_at: Date;
};

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Supersedes exact duplicate facts with their canonical (oldest) fact,
 * among current facts of live records resting on a live source. Returns
 * how many.
 */
async function supersedeDuplicateFacts(op: Operation, recordIds: string[]): Promise<number> {
  const live = await directoryEntries(op.db, recordIds);
  const records = recordIds.filter((id) => {
    const entry = live.get(id);
    return entry && !entry.deleted_at;
  });
  const facts = (
    await perValue<FactRow>(op, records, (v) => `SELECT * FROM facts WHERE record = ${v};`)
  )
    .flat()
    .filter((f) => !f.deleted_at && !f.superseded_by);
  if (facts.length === 0) return 0;
  const sources = await liveFactSources(
    op.db,
    facts.map((f) => publicId(f.id)),
  );
  const groups = new Map<string, FactRow[]>();
  for (const fact of facts) {
    if ((sources.get(publicId(fact.id))?.length ?? 0) === 0) continue;
    const key = JSON.stringify([
      fact.record,
      normalize(fact.content),
      fact.valid_from.getTime(),
      fact.valid_to?.getTime() ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  let superseded = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) =>
        a.created_at.getTime() - b.created_at.getTime() ||
        publicId(a.id).localeCompare(publicId(b.id)),
    );
    const canonical = publicId((group[0] as FactRow).id);
    const stored = await op.rows<{ source?: string | null; quote?: string | null }>(
      'SELECT source, quote FROM fact_sources WHERE fact = $fact;',
      { fact: canonical },
    );
    const have = new Set(stored.map((s) => JSON.stringify([s.source ?? null, s.quote ?? null])));
    for (const duplicate of group.slice(1)) {
      const id = publicId(duplicate.id);
      const links = await op.rows<{ source?: string | null; quote?: string | null }>(
        'SELECT source, quote FROM fact_sources WHERE fact = $fact;',
        { fact: id },
      );
      for (const link of links) {
        if (!link.source) continue;
        const key = JSON.stringify([link.source, link.quote ?? null]);
        if (have.has(key)) continue;
        have.add(key);
        op.batch.create('fact_sources', op.newId(), {
          fact: canonical,
          source: link.source,
          quote: link.quote ?? null,
        });
      }
      op.batch.update('facts', id, { superseded_by: canonical });
      // A superseded fact is not current: it leaves search.
      op.batch.write(
        `DELETE ${op.batch.v(new RecordId('search_documents', id))} RETURN BEFORE`,
        { min: 0, max: 1 },
        'search_documents',
      );
      superseded++;
    }
  }
  return superseded;
}

const pairKey = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];

/**
 * Suggests merges for live entity records changed since the last run:
 * shared identifiers first, then similar labels, at most `cap` new pairs
 * of each kind. The pair is stored in sorted order. A pair that already has
 * a row (pending or decided) is skipped before the cap, so it neither uses
 * the budget nor is suggested again.
 */
async function suggestMerges(
  op: Operation,
  changed: { id: string; object_type_id: string }[],
  cap: number,
): Promise<{ added: number; capped: boolean }> {
  const schema = await op.schema();
  const entityTypes = new Set(schema.entityTypeIds);
  const records = changed.filter((r) => entityTypes.has(r.object_type_id));
  if (records.length === 0) return { added: 0, capped: false };
  const typeOf = new Map(records.map((r) => [r.id, r.object_type_id]));

  const known = new Set<string>();
  const isKnown = async (a: string, b: string) => {
    const key = `${a}\n${b}`;
    if (known.has(key)) return true;
    const [row] = await op.rows<{ id: RecordId }>(
      'SELECT id FROM merge_suggestions WHERE record_a = $a AND record_b = $b LIMIT 1;',
      { a, b },
    );
    if (row) known.add(key);
    return Boolean(row);
  };
  const propose = (a: string, b: string, reason: string) => {
    known.add(`${a}\n${b}`);
    op.batch.create('merge_suggestions', op.newId(), {
      record_a: a,
      record_b: b,
      reason,
      status: 'pending',
      created_at: op.now,
    });
  };

  // Shared identifiers: a changed record's emails, phones and domains,
  // looked up among every record's identifiers.
  const own = (
    await perValue<{ record: string; kind: string; value: string }>(
      op,
      records.map((r) => r.id),
      (v) => `SELECT record, kind, value FROM record_identifiers WHERE record = ${v};`,
    )
  )
    .flat()
    .filter((i) => ['email', 'phone', 'domain'].includes(i.kind));
  const holders = await perValue<{ record: string }>(
    op,
    own.map((i) => [i.kind, i.value]),
    (v) => `SELECT record FROM record_identifiers WHERE kind = ${v}[0] AND value = ${v}[1];`,
  );
  const sharedCandidates = new Map<string, { pair: [string, string]; kind: string }>();
  own.forEach((identifier, i) => {
    for (const { record } of holders[i] ?? []) {
      if (record === identifier.record) continue;
      const pair = pairKey(identifier.record, record);
      const key = pair.join('\n');
      const rank = (k: string) => ['email', 'phone', 'domain'].indexOf(k);
      const existing = sharedCandidates.get(key);
      if (!existing || rank(identifier.kind) < rank(existing.kind)) {
        sharedCandidates.set(key, { pair, kind: identifier.kind });
      }
    }
  });
  const others = await directoryEntries(
    op.db,
    [...sharedCandidates.values()].flatMap((c) => c.pair),
  );
  let shared = 0;
  for (const { pair, kind } of [...sharedCandidates.values()].sort((x, y) =>
    x.pair.join().localeCompare(y.pair.join()),
  )) {
    if (shared >= cap) break;
    const [a, b] = pair;
    const ea = others.get(a);
    const eb = others.get(b);
    if (!ea || !eb || ea.deleted_at || eb.deleted_at) continue;
    if (ea.object_type_id !== eb.object_type_id || !entityTypes.has(ea.object_type_id)) continue;
    if (await isKnown(a, b)) continue;
    propose(a, b, `shared ${kind}`);
    shared++;
  }

  // Similar labels: trigram candidates from the label index, reranked.
  const labels = await op.rows<{ id: RecordId; label: string }>(
    'SELECT id, label FROM $ids WHERE label != NONE;',
    { ids: records.map((r) => new RecordId('search_documents', r.id)) },
  );
  const comparable = labels.filter((l) => l.label.trim().length >= MIN_LABEL_LENGTH);
  const candidates = await perValue<{
    owner: string;
    label?: string | null;
    object_type_id: string;
    kind: string;
  }>(
    op,
    comparable.map((l) => l.label),
    (v) =>
      `SELECT owner, label, object_type_id, kind FROM search_documents WHERE grams @OR@ ${v} LIMIT ${NAME_CANDIDATES};`,
  );
  const similarPairs = new Map<string, [string, string]>();
  comparable.forEach((row, i) => {
    const id = publicId(row.id);
    const folded = fold(row.label.trim());
    for (const candidate of candidates[i] ?? []) {
      if (candidate.kind !== 'record' || candidate.owner === id) continue;
      if (candidate.object_type_id !== typeOf.get(id)) continue;
      const label = candidate.label?.trim() ?? '';
      if (label.length < MIN_LABEL_LENGTH) continue;
      // Reranked on folded labels, so case and accents never decide.
      if (similarity(folded, fold(label)) < NAME_SIMILARITY) continue;
      const pair = pairKey(id, candidate.owner);
      similarPairs.set(pair.join('\n'), pair);
    }
  });
  const similarEntries = await directoryEntries(op.db, [...similarPairs.values()].flat());
  let similar = 0;
  for (const [a, b] of [...similarPairs.values()].sort((x, y) =>
    x.join().localeCompare(y.join()),
  )) {
    if (similar >= cap) break;
    if (similarEntries.get(a)?.deleted_at || similarEntries.get(b)?.deleted_at) continue;
    if (!similarEntries.get(a) || !similarEntries.get(b)) continue;
    if (await isKnown(a, b)) continue;
    propose(a, b, 'similar names');
    similar++;
  }
  return { added: shared + similar, capped: shared >= cap || similar >= cap };
}

/** Jaro-Winkler similarity, the measure the trigram candidates are reranked by. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = new Array<boolean>(a.length).fill(false);
  const matchedB = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = true;
      matchedB[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!matchedA[i]) continue;
    while (!matchedB[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}
