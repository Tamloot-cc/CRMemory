import type {
  TraverseEvidence,
  TraverseInput,
  TraversePath,
  TraverseRecordRef,
  TraverseResult,
  TraverseStep,
} from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { publicId, relationTable } from '../db/names.js';
import { ident } from '../db/surreal.js';
import { AppError } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import { type FieldState, relationTargetIds } from '../schema-engine/types.js';
import { owningFieldOf } from './read.js';
import { type DirEntry, directoryEntries } from './store.js';
import { MAX_MERGE_HOPS } from './write.js';

/**
 * `traverse_records` (spec section 8): bounded walks over relation edges and
 * event links from a few start records, along an explicit path. Each
 * expansion reads an indexed adjacency window per frontier record, one
 * top-level statement each, limited to the edge budget left; every edge
 * read counts, including those then discarded. Results are in a fixed
 * order and say when they are incomplete. No recursion and no filters
 * beyond the path: select start records with `query_records`.
 */

export const TRAVERSE_LIMITS = { starts: 20, steps: 3, examinedEdges: 500, paths: 50 } as const;

const stepSchema = z.union([
  z.strictObject({
    field: z.string().trim().min(1).max(100),
    direction: z.enum(['out', 'in']).default('out'),
  }),
  z.strictObject({
    link: z.enum(['participant', 'about']),
    direction: z.enum(['out', 'in']),
  }),
]);

export const traverseInputSchema = z.strictObject({
  starts: z.array(z.uuid()).min(1).max(TRAVERSE_LIMITS.starts),
  path: z.array(stepSchema).min(1).max(TRAVERSE_LIMITS.steps),
});

/** One edge read; `kept: false` when it is read but does not match the step. */
type Hop = { to: string; evidence: TraverseEvidence; kept?: boolean };

type Walk = { records: string[]; steps: TraverseEvidence[] };

/** A resolved field step for one frontier object: which edge table and which way. */
type FieldHop = { field: FieldState; reverse: boolean };

/** Resolves a field step on the frontier object; undefined when the name does not apply. */
function resolveFieldHops(
  schema: CompiledSchema,
  object: CompiledObject,
  step: { field: string; direction: 'out' | 'in' },
): FieldHop[] {
  if (step.direction === 'out') {
    const field = object.fieldsByName.get(step.field);
    if (field?.type !== 'relation') return [];
    if (!field.settings.isInverse) return [{ field, reverse: false }];
    const owning = owningFieldOf(schema, field);
    return owning && owning.status === 'active' ? [{ field: owning, reverse: true }] : [];
  }
  // `in`: owning fields of this name, on any visible object, that point here.
  const hops: FieldHop[] = [];
  for (const id of schema.visibleObjectIds) {
    const other = schema.objectsById.get(id);
    const field = other?.fieldsByName.get(step.field);
    if (field?.type !== 'relation' || field.settings.isInverse) continue;
    if (relationTargetIds(field.settings).includes(object.state.universalId)) {
      hops.push({ field, reverse: true });
    }
  }
  return hops;
}

/** Follows merges for the start records; unknown IDs are absent. */
async function resolveStarts(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  let pending = new Map(ids.map((id) => [id, id]));
  for (let hop = 0; hop <= MAX_MERGE_HOPS && pending.size > 0; hop++) {
    const entries = await directoryEntries(db, [...new Set(pending.values())]);
    const next = new Map<string, string>();
    for (const [start, current] of pending) {
      const entry = entries.get(current);
      if (!entry) continue;
      if (entry.merged_into) next.set(start, entry.merged_into);
      else resolved.set(start, current);
    }
    pending = next;
  }
  return resolved;
}

