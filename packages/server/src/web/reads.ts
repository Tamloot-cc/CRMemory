import {
  type Actor,
  type AssertionView,
  isCollectionRelation,
  type Provenance,
  type RecordReference,
} from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { isUuid, publicId } from '../db/names.js';
import { cursorPosition, keysetStream, page, type StreamSpec } from '../db/pagination.js';
import { notFound } from '../errors.js';
import { presentSource } from '../memory/events.js';
import { identifiersFor } from '../records/derive.js';
import { getRecord, type PresentedRecord } from '../records/read.js';
import { references } from '../records/references.js';
import { directoryEntries, fetchRows, outgoingEdges, type RecordRow } from '../records/store.js';
import { normalizeFieldValue } from '../records/values.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';

export async function relationReferences(
  db: Db,
  schema: CompiledSchema,
  records: PresentedRecord[],
) {
  const ids = records.flatMap((r) => {
    const object = schema.objectsByName.get(r.object);
    return (object?.activeFields.filter((f) => f.type === 'relation') ?? []).flatMap((f) => {
      const value = r.fields[f.name];
      return typeof value === 'string' ? [value] : Array.isArray(value) ? (value as string[]) : [];
    });
  });
  return references(db, schema, [...new Set(ids)]);
}

/** A stored assertion as read. */
export type StoredAssertion = {
  id: string;
  record: string;
  field_id: string;
  value: unknown;
  actor: Actor;
  source: string | null;
  is_initial: boolean;
  confidence: number;
  status: AssertionView['status'];
  review_reason: AssertionView['reason'];
  observed_at: Date;
  reviewed_by: Actor | null;
  reviewed_at: Date | null;
  created_at: Date;
};

type NativeAssertion = Omit<
  StoredAssertion,
  'id' | 'source' | 'review_reason' | 'reviewed_by' | 'reviewed_at'
> & {
  id: RecordId;
  source?: string | null;
  review_reason?: AssertionView['reason'];
  reviewed_by?: Actor | null;
  reviewed_at?: Date | null;
};

export const assertionOf = (row: NativeAssertion): StoredAssertion => ({
  ...row,
  id: publicId(row.id),
  source: row.source ?? null,
  review_reason: row.review_reason ?? null,
  reviewed_by: row.reviewed_by ?? null,
  reviewed_at: row.reviewed_at ?? null,
});

/**
 * Which assertions a page lists: one indexed stream over `field_assertions`
 * ordered by `created_at` (`where` is a top-level condition on parameters),
 * and what is kept of each batch (liveness and the like, read in bulk).
 */
export type AssertionSource = {
  where: string;
  vars: Record<string, unknown>;
  keep?: (rows: StoredAssertion[]) => Promise<StoredAssertion[]> | StoredAssertion[];
};

/** A keyset page of assertions, oldest first (or newest), presented. */
export async function assertions(
  db: Db,
  schema: CompiledSchema,
  source: AssertionSource,
  limit: number,
  cursor?: string,
  descending = false,
) {
  const spec: StreamSpec<NativeAssertion> = {
    table: 'field_assertions',
    where: source.where,
    vars: source.vars,
    time: 'created_at',
    fields: '*',
    timeOf: (r) => r.created_at,
    keyOf: (r) => publicId(r.id),
    descending,
    batch: Math.min(Math.max(limit + 1, 20), 500),
  };
  const stream = keysetStream(db, spec, cursorPosition(cursor));
  const found: StoredAssertion[] = [];
  let chunk: StoredAssertion[] = [];
  const flush = async () => {
    found.push(...(source.keep ? await source.keep(chunk) : chunk));
    chunk = [];
  };
  for await (const native of stream) {
    chunk.push(assertionOf(native));
    if (chunk.length >= (spec.batch as number)) {
      await flush();
      if (found.length > limit) break;
    }
  }
  if (found.length <= limit && chunk.length > 0) await flush();
  const result = page(
    found.slice(0, limit + 1).map((r) => ({ ...r, stamp: r.created_at })),
    limit,
  );
  return {
    items: await presentAssertions(db, schema, result.items),
    nextCursor: result.nextCursor,
  };
}

