import { RecordId } from '../db/cbor.js';
import { publicId, relationTable } from '../db/names.js';
import type { Operation } from '../db/protocol.js';
import { ident } from '../db/surreal.js';
import { currentTargets, entriesOf, loadRecords, type WriteContext } from '../records/write.js';
import type { CompiledObject, CompiledSchema } from '../schema-engine/compiled.js';
import type { FieldState } from '../schema-engine/types.js';

/**
 * Stored event attachments (spec section 5). `event_attachments` holds the
 * direct ways an event is attached to a record: participant, about, or one
 * of the event's own relation fields. `rollup_attachments` holds the one-hop
 * rollups of those direct attachments through entity relation fields with
 * `rollUpEvents`. Both are written in the transaction that changes the link
 * or edge they derive from, so a record's history is two indexed streams.
 * Liveness, visibility and deprecated fields are filtered when read.
 */

export type Via = 'participant' | 'about' | 'field';

export type DirectAttachment = {
  event: string;
  target: string;
  via: Via;
  /** `field`: the event's relation field. */
  fieldId?: string | null;
  /** `participant` / `about`: the canonical link entry. */
  linkId?: string | null;
};

type StoredDirect = {
  id: string;
  event: string;
  target: string;
  via: Via;
  field_id: string | null;
  link_id: string | null;
  event_type: string;
  occurred_at: Date;
};

type StoredRollup = {
  id: string;
  target: string;
  event: string;
  field_id: string;
  source: string;
};

type AttachmentState = {
  /** event → its direct attachments after this plan. */
  byEvent: Map<string, StoredDirect[]>;
  /** target → its direct attachments after this plan. */
  byTarget: Map<string, StoredDirect[]>;
  /** `target\nfield\nsource` → rollup rows after this plan. */
  rollups: Map<string, StoredRollup[]>;
};

function state(op: Operation): AttachmentState {
  let s = op.cache.get('attachments') as AttachmentState | undefined;
  if (!s) {
    s = { byEvent: new Map(), byTarget: new Map(), rollups: new Map() };
    op.cache.set('attachments', s);
  }
  return s;
}

const directKey = (a: { via: string; field_id?: string | null; link_id?: string | null }) =>
  `${a.via}\n${a.field_id ?? ''}\n${a.link_id ?? ''}`;

type Row = Omit<StoredDirect, 'id' | 'field_id' | 'link_id'> & {
  id: RecordId;
  field_id?: string | null;
  link_id?: string | null;
};
const fromRow = (row: Row): StoredDirect => ({
  ...row,
  id: publicId(row.id),
  field_id: row.field_id ?? null,
  link_id: row.link_id ?? null,
});

async function directOfEvent(op: Operation, event: string): Promise<StoredDirect[]> {
  const s = state(op);
  const planned = s.byEvent.get(event);
  if (planned) return planned;
  const rows = (
    await op.rows<Row>(
      'SELECT id, event, target, via, field_id, link_id, event_type, occurred_at FROM event_attachments WHERE event = $event;',
      { event },
    )
  ).map(fromRow);
  s.byEvent.set(event, rows);
  return rows;
}

/** Every direct attachment of a record (bounded by its own events). */
async function directOfTarget(op: Operation, target: string): Promise<StoredDirect[]> {
  const s = state(op);
  const planned = s.byTarget.get(target);
  if (planned) return planned;
  const rows = (
    await op.rows<Row>(
      'SELECT id, event, target, via, field_id, link_id, event_type, occurred_at FROM event_attachments WHERE target = $target;',
      { target },
    )
  ).map(fromRow);
  s.byTarget.set(target, rows);
  return rows;
}

async function rollupsOf(
  op: Operation,
  target: string,
  fieldId: string,
  source: string,
): Promise<StoredRollup[]> {
  const s = state(op);
  const key = `${target}\n${fieldId}\n${source}`;
  const planned = s.rollups.get(key);
  if (planned) return planned;
  const rows = (
    await op.rows<Omit<StoredRollup, 'id'> & { id: RecordId }>(
      'SELECT id, target, event, field_id, source FROM rollup_attachments WHERE source = $source AND target = $target AND field_id = $field;',
      { source, target, field: fieldId },
    )
  ).map((r) => ({ ...r, id: publicId(r.id) }));
  s.rollups.set(key, rows);
  return rows;
}

