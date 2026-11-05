import type {
  Actor,
  ContextFact,
  ContextField,
  ContextPack,
  EventItem,
  OpenTask,
} from '@retainer/shared';
import { BASE_FIELD_IDS, BASE_OBJECT_IDS, TASK_DONE_OPTION } from '@retainer/shared';
import { z } from 'zod';
import type { Db } from '../db/backend.js';
import type { RecordId } from '../db/cbor.js';
import { publicId } from '../db/names.js';
import { liveFactSources } from '../memory/events.js';
import { getRecord } from '../records/read.js';
import { references } from '../records/references.js';
import { directoryEntry, incomingEdges, outgoingEdges, rowsByIds } from '../records/store.js';
import { type CompiledSchema, eventText } from '../schema-engine/compiled.js';
import { CHARS_PER_TOKEN, estimateTokens, fitSections, jsonLength } from './budget.js';
import { countEventHistory, eventHistory, viaOf } from './history.js';

/**
 * Context packs (5, 6.2): what an agent needs about one record, assembled by
 * fixed rules and fitted to a token budget. Nothing is summarized; that is
 * the agent's job.
 */

export const DEFAULT_TOKEN_BUDGET = 2_000;
export const MAX_TOKEN_BUDGET = 16_000;

export const contextInputSchema = z.strictObject({
  tokenBudget: z.number().int().min(1).max(MAX_TOKEN_BUDGET).default(DEFAULT_TOKEN_BUDGET),
});
export type ContextInput = z.infer<typeof contextInputSchema>;

/**
 * The shortest JSON any section item can have: `{"id":"<uuid>"}`. A budget
 * of `n` characters never fits more than `n / MIN_ITEM_CHARS` items, so
 * reading that many rows per section lets the budget, not a row limit, decide
 * what is left out.
 */
const MIN_ITEM_CHARS = 45;

export async function contextPack(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  input: ContextInput,
): Promise<ContextPack> {
  const budgetChars = input.tokenBudget * CHARS_PER_TOKEN;
  const rows = Math.floor(budgetChars / MIN_ITEM_CHARS) + 1;
  // Resolves merged IDs and refuses deleted records, like get_record.
  const record = await getRecord(db, workspaceId, schema, recordId);
  const [fields, tasks, facts, events] = await Promise.all([
    currentFields(db, schema, record.id, record.fields),
    openTasks(db, workspaceId, schema, record.id, rows),
    currentFacts(db, schema, record.id, rows),
    recentEvents(db, workspaceId, schema, record.id, rows),
  ]);

  // The record's values are always included. The sections get what is left
  // after the whole pack around them: the record, the keys and brackets, and
  // `omitted` and `tokenEstimate` at their largest (every item omitted, an
  // estimate as long as the budget). So a pack whose values fit never
  // serializes to more than the budget.
  const head = { id: record.id, object: record.object, label: record.label, fields };
  const frame: ContextPack = {
    record: head,
    openTasks: [],
    facts: [],
    recentEvents: [],
    omitted: { openTasks: tasks.total, facts: facts.total, recentEvents: events.total },
    tokenEstimate: input.tokenBudget,
  };
  const { included } = fitSections(
    { openTasks: tasks.items, facts: facts.items, recentEvents: events.items },
    Math.max(0, budgetChars - jsonLength(frame)),
  );

  const pack: ContextPack = {
    record: head,
    ...included,
    omitted: {
      openTasks: tasks.total - included.openTasks.length,
      facts: facts.total - included.facts.length,
      recentEvents: events.total - included.recentEvents.length,
    },
    tokenEstimate: input.tokenBudget,
  };
  // The estimate covers the whole response, itself included (sized with the
  // budget in its place).
  pack.tokenEstimate = estimateTokens(pack);
  return pack;
}

type Section<T> = { items: T[]; total: number };

/**
 * The record's values with the assertion that won each (rule 2.4), so a
 * value is never mistaken for a stated fact. Read-only inverse relations
 * have no assertion of their own and are left out; open tasks cover the
 * links that matter most.
 */
async function currentFields(
  db: Db,
  schema: CompiledSchema,
  recordId: string,
  values: Record<string, unknown>,
): Promise<Record<string, ContextField>> {
  const winners = await db.rows<{ field_id: string; actor: Actor; observed_at: Date }>(
    "SELECT field_id, actor, observed_at FROM field_assertions WHERE record = $record AND status = 'active';",
    { record: recordId },
  );
  const byName = new Map<string, { actor: Actor; observed_at: Date }>();
  for (const winner of winners) {
    const field = schema.fieldOwners.get(winner.field_id)?.fieldsById.get(winner.field_id);
    if (field?.status === 'active') byName.set(field.name, winner);
  }
  const fields: Record<string, ContextField> = {};
  for (const [name, value] of Object.entries(values)) {
    const winner = byName.get(name);
    if (!winner) continue;
    fields[name] = {
      value,
      writtenBy: winner.actor,
      observedAt: winner.observed_at.toISOString(),
    };
  }
  return fields;
}

/**
 * Live tasks linked to the record in either direction, through an active
 * relation field, whose status is not `done`: earliest due date first,
 * undated last. Read from the record's own edges, both ways.
 */