/** Assertions by ID, in the given order; unknown IDs are absent. */
export async function assertionsByIds(db: Db, ids: readonly string[]): Promise<StoredAssertion[]> {
  const valid = [...new Set(ids)].filter(isUuid);
  if (valid.length === 0) return [];
  const rows = await db.rows<NativeAssertion>('SELECT * FROM $ids;', {
    ids: valid.map((id) => new RecordId('field_assertions', id)),
  });
  const byId = new Map(rows.map((r) => [publicId(r.id), assertionOf(r)]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** Keeps the assertions whose record is live (not deleted). */
export async function onLiveRecords(db: Db, rows: StoredAssertion[]): Promise<StoredAssertion[]> {
  const entries = await directoryEntries(
    db,
    rows.map((r) => r.record),
  );
  return rows.filter((r) => {
    const entry = entries.get(r.record);
    return !!entry && !entry.deleted_at;
  });
}

/**
 * Assertions as the API presents them: the record's label and current
 * value, the live visible source, and for a unique conflict the record
 * that holds the value. Every lookup is batched for the whole page.
 */
export async function presentAssertions(
  db: Db,
  schema: CompiledSchema,
  items: readonly StoredAssertion[],
): Promise<AssertionView[]> {
  if (items.length === 0) return [];
  const entries = await directoryEntries(db, [
    ...items.map((r) => r.record),
    ...items.flatMap((r) => (r.source ? [r.source] : [])),
  ]);
  const visible = new Set(schema.visibleObjectIds);
  const liveSources = [...entries.values()].filter(
    (e) => items.some((r) => r.source === e.id) && !e.deleted_at && visible.has(e.object_type_id),
  );
  const recordEntries = [...entries.values()].filter((e) => items.some((r) => r.record === e.id));
  const rows: Map<string, RecordRow> = await fetchRows(db, '', schema, [
    ...recordEntries,
    ...liveSources,
  ]);

  // Current links of relation fields, from the records' own edges.
  const relationFieldIds = new Set(
    items.flatMap((r) => {
      const field = schema.fieldOwners.get(r.field_id)?.fieldsById.get(r.field_id);
      return field?.type === 'relation' ? [field.id as string] : [];
    }),
  );
  const edgeRecords = recordEntries.flatMap((e) => {
    const object = schema.objectsById.get(e.object_type_id);
    return object && items.some((r) => r.record === e.id && relationFieldIds.has(r.field_id))
      ? [{ id: e.id, object }]
      : [];
  });
  const edges = edgeRecords.length
    ? await outgoingEdges(db, edgeRecords, (f) => relationFieldIds.has(f.id as string))
    : [];
  const linksOf = (record: string, field: string) =>
    edges
      .filter((e) => e.record_id === record && e.field_id === field)
      .map((e) => e.other_id)
      .sort();

  // Resolve unique claims in one request for the whole page, never one read per row.
  const claims = items.flatMap((r) => {
    const field = schema.fieldOwners.get(r.field_id)?.fieldsById.get(r.field_id);
    if (r.review_reason !== 'unique_conflict' || !field) return [];
    try {
      return identifiersFor(field, normalizeFieldValue(field, r.value)).map((i) => ({
        assertion: r.id,
        field: r.field_id,
        value: i.value,
      }));
    } catch {
      return [];
    }
  });
  const holders = claims.length
    ? (
        (await db.query(
          claims
            .map(
              (_, i) =>
                `SELECT record, field_id, value FROM unique_claims WHERE field_id = $f${i} AND value = $v${i};`,
            )
            .join('\n'),
          Object.fromEntries(
            claims.flatMap((c, i) => [
              [`f${i}`, c.field],
              [`v${i}`, c.value],
            ]),
          ),
        )) as { record: string; field_id: string; value: string }[][]
      ).flat()
    : [];
  const targetIds = items.flatMap((r) => {
    if (!relationFieldIds.has(r.field_id)) return [];
    return [r.value, linksOf(r.record, r.field_id)]
      .flat()
      .filter((v): v is string => typeof v === 'string');
  });
  const refs = await references(db, schema, [...holders.map((h) => h.record), ...targetIds]);

  return items.map((r): AssertionView => {
    const record = rows.get(r.record);
    const object = record ? schema.objectsById.get(record.object_type_id) : undefined;
    const field = object?.fieldsById.get(r.field_id);
    const claim = claims.filter((c) => c.assertion === r.id);
    const holder = holders.find(
      (h) =>
        h.record !== r.record && claim.some((c) => c.value === h.value && c.field === h.field_id),
    );
    const links = field?.type === 'relation' ? linksOf(r.record, r.field_id) : [];
    const source = r.source ? rows.get(r.source) : undefined;
    return {
      id: r.id,
      recordId: r.record,
      recordLabel: record?.label ?? null,
      object: object?.name ?? 'unknown',
      field: field?.name ?? r.field_id,
      value: r.value,
      currentValue:
        field?.type === 'relation'
          ? isCollectionRelation(field)
            ? links
            : (links[0] ?? null)
          : field
            ? (record?.data[field.key] ?? null)
            : null,
      status: r.status,
      reason: r.review_reason,
      actor: r.actor,
      confidence: r.confidence,
      observedAt: r.observed_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      sourceRecordId: r.source,
      isInitial: r.is_initial,
      source: presentSource(schema, {
        source_record_id: source ? r.source : null,
        source_type: source?.object_type_id ?? null,
        source_data: source?.data ?? null,
        occurred_at: source?.occurred_at ?? null,
      }),
      conflictingRecord: holder ? (refs[holder.record] ?? null) : null,
      ...(field?.type === 'relation' ? { relationReferences: refs } : {}),
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
    };
  });
}

export async function assertionById(db: Db, schema: CompiledSchema, id: string) {
  const [row] = await assertionsByIds(db, [id]);
  if (!row) throw notFound('assertion');
  const [view] = await presentAssertions(db, schema, [row]);
  return view as AssertionView;
}

export async function enrichedRecord(
  db: Db,
  workspaceId: string,
  schema: CompiledSchema,
  id: string,
  includes: string[],
) {
  const record = await getRecord(db, workspaceId, schema, id);
  const result: PresentedRecord & {
    provenance?: Record<string, Provenance>;
    relationReferences?: Record<string, RecordReference>;
  } = { ...record };
  if (includes.includes('relationReferences'))
    result.relationReferences = await relationReferences(db, schema, [record]);
  if (includes.includes('provenance')) {
    // Active assertions are unique per field after recomputation; pending
    // IDs are listed without a page cap. The record's own assertions only.
    const rows = (
      await db.rows<NativeAssertion>(
        "SELECT * FROM field_assertions WHERE record = $record AND status IN ['active', 'pending_review'];",
        { record: record.id },
      )
    )
      .map(assertionOf)
      .sort(
        (a, b) =>
          a.created_at.getTime() - b.created_at.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const firstPending = new Map<string, StoredAssertion>();
    for (const row of rows) {
      if (row.status === 'pending_review' && !firstPending.has(row.field_id))
        firstPending.set(row.field_id, row);
    }
    const shown = rows.filter((r) => r.status === 'active' || firstPending.get(r.field_id) === r);
    const active = await presentAssertions(db, schema, shown);
    result.provenance = Object.fromEntries(
      (schema.objectsByName.get(record.object)?.activeFields ?? [])
        .filter((f) => !f.settings.isInverse)
        .map((f) => [
          f.name,
          {
            assertion: active.find((a) => a.field === f.name && a.status === 'active') ?? null,
            pendingAssertion:
              active.find((a) => a.field === f.name && a.status === 'pending_review') ?? null,
            pendingAssertionIds: rows
              .filter((a) => a.field_id === f.id && a.status === 'pending_review')
              .map((a) => a.id),
          },
        ]),
    );
  }
  return result;
}
