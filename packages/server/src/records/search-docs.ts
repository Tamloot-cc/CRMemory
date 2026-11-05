import { RecordId } from '../db/cbor.js';
import { fieldColumn, publicId } from '../db/names.js';
import { fromColumn } from '../db/physical.js';
import type { Operation } from '../db/protocol.js';
import { ident } from '../db/surreal.js';
import type { CompiledObject } from '../schema-engine/compiled.js';
import { searchTextOf } from './derive.js';
import type { WriteContext } from './write.js';

/**
 * The search projection (spec section 8): one `search_documents` row per
 * live record and per live fact, rebuilt from current values. It is
 * written in the same transaction as the values it indexes, and every read
 * still checks liveness and visibility, so a stale row can never surface a
 * hidden record.
 */

/** Lowercase, accents removed: what the exact-word index and phrase checks compare. */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export type SearchDocument = {
  kind: 'record' | 'fact';
  owner: string;
  object_type_id: string;
  label: string | null;
  label_text: string;
  all_text: string;
  folded: string;
  grams: string;
  updated_at: Date;
};

export function recordDocument(
  object: CompiledObject,
  recordId: string,
  data: Record<string, unknown>,
  now: Date,
): SearchDocument {
  const { label, body } = searchTextOf(object.state.fields, object.labelField, data);
  const all = [label ?? '', body].filter(Boolean).join(' ');
  return {
    kind: 'record',
    owner: recordId,
    object_type_id: object.id,
    label,
    label_text: label ?? '',
    all_text: all,
    folded: fold(all),
    grams: label ?? '',
    updated_at: now,
  };
}

export function factDocument(
  fact: { id: string; record: string; content: string },
  objectTypeId: string,
  now: Date,
): SearchDocument {
  return {
    kind: 'fact',
    owner: fact.record,
    object_type_id: objectTypeId,
    label: null,
    label_text: '',
    all_text: fact.content,
    folded: fold(fact.content),
    grams: '',
    updated_at: now,
  };
}

/** Writes a record's search document; returns its label. */
export async function writeRecordSearch(
  context: WriteContext,
  object: CompiledObject,
  recordId: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const doc = recordDocument(object, recordId, data, context.op.now);
  context.op.batch.upsert('search_documents', recordId, doc);
  return doc.label;
}

/** Removes search documents (deleted records and facts, erased content). */
export function deleteSearchDocuments(context: { op: Operation }, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const batch = context.op.batch;
  batch.write(
    `DELETE ${batch.v([...new Set(ids)].map((id) => new RecordId('search_documents', id)))} RETURN BEFORE`,
    { min: 0, max: new Set(ids).size },
    'search_documents',
  );
}

/**
 * Rewrites the label and search documents of an object's live records after
 * the label field, a searchable flag or an option label changed.
 */
export async function refreshObjectSearch(op: Operation, object: CompiledObject): Promise<void> {
  const columns = object.state.fields
    .filter((f) => f.type !== 'relation')
    .map((f) => ident(fieldColumn(f.key)));
  const rows = await op.rows<Record<string, unknown> & { id: RecordId }>(
    `SELECT id${columns.length ? `, ${columns.join(', ')}` : ''} FROM ${ident(object.table)} WHERE deleted_at = NONE AND merged_into = NONE;`,
  );
  for (const row of rows) {
    const data: Record<string, unknown> = {};
    for (const field of object.state.fields) {
      if (field.type === 'relation') continue;
      const value = row[fieldColumn(field.key)];
      if (value !== undefined) data[field.key] = fromColumn(field, value);
    }
    const id = publicId(row.id);
    const doc = recordDocument(object, id, data, op.now);
    op.batch.upsert('search_documents', id, doc);
    op.batch.update(object.table, id, { label: doc.label });
  }
}
