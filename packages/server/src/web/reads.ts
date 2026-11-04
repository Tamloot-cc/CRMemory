import {
  type Actor,
  type AssertionView,
  isCollectionRelation,
  type Provenance,
  type RecordReference,
  type SourceReference,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { after, page } from '../db/pagination.js';
import type { Tx } from '../db/tx.js';
import { notFound } from '../errors.js';
import { identifiersFor } from '../records/derive.js';
import { getRecord, type PresentedRecord } from '../records/read.js';
import { references } from '../records/references.js';
import { normalizeFieldValue } from '../records/values.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';

export async function relationReferences(
  tx: Tx,
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
  return references(tx, schema, [...new Set(ids)]);
}
type AssertionRow = {
  id: string;
  record_id: string;
  field_id: string;
  object_type_id: string;
  label: string | null;
  data: Record<string, unknown>;
  value: unknown;
  status: AssertionView['status'];
  review_reason: AssertionView['reason'];
  actor: Actor;
  confidence: number;
  observed_at: Date;
  created_at: Date;
  source_record_id: string | null;
  is_initial: boolean;
  source_type: string | null;
  source_data: Record<string, unknown> | null;
  occurred_at: Date | null;
  reviewed_by: Actor | null;
  reviewed_at: Date | null;
  stamp: string;
  current_links: string[] | null;
};
export async function assertions(
  tx: Tx,
  schema: CompiledSchema,
  where: Fragment,
  limit: number,
  cursor?: string,
  descending = false,
) {
  const rows = await tx<
    AssertionRow[]
  >`select a.*, a.created_at::text as stamp, r.object_type_id, r.label, r.data,
    src.object_type_id as source_type, src.data as source_data, e.occurred_at,
    (select array_agg(l.target_record_id::text order by l.target_record_id) from record_links l where l.source_record_id = r.id and l.field_id = a.field_id) as current_links
    from field_assertions a join records r on r.id = a.record_id
    left join records src on src.id = a.source_record_id and src.deleted_at is null
      and src.object_type_id = any(${schema.visibleObjectIds}::uuid[])
    left join event_records e on e.record_id = src.id
    where ${where} and ${after(tx, tx`a.created_at`, tx`a.id`, cursor, descending)}
    order by a.created_at ${tx.unsafe(descending ? 'desc' : 'asc')}, a.id ${tx.unsafe(descending ? 'desc' : 'asc')} limit ${limit + 1}`;
  const result = page(rows, limit);
  // Resolve unique claims in one query for the whole page, never one read per row.
  const claims = result.items.flatMap((r) => {
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
    ? await tx<
        { field_id: string; value: string; record_id: string }[]
      >`select field_id, value, record_id from record_identifiers where is_claim and (${claims.map((c) => tx`(field_id = ${c.field}::uuid and value = ${c.value})`).reduce((a, b) => tx`${a} or ${b}`)})`
    : [];
  const targetIds = result.items.flatMap((r) => {
    const field = schema.fieldOwners.get(r.field_id)?.fieldsById.get(r.field_id);
    return field?.type === 'relation'
      ? [r.value, r.current_links].flat().filter((v): v is string => typeof v === 'string')
      : [];
  });
  const refs = await references(tx, schema, [...holders.map((h) => h.record_id), ...targetIds]);
  return {
    items: result.items.map((r): AssertionView => {
      const object = schema.objectsById.get(r.object_type_id);
      const field = object?.fieldsById.get(r.field_id);
      const claim = claims.filter((c) => c.assertion === r.id);
      const holder = holders.find(
        (h) =>
          h.record_id !== r.record_id &&
          claim.some((c) => c.value === h.value && c.field === h.field_id),
      );
      return {
        id: r.id,
        recordId: r.record_id,
        recordLabel: r.label,
        object: object?.name ?? 'unknown',
        field: field?.name ?? r.field_id,
        value: r.value,
        currentValue:
          field?.type === 'relation'
            ? isCollectionRelation(field)
              ? (r.current_links ?? [])
              : (r.current_links?.[0] ?? null)
            : field
              ? (r.data[field.key] ?? null)
              : null,
        status: r.status,
        reason: r.review_reason,
        actor: r.actor,
        confidence: r.confidence,
        observedAt: r.observed_at.toISOString(),
        createdAt: r.created_at.toISOString(),
        sourceRecordId: r.source_record_id,
        isInitial: r.is_initial,
        source: sourceOf(schema, r),
        conflictingRecord: holder ? (refs[holder.record_id] ?? null) : null,
        ...(field?.type === 'relation' ? { relationReferences: refs } : {}),
        reviewedBy: r.reviewed_by,
        reviewedAt: r.reviewed_at?.toISOString() ?? null,
      };
    }),
    nextCursor: result.nextCursor,
  };
}
/** The live, visible event an assertion cites, presented (6.4). */
function sourceOf(schema: CompiledSchema, r: AssertionRow): SourceReference | null {
  if (!r.occurred_at || !r.source_record_id || !r.source_type) return null;
  const object = schema.objectsById.get(r.source_type);
  const key = object?.core?.title.key;
  const title = key === undefined ? undefined : r.source_data?.[key];
  return {
    id: r.source_record_id,
    type: object?.name ?? 'unknown',
    title: typeof title === 'string' ? title : null,
    occurredAt: r.occurred_at.toISOString(),
  };
}
export async function assertionById(tx: Tx, schema: CompiledSchema, id: string) {
  const result = await assertions(tx, schema, tx`a.id = ${id}`, 1);
  if (!result.items[0]) throw notFound('assertion');
  return result.items[0];
}
export async function enrichedRecord(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  id: string,
  includes: string[],
) {
  const record = await getRecord(tx, workspaceId, schema, id);
  const result: PresentedRecord & {
    provenance?: Record<string, Provenance>;
    relationReferences?: Record<string, RecordReference>;
  } = { ...record };
  if (includes.includes('relationReferences'))
    result.relationReferences = await relationReferences(tx, schema, [record]);
  if (includes.includes('provenance')) {
    // Active assertions are unique per field after recomputation; pending IDs are fetched without a page cap.
    const rows = await tx<
      { id: string; field_id: string; status: string }[]
    >`select id, field_id, status from field_assertions where record_id = ${record.id} and status in ('active','pending_review') order by created_at,id`;
    const active = await assertions(
      tx,
      schema,
      tx`a.record_id = ${record.id} and (a.status = 'active' or a.id in (select distinct on (field_id) id from field_assertions where record_id = ${record.id} and status = 'pending_review' order by field_id,created_at,id))`,
      Math.max(rows.length, 1),
    );
    result.provenance = Object.fromEntries(
      (schema.objectsByName.get(record.object)?.activeFields ?? [])
        .filter((f) => !f.settings.isInverse)
        .map((f) => [
          f.name,
          {
            assertion:
              active.items.find((a) => a.field === f.name && a.status === 'active') ?? null,
            pendingAssertion:
              active.items.find((a) => a.field === f.name && a.status === 'pending_review') ?? null,
            pendingAssertionIds: rows
              .filter((a) => a.field_id === f.id && a.status === 'pending_review')
              .map((a) => a.id),
          },
        ]),
    );
  }
  return result;
}
