import type { Actor, PresentedFact, ReviewQueue, UnresolvedParticipant } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { publicId } from '../db/names.js';
import { cursorPosition, keysetStream, page, take } from '../db/pagination.js';
import { liveFactSources } from '../memory/events.js';
import { factSources } from '../memory/facts.js';
import { references } from '../records/references.js';
import { directoryEntries, fetchRows } from '../records/store.js';
import { type CompiledSchema, eventText } from '../schema-engine/compiled.js';
import { assertions, onLiveRecords, type StoredAssertion } from './reads.js';

/** Pending assertions the queue lists: on live records, of active fields. */
async function reviewable(
  db: Db,
  schema: CompiledSchema,
  rows: StoredAssertion[],
): Promise<StoredAssertion[]> {
  const active = rows.filter(
    (r) => schema.fieldOwners.get(r.field_id)?.fieldsById.get(r.field_id)?.status === 'active',
  );
  return onLiveRecords(db, active);
}

type Suggestion = {
  id: RecordId;
  record_a: string;
  record_b: string;
  reason: string;
  created_at: Date;
};

type UnresolvedRow = {
  id: string;
  event_id: string;
  position: number;
  handle: string | null;
  role: string | null;
  occurred_at: Date;
  object_type_id: string;
  data: Record<string, unknown>;
};

/**
 * Participants whose record was deleted, on live events of visible types,
 * oldest event first. Read whole through the `unmatched_reason` index: the
 * set is what a reviewer still has to resolve.
 */