export async function traverseRecords(
  db: Db,
  schema: CompiledSchema,
  input: TraverseInput,
): Promise<TraverseResult> {
  const path = input.path.map((step) =>
    'field' in step ? { ...step, direction: step.direction ?? 'out' } : step,
  ) as (
    | { field: string; direction: 'out' | 'in' }
    | { link: 'participant' | 'about'; direction: 'out' | 'in' }
  )[];
  const visible = new Set(schema.visibleObjectIds);

  // Start records: live and visible, after merges, each once, in the given order.
  const resolved = await resolveStarts(db, input.starts);
  const startIds = [...new Set(input.starts.flatMap((id) => resolved.get(id) ?? []))];
  const startEntries = await directoryEntries(db, startIds);
  const errors = input.starts.flatMap((id, index) => {
    const canonical = resolved.get(id);
    const entry = canonical ? startEntries.get(canonical) : undefined;
    if (!entry || !visible.has(entry.object_type_id)) {
      return [{ index, id, message: 'no record with this ID' }];
    }
    if (entry.deleted_at) return [{ index, id, message: 'the record is deleted' }];
    return [];
  });
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_starts', 'some start records cannot be used', { errors });
  }
  path.forEach((step, index) => {
    if ('field' in step) {
      const known = schema.visibleObjectIds.some(
        (id) => schema.objectsById.get(id)?.fieldsByName.get(step.field)?.type === 'relation',
      );
      if (!known) {
        throw new AppError(
          422,
          'invalid_path',
          `step ${index}: no relation field "${step.field}"`,
          {
            step: index,
          },
        );
      }
    }
  });

  const entries = new Map<string, DirEntry>(startEntries);
  let examined = 0;
  let truncated: TraverseResult['truncated'] = null;
  let frontier: Walk[] = startIds.map((id) => ({ records: [id], steps: [] }));

  for (const step of path) {
    const ids = [...new Set(frontier.map((p) => p.records.at(-1) as string))].sort();
    const neighbors = new Map<string, Hop[]>();
    for (const id of ids) {
      const budget = TRAVERSE_LIMITS.examinedEdges - examined;
      if (budget <= 0) {
        truncated = 'edge_budget';
        break;
      }
      const entry = entries.get(id);
      const object = entry ? schema.objectsById.get(entry.object_type_id) : undefined;
      if (!entry || !object) continue;
      const window = await adjacency(db, schema, object, entry, step, budget + 1);
      // A full window means more edges than the budget allows: read up to it.
      if (window.length > budget) {
        truncated = 'edge_budget';
        window.length = budget;
      }
      examined += window.length;
      neighbors.set(id, window);
    }
    const reached = await directoryEntries(
      db,
      [...neighbors.values()].flatMap((hops) => hops.map((h) => h.to)),
    );
    for (const [id, entry] of reached) entries.set(id, entry);
    const next: Walk[] = [];
    for (const partial of frontier) {
      const from = partial.records.at(-1) as string;
      for (const hop of neighbors.get(from) ?? []) {
        if (hop.kept === false) continue;
        const entry = entries.get(hop.to);
        if (!entry || entry.deleted_at || entry.merged_into || !visible.has(entry.object_type_id)) {
          continue;
        }
        if (partial.records.includes(hop.to)) continue;
        next.push({
          records: [...partial.records, hop.to],
          steps: [...partial.steps, hop.evidence],
        });
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const complete = frontier.filter((p) => p.records.length === path.length + 1);
  if (complete.length > TRAVERSE_LIMITS.paths) truncated ??= 'path_limit';
  const paths = complete.slice(0, TRAVERSE_LIMITS.paths);
  const refs = await recordRefs(
    db,
    schema,
    entries,
    paths.flatMap((p) => p.records),
  );
  return {
    schemaVersion: schema.version,
    paths: paths.map(
      (p): TraversePath => ({
        records: p.records.map((id) => refs.get(id) as TraverseRecordRef),
        steps: p.steps,
      }),
    ),
    examinedEdges: examined,
    limits: { ...TRAVERSE_LIMITS },
    truncated,
  };
}

/**
 * One frontier record's adjacency window for a step: at most `limit`
 * edges, read by index in a fixed order, as top-level statements.
 */
async function adjacency(
  db: Db,
  schema: CompiledSchema,
  object: CompiledObject,
  entry: DirEntry,
  step:
    | { field: string; direction: 'out' | 'in' }
    | { link: 'participant' | 'about'; direction: 'out' | 'in' },
  limit: number,
): Promise<Hop[]> {
  if ('link' in step) {
    // event_attachments holds every direct link of an event to a record.
    // The window is read by index alone; the kind is checked after, and
    // every row read counts against the budget.
    const rows = await db.rows<{
      event: string;
      target: string;
      via: string;
      link_id?: string | null;
    }>(
      step.direction === 'in'
        ? 'SELECT event, target, via, link_id, occurred_at FROM event_attachments WHERE target = $id ORDER BY occurred_at DESC LIMIT $limit;'
        : 'SELECT event, target, via, link_id FROM event_attachments WHERE event = $id ORDER BY target LIMIT $limit;',
      { id: entry.id, limit },
    );
    return rows.map((row) => ({
      kept: row.via === step.link,
      to: step.direction === 'in' ? row.event : row.target,
      evidence: {
        link: step.link,
        direction: step.direction,
        eventId: row.event,
        linkId: row.link_id ?? null,
      },
    }));
  }
  const hops = resolveFieldHops(schema, object, step);
  const node = new RecordId(object.table, entry.id);
  const out: Hop[] = [];
  for (const hop of hops) {
    const remaining = limit - out.length;
    if (remaining <= 0) break;
    const table = ident(relationTable(hop.field.universalId));
    const rows = await db.rows<{ other: RecordId; assertion?: string | null }>(
      hop.reverse
        ? `SELECT in AS other, assertion FROM ${table} WHERE out = $node ORDER BY in LIMIT $limit;`
        : `SELECT out AS other, assertion FROM ${table} WHERE in = $node ORDER BY out LIMIT $limit;`,
      { node, limit: remaining },
    );
    for (const row of rows) {
      out.push({
        to: publicId(row.other),
        evidence: {
          field: step.field,
          direction: step.direction,
          assertionId: row.assertion ?? null,
        },
      });
    }
  }
  return out;
}

/** References for records on the returned paths: type and label, by point lookups. */
async function recordRefs(
  db: Db,
  schema: CompiledSchema,
  entries: Map<string, DirEntry>,
  ids: readonly string[],
): Promise<Map<string, TraverseRecordRef>> {
  const unique = [...new Set(ids)];
  const labels = await db.rows<{ id: RecordId; label?: string | null }>(
    'SELECT id, label FROM $ids;',
    { ids: unique.map((id) => new RecordId('search_documents', id)) },
  );
  const byId = new Map(labels.map((l) => [publicId(l.id), l.label ?? null]));
  return new Map(
    unique.map((id) => [
      id,
      {
        id,
        type: schema.objectsById.get(entries.get(id)?.object_type_id ?? '')?.name ?? 'unknown',
        label: byId.get(id) ?? null,
      },
    ]),
  );
}

export type { TraverseStep };