/** The rollup relation fields (entity, owning, `rollUpEvents`) of an object. */
function rollupFields(object: CompiledObject): FieldState[] {
  if (object.isEvent) return [];
  return object.state.fields.filter(
    (f) =>
      f.status === 'active' &&
      f.type === 'relation' &&
      !f.settings.isInverse &&
      f.settings.rollUpEvents === true,
  );
}

async function nativeRef(context: WriteContext, id: string): Promise<RecordId> {
  const entry = (await entriesOf(context.op, [id])).get(id);
  if (!entry) throw new Error(`record ${id} is not in the directory`);
  return new RecordId(entry.tb, id);
}

/** Current rollup targets of a record through one field (edges, as planned). */
async function rollupTargets(
  context: WriteContext,
  object: CompiledObject,
  field: FieldState,
  source: string,
): Promise<string[]> {
  return currentTargets(context, object, field, source);
}

/** Adds rollup rows for (events × targets) through one field from one source. */
async function addRollups(
  context: WriteContext,
  field: FieldState,
  source: string,
  targets: readonly string[],
  events: readonly StoredDirect[],
): Promise<void> {
  const unique = new Map(events.map((e) => [e.event, e]));
  for (const target of targets) {
    const existing = await rollupsOf(context.op, target, field.id as string, source);
    const have = new Set(existing.map((r) => r.event));
    const rows: (StoredRollup & { event_type: string; occurred_at: Date })[] = [];
    for (const event of unique.values()) {
      if (have.has(event.event)) continue;
      rows.push({
        id: context.op.newId(),
        target,
        event: event.event,
        field_id: field.id as string,
        source,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
      });
    }
    context.op.batch.insert('rollup_attachments', rows);
    state(context.op).rollups.set(`${target}\n${field.id}\n${source}`, [...existing, ...rows]);
  }
}

/** Removes rollup rows of some events (or all) through one field from one source. */
async function removeRollups(
  context: WriteContext,
  field: FieldState,
  source: string,
  targets: readonly string[],
  events?: ReadonlySet<string>,
): Promise<void> {
  for (const target of targets) {
    const existing = await rollupsOf(context.op, target, field.id as string, source);
    const gone = existing.filter((r) => !events || events.has(r.event));
    context.op.batch.deleteIds(
      'rollup_attachments',
      gone.map((r) => r.id),
    );
    state(context.op).rollups.set(
      `${target}\n${field.id}\n${source}`,
      existing.filter((r) => !gone.includes(r)),
    );
  }
}

/**
 * Adds direct attachments, and the rollups they bring through the target's
 * rollup fields. Attachments that already exist are skipped.
 */
export async function addDirectAttachments(
  context: WriteContext,
  items: readonly DirectAttachment[],
): Promise<void> {
  if (items.length === 0) return;
  const events = await loadRecords(context, [...new Set(items.map((i) => i.event))]);
  const s = state(context.op);
  for (const item of items) {
    const event = events.get(item.event);
    if (!event?.occurred_at) throw new Error(`event ${item.event} has no time`);
    const ofEvent = await directOfEvent(context.op, item.event);
    const ofTarget = await directOfTarget(context.op, item.target);
    const row: StoredDirect = {
      id: context.op.newId(),
      event: item.event,
      target: item.target,
      via: item.via,
      field_id: item.fieldId ?? null,
      link_id: item.linkId ?? null,
      event_type: event.object_type_id,
      occurred_at: event.occurred_at,
    };
    if (ofEvent.some((a) => a.target === item.target && directKey(a) === directKey(row))) continue;
    const firstToTarget = !ofEvent.some((a) => a.target === item.target);
    context.op.batch.write(
      `RELATE ${context.op.batch.v(await nativeRef(context, item.event))}->event_attachments->${context.op.batch.v(
        await nativeRef(context, item.target),
      )} CONTENT ${context.op.batch.v({
        id: new RecordId('event_attachments', row.id),
        event: row.event,
        target: row.target,
        via: row.via,
        field_id: row.field_id,
        link_id: row.link_id,
        event_type: row.event_type,
        occurred_at: row.occurred_at,
      })} RETURN id`,
      1,
      'event_attachments',
    );
    s.byEvent.set(item.event, [...ofEvent, row]);
    s.byTarget.set(item.target, [...ofTarget, row]);
    if (!firstToTarget) continue;
    // The event now belongs to the target's history: roll it up one hop.
    const targetEntry = (await entriesOf(context.op, [item.target])).get(item.target);
    const object = targetEntry
      ? context.schema.objectsById.get(targetEntry.object_type_id)
      : undefined;
    if (!object) continue;
    for (const field of rollupFields(object)) {
      const targets = await rollupTargets(context, object, field, item.target);
      await addRollups(context, field, item.target, targets, [row]);
    }
  }
}