async function unresolvedParticipants(db: Db, schema: CompiledSchema): Promise<UnresolvedRow[]> {
  const links = await db.rows<{
    id: RecordId;
    event: string;
    position: number;
    handle?: string | null;
    role?: string | null;
    record?: string | null;
  }>("SELECT * FROM event_links WHERE unmatched_reason = 'deleted_record';");
  const open = links.filter((l) => !l.record);
  const types = new Set(schema.eventTypeIds);
  const events = [
    ...(
      await directoryEntries(
        db,
        open.map((l) => l.event),
      )
    ).values(),
  ].filter((e) => !e.deleted_at && types.has(e.object_type_id));
  const rows = await fetchRows(db, '', schema, events);
  return open
    .flatMap((l): UnresolvedRow[] => {
      const event = rows.get(l.event);
      if (!event?.occurred_at) return [];
      return [
        {
          id: publicId(l.id),
          event_id: l.event,
          position: l.position,
          handle: l.handle ?? null,
          role: l.role ?? null,
          occurred_at: event.occurred_at,
          object_type_id: event.object_type_id,
          data: event.data,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.occurred_at.getTime() - b.occurred_at.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** Rows after a keyset cursor in ascending (time, id) order. */
function after<T extends { id: string }>(rows: T[], timeOf: (r: T) => Date, cursor?: string): T[] {
  const start = cursorPosition(cursor);
  if (!start) return rows;
  const at = start.at.getTime();
  return rows.filter((r) => {
    const t = timeOf(r).getTime();
    return t > at || (t === at && r.id > start.key);
  });
}

export async function reviewPage(
  db: Db,
  _workspaceId: string,
  schema: CompiledSchema,
  limit: number,
  cursors: Record<string, string>,
): Promise<ReviewQueue> {
  const pendingSource = {
    where: "status = 'pending_review'",
    vars: {},
    keep: (rows: StoredAssertion[]) => reviewable(db, schema, rows),
  };
  const [pending, suggestions, unresolved, pendingTotal, mergeTotal] = await Promise.all([
    assertions(db, schema, pendingSource, limit, cursors.pendingAssertionsCursor),
    take(
      keysetStream<Suggestion>(
        db,
        {
          table: 'merge_suggestions',
          where: "status = 'pending'",
          time: 'created_at',
          fields: '*',
          timeOf: (r) => r.created_at,
          keyOf: (r) => publicId(r.id),
          descending: false,
          batch: limit + 1,
        },
        cursorPosition(cursors.mergeSuggestionsCursor),
      ),
      limit + 1,
    ),
    unresolvedParticipants(db, schema),
    db
      .rows<StoredAssertion>(
        "SELECT record, field_id FROM field_assertions WHERE status = 'pending_review';",
      )
      .then((rows) => reviewable(db, schema, rows))
      .then((rows) => rows.length),
    db
      .rows<{ count: number }>(
        "SELECT count() FROM merge_suggestions WHERE status = 'pending' GROUP ALL;",
      )
      .then((rows) => rows[0]?.count ?? 0),
  ]);
  const m = page(
    suggestions.map((s) => ({ ...s, id: publicId(s.id), stamp: s.created_at })),
    limit,
  );
  const u = page(
    after(unresolved, (r) => r.occurred_at, cursors.unresolvedParticipantsCursor)
      .slice(0, limit + 1)
      .map((r) => ({ ...r, stamp: r.occurred_at })),
    limit,
  );
  const handles = [...new Set(u.items.flatMap((r) => (r.handle ? [r.handle] : [])))];
  const [labels, deleted] = await Promise.all([
    references(
      db,
      schema,
      m.items.flatMap((r) => [r.record_a, r.record_b]),
    ),
    deletedHolders(db, handles),
  ]);
  return {
    pendingAssertions: pending.items,
    mergeSuggestions: m.items.map((r) => ({
      id: r.id,
      recordIds: [r.record_a, r.record_b],
      records: [r.record_a, r.record_b].flatMap((id) => {
        const reference = labels[id];
        return reference ? [reference] : [];
      }),
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    })),
    unresolvedParticipants: u.items.map(
      (r): UnresolvedParticipant => ({
        eventId: r.event_id,
        position: r.position,
        handle: r.handle,
        role: r.role,
        occurredAt: r.occurred_at.toISOString(),
        title: eventText(schema.objectsById.get(r.object_type_id), r.data).title,
        deletedRecordIds: deleted.filter((d) => d.value === r.handle).map((d) => d.record),
      }),
    ),
    totals: {
      pendingAssertions: pendingTotal,
      mergeSuggestions: mergeTotal,
      unresolvedParticipants: unresolved.length,
    },
    nextCursors: {
      pendingAssertions: pending.nextCursor,
      mergeSuggestions: m.nextCursor,
      unresolvedParticipants: u.nextCursor,
    },
  };
}

/** Deleted (not merged) records that held these email handles. */
async function deletedHolders(
  db: Db,
  handles: readonly string[],
): Promise<{ value: string; record: string }[]> {
  if (handles.length === 0) return [];
  const rows = (
    (await db.query(
      handles
        .map(
          (_, i) =>
            `SELECT value, record FROM record_identifiers WHERE kind = 'email' AND value = $h${i};`,
        )
        .join('\n'),
      Object.fromEntries(handles.map((h, i) => [`h${i}`, h])),
    )) as { value: string; record: string }[][]
  ).flat();
  const entries = await directoryEntries(
    db,
    rows.map((r) => r.record),
  );
  const seen = new Set<string>();
  return rows.filter((r) => {
    const entry = entries.get(r.record);
    const key = `${r.value}\n${r.record}`;
    if (!entry?.deleted_at || entry.merged_into || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type StoredFact = {
  id: RecordId;
  record: string;
  content: string;
  kind: 'stated' | 'inferred';
  valid_from: Date;
  valid_to?: Date | null;
  superseded_by?: string | null;
  actor: Actor;
  created_at: Date;
  deleted_at?: Date | null;
};

/** Which facts a page lists: one record's (indexed), or some facts by ID. */
export type FactsOf = { record: string } | { factIds: readonly string[] };

/** The facts citing an event (indexed by source). */
export async function factsCiting(db: Db, eventId: string): Promise<string[]> {
  return [
    ...new Set(
      await db.rows<string>('SELECT VALUE fact FROM fact_sources WHERE source = $source;', {
        source: eventId,
      }),
    ),
  ];
}

/**
 * A page of facts, newest `validFrom` first, keyset on (valid_from, id).
 * Without `history`, only current facts: not retracted, superseded or
 * ended, and resting on a live source (2.1).
 */
export async function factsPage(
  db: Db,
  schema: CompiledSchema,
  of: FactsOf,
  limit: number,
  cursor?: string,
  history = false,
): Promise<{ facts: PresentedFact[]; nextCursor: string | null }> {
  const keep = async (rows: StoredFact[]) => {
    const visible = history
      ? rows
      : rows.filter((r) => !r.deleted_at && !r.superseded_by && !r.valid_to);
    if (history) return visible;
    const live = await liveFactSources(
      db,
      visible.map((r) => publicId(r.id)),
    );
    return visible.filter((r) => (live.get(publicId(r.id))?.length ?? 0) > 0);
  };
  const found: StoredFact[] = [];
  if ('record' in of) {
    const batch = Math.min(Math.max(limit + 1, 20), 500);
    let chunk: StoredFact[] = [];
    for await (const row of keysetStream<StoredFact>(
      db,
      {
        table: 'facts',
        where: 'record = $record',
        vars: { record: of.record },
        time: 'valid_from',
        fields: '*',
        timeOf: (r) => r.valid_from,
        keyOf: (r) => publicId(r.id),
        batch,
      },
      cursorPosition(cursor),
    )) {
      chunk.push(row);
      if (chunk.length >= batch) {
        found.push(...(await keep(chunk)));
        chunk = [];
        if (found.length > limit) break;
      }
    }
    if (found.length <= limit && chunk.length > 0) found.push(...(await keep(chunk)));
  } else {
    const ids = [...new Set(of.factIds)];
    const rows = ids.length
      ? await db.rows<StoredFact>('SELECT * FROM $ids;', {
          ids: ids.map((id) => new RecordId('facts', id)),
        })
      : [];
    const start = cursorPosition(cursor);
    const sorted = rows
      .sort(
        (a, b) =>
          b.valid_from.getTime() - a.valid_from.getTime() ||
          (publicId(a.id) < publicId(b.id) ? 1 : -1),
      )
      .filter((r) => {
        if (!start) return true;
        const t = r.valid_from.getTime();
        return t < start.at.getTime() || (t === start.at.getTime() && publicId(r.id) < start.key);
      });
    found.push(...(await keep(sorted)));
  }
  const result = page(
    found.slice(0, limit + 1).map((r) => ({ ...r, id: publicId(r.id), stamp: r.valid_from })),
    limit,
  );
  const sources = await factSources(
    db,
    schema,
    result.items.map((r) => r.id),
  );
  return {
    facts: result.items.map((r) => ({
      id: r.id,
      ...(history
        ? {
            status: r.deleted_at
              ? ('retracted' as const)
              : r.superseded_by
                ? ('superseded' as const)
                : r.valid_to
                  ? ('ended' as const)
                  : ('current' as const),
          }
        : {}),
      record: r.record,
      content: r.content,
      kind: r.kind,
      validFrom: r.valid_from.toISOString(),
      validTo: r.valid_to?.toISOString() ?? null,
      writtenBy: r.actor,
      sources: sources.get(r.id) ?? [],
    })),
    nextCursor: result.nextCursor,
  };
}