async function openTasks(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<Section<OpenTask>> {
  const task = schema.objectsByUniversalId.get(BASE_OBJECT_IDS.task);
  if (task?.state.status !== 'active') return { items: [], total: 0 };
  const entry = await directoryEntry(db, recordId);
  const object = entry && schema.objectsById.get(entry.object_type_id);
  if (!object) return { items: [], total: 0 };
  const field = (universalId: string) =>
    task.activeFields.find((f) => f.universalId === universalId);
  const status = field(BASE_FIELD_IDS.taskStatus);
  const dueDate = field(BASE_FIELD_IDS.taskDueDate);

  const self = { id: recordId, object };
  const [outgoing, ...incoming] = await Promise.all([
    outgoingEdges(db, [self], (f) => f.status === 'active'),
    ...task.state.fields
      .filter((f) => f.type === 'relation' && !f.settings.isInverse && f.status === 'active')
      .map((f) => incomingEdges(db, f, [self])),
  ]);
  const ids = [...new Set([...outgoing, ...incoming.flat()].map((e) => e.other_id))].filter(
    (id) => id !== recordId,
  );
  const rows = [...(await rowsByIds(db, workspaceId, schema, ids)).values()].filter(
    (r) =>
      r.object_type_id === task.id &&
      !r.deleted_at &&
      (!status || r.data[status.key] !== TASK_DONE_OPTION),
  );
  const due = (r: (typeof rows)[number]) => {
    const value = dueDate ? r.data[dueDate.key] : undefined;
    return value === undefined || value === null ? null : String(value);
  };
  rows.sort((a, b) => {
    const x = due(a);
    const y = due(b);
    if (x !== y) return x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
    return (
      a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  });
  const page = rows.slice(0, limit);
  // Tasks are other records, so their titles come through references() (7.2).
  const refs = await references(
    db,
    schema,
    page.map((row) => row.id),
  );
  return {
    items: page.flatMap((row) => {
      const ref = refs[row.id];
      if (!ref) return [];
      return [
        {
          id: row.id,
          title: ref.label,
          status: (status ? row.data[status.key] : null) ?? null,
          dueDate: (dueDate ? row.data[dueDate.key] : null) ?? null,
        },
      ];
    }),
    total: rows.length,
  };
}

/** Current facts, newest `validFrom` first, as `GET /v1/records/:id/facts` lists them. */
async function currentFacts(
  db: Db,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<Section<ContextFact>> {
  const stored = await db.rows<{
    id: RecordId;
    content: string;
    valid_from: Date;
    valid_to?: Date | null;
    superseded_by?: string | null;
    deleted_at?: Date | null;
    created_at: Date;
    actor: Actor;
  }>(
    'SELECT id, content, valid_from, valid_to, superseded_by, deleted_at, created_at, actor FROM facts WHERE record = $record;',
    { record: recordId },
  );
  const current = stored.filter((f) => !f.deleted_at && !f.superseded_by && !f.valid_to);
  const live = await liveFactSources(
    db,
    current.map((f) => publicId(f.id)),
  );
  const rows = current
    .filter((f) => (live.get(publicId(f.id))?.length ?? 0) > 0)
    .sort(
      (a, b) =>
        b.valid_from.getTime() - a.valid_from.getTime() ||
        b.created_at.getTime() - a.created_at.getTime() ||
        (publicId(a.id) < publicId(b.id) ? -1 : 1),
    );
  return {
    items: rows.slice(0, limit).map((row) => {
      const sources = live.get(publicId(row.id)) ?? [];
      // An internal note has no ID a caller can read (6.4): it is marked.
      const internal = sources.some((s) => schema.objectsById.get(s.objectTypeId)?.hidden);
      return {
        id: publicId(row.id),
        content: row.content,
        validFrom: row.valid_from.toISOString(),
        writtenBy: row.actor,
        sources: sources
          .filter((s) => !schema.objectsById.get(s.objectTypeId)?.hidden)
          .map((s) => s.source),
        ...(internal ? { internal: true as const } : {}),
      };
    }),
    total: rows.length,
  };
}

/**
 * The record's event history (7.1, 7.2), newest first, each event once with
 * how it is attached (`via`: participant, about, one of the event's own
 * relation fields, then rolled up from a record pointing at this one).
 * Internal notes are never listed: their text is the fact's, already in
 * `facts`.
 */
async function recentEvents(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<Section<EventItem>> {
  const history = await eventHistory(db, schema, recordId, { limit });
  const records = await rowsByIds(
    db,
    workspaceId,
    schema,
    history.map((h) => h.event_id),
  );
  // Counted over the deduplicated history, so `omitted` never counts an
  // event twice (7.2).
  const total =
    history.length < limit
      ? history.length
      : await countEventHistory(db, schema, workspaceId, recordId);
  return {
    items: history.flatMap((row) => {
      const record = records.get(row.event_id);
      if (!record) return [];
      const object = schema.objectsById.get(record.object_type_id);
      return [
        {
          id: row.event_id,
          type: object?.name ?? 'unknown',
          occurredAt: row.occurred_at.toISOString(),
          ...eventText(object, record.data),
          via: viaOf(schema, row),
        },
      ];
    }),
    total,
  };
}