/**
 * Removes direct attachments; when an event is no longer attached to a
 * record in any way, its rollups from that record go too.
 */
export async function removeDirectAttachments(
  context: WriteContext,
  items: readonly DirectAttachment[],
): Promise<void> {
  const s = state(context.op);
  for (const item of items) {
    const ofEvent = await directOfEvent(context.op, item.event);
    const key = directKey({
      via: item.via,
      field_id: item.fieldId ?? null,
      link_id: item.linkId ?? null,
    });
    const gone = ofEvent.filter((a) => a.target === item.target && directKey(a) === key);
    if (gone.length === 0) continue;
    context.op.batch.deleteIds(
      'event_attachments',
      gone.map((g) => g.id),
    );
    const remaining = ofEvent.filter((a) => !gone.includes(a));
    s.byEvent.set(item.event, remaining);
    const ofTarget = await directOfTarget(context.op, item.target);
    s.byTarget.set(
      item.target,
      ofTarget.filter((a) => !gone.some((g) => g.id === a.id)),
    );
    if (remaining.some((a) => a.target === item.target)) continue;
    const targetEntry = (await entriesOf(context.op, [item.target])).get(item.target);
    const object = targetEntry
      ? context.schema.objectsById.get(targetEntry.object_type_id)
      : undefined;
    if (!object) continue;
    for (const field of rollupFields(object)) {
      const targets = await rollupTargets(context, object, field, item.target);
      await removeRollups(context, field, item.target, targets, new Set([item.event]));
    }
  }
}

/**
 * Called by the write path when an owning relation field's edges change.
 * An event's own relation field attaches the event; an entity's rollup
 * field moves the source's events between rollup targets.
 */
export async function edgesChanged(
  context: WriteContext,
  object: CompiledObject,
  field: FieldState,
  sourceId: string,
  added: readonly string[],
  removed: readonly string[],
): Promise<void> {
  if (object.isEvent) {
    await removeDirectAttachments(
      context,
      removed.map((target) => ({
        event: sourceId,
        target,
        via: 'field' as const,
        fieldId: field.id,
      })),
    );
    await addDirectAttachments(
      context,
      added.map((target) => ({
        event: sourceId,
        target,
        via: 'field' as const,
        fieldId: field.id,
      })),
    );
    return;
  }
  if (!field.settings.rollUpEvents || field.status !== 'active') return;
  await removeRollups(context, field, sourceId, removed);
  if (added.length > 0) {
    const events = await directOfTarget(context.op, sourceId);
    await addRollups(context, field, sourceId, added, events);
  }
}

/**
 * Rebuilds every rollup row of one field from its edges and the sources'
 * direct attachments: when `rollUpEvents` is turned on (section 5,
 * recomputation must agree with attachments and edges).
 */
export async function rebuildRollupsForField(
  op: Operation,
  schema: CompiledSchema,
  field: FieldState,
): Promise<void> {
  const batch = op.batch;
  batch.write(
    `DELETE rollup_attachments WHERE field_id = ${batch.v(field.id)} RETURN BEFORE`,
    { min: 0 },
    'rollup_attachments',
  );
  if (!field.settings.rollUpEvents) return;
  const edges = await op.rows<{ in: RecordId; out: RecordId }>(
    `SELECT in, out FROM ${ident(relationTable(field.universalId))};`,
  );
  const sources = [...new Set(edges.map((e) => publicId(e.in)))];
  const rows: Array<Record<string, unknown> & { id: string }> = [];
  for (const source of sources) {
    const events = (
      await op.rows<Row>(
        'SELECT id, event, target, via, field_id, link_id, event_type, occurred_at FROM event_attachments WHERE target = $target;',
        { target: source },
      )
    ).map(fromRow);
    const unique = new Map(events.map((e) => [e.event, e]));
    for (const edge of edges.filter((e) => publicId(e.in) === source)) {
      for (const event of unique.values()) {
        rows.push({
          id: op.newId(),
          target: publicId(edge.out),
          event: event.event,
          event_type: event.event_type,
          occurred_at: event.occurred_at,
          field_id: field.id as string,
          source,
        });
      }
    }
  }
  batch.insert('rollup_attachments', rows);
  void schema;
}
