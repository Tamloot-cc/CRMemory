import type { ForgetResult } from '@retainer/shared';
import type { Db } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { publicId, relationTable } from '../db/names.js';
import { ident } from '../db/surreal.js';
import { requireUser } from '../errors.js';
import { liveFactSources } from '../memory/events.js';
import { type Handle, parseHandle } from '../memory/handles.js';
import { inboundRelationFields } from '../records/merge.js';
import { fold } from '../records/search-docs.js';
import {
  type AssertionRow,
  entriesOf,
  fromStored,
  lockRecordsForUpdate,
  type RemovedClaim,
  releaseAndRecompute,
  resolveRecordId,
  type StoredAssertion,
  updateAssertion,
  type WriteContext,
} from '../records/write.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';
import {
  requireSuppressionKey,
  suppress,
  suppressibleHandles,
  tombstoneEventIdentity,
} from './suppression.js';

/** How many review candidates of each kind `forget` returns. */
const CANDIDATE_LIMIT = 100;

/** Runs one indexed statement per value, in one request; results in order. */
async function perValue<T>(
  db: Db,
  values: readonly string[],
  statement: (v: string) => string,
): Promise<T[][]> {
  if (values.length === 0) return [];
  const vars: Record<string, unknown> = {};
  const statements = values.map((value, i) => {
    vars[`v${i}`] = value;
    return statement(`$v${i}`);
  });
  return (await db.query(statements.join('\n'), vars)) as T[][];
}

/**
 * `forget` (2.1): the hard delete for privacy requests. Like every write it
 * runs under the write protocol (section 6), so no other write interleaves,
 * and every later write checks the suppression list.
 *
 * Everything is gathered in the plan before anything is deleted:
 *
 * - the record and every record merged into it;
 * - its emails and phones, from current identifiers, every past email or
 *   phone claim, and the handles of events it was matched in;
 * - the events it took part in, by record or by handle, and the internal
 *   notes `remember` wrote about it (events only `about` it stay, without
 *   the link);
 * - candidates for human review: other live records, facts and events that
 *   mention its name or handles.
 *
 * Then, in this one transaction: claims on other records that cite those
 * events are deleted (facts only once no live source remains) and inbound
 * relation claims are deleted or trimmed; the affected records are
 * recomputed; the events and the records are hard-deleted with every row
 * derived from them; an erased event's identity, and that of a surviving
 * event whose initial values were erased, is replaced by a keyed tombstone;
 * receipts that mention them are erased; the handles are suppressed by
 * keyed HMAC; and an audit row records who and how many, never what. If the
 * transaction fails nothing is erased (section 6: no partial erasure).
 */
export async function forgetRecord(context: WriteContext, id: string): Promise<ForgetResult> {
  requireUser(context.actor, 'forget a record');
  requireSuppressionKey();
  const { workspaceId, schema, op } = context;
  const { db } = op;
  const root = await resolveRecordId(op, id);

  // The record and the chain of records merged into it.
  const recordIds: string[] = [root];
  for (let frontier = [root]; frontier.length > 0; ) {
    const merged = (
      await perValue<{ id: RecordId }>(
        db,
        frontier,
        (v) => `SELECT id FROM record_directory WHERE merged_into = ${v};`,
      )
    )
      .flat()
      .map((r) => publicId(r.id))
      .filter((r) => !recordIds.includes(r));
    recordIds.push(...merged);
    frontier = merged;
  }
  recordIds.sort();
  const entries = await entriesOf(op, recordIds);
  const records = await lockRecordsForUpdate(context, recordIds);

  // Handles: current identifiers, past claims, and matched participants.
  const handles = new Map<string, Handle>();
  const addHandle = (handle: Handle | null) => {
    if (handle) handles.set(`${handle.kind}:${handle.value}`, handle);
  };
  const [identifierRows, claimRows, linkRows] = await Promise.all([
    perValue<{ kind: string; value: string }>(
      db,
      recordIds,
      (v) => `SELECT kind, value FROM record_identifiers WHERE record = ${v};`,
    ),
    perValue<StoredAssertion>(
      db,
      recordIds,
      (v) => `SELECT * FROM field_assertions WHERE record = ${v};`,
    ),
    perValue<{ id: RecordId; event: string; link: string; handle?: string | null }>(
      db,
      recordIds,
      (v) => `SELECT id, event, link, handle FROM event_links WHERE record = ${v};`,
    ),
  ]);
  for (const row of identifierRows.flat()) {
    if (row.kind === 'email' || row.kind === 'phone') addHandle(row as Handle);
  }
  const ownAssertions = claimRows.flat();
  for (const claim of ownAssertions) {
    const field = schema.fieldOwners.get(claim.field_id)?.fieldsById.get(claim.field_id);
    if (field && claim.value !== null && claim.value !== undefined) {
      for (const handle of suppressibleHandles(field, claim.value)) addHandle(handle);
    }
  }
  const linksToRecord = linkRows.flat();
  for (const row of linksToRecord) if (row.handle) addHandle(parseHandle(row.handle));
  const handleValues = [...handles.values()].map((h) => h.value);

  // Events the record took part in, and the internal notes remember wrote
  // about it. An event only `about` the record (a meeting about a company)
  // is someone else's: it stays, without the link. A forgotten record that
  // is itself an event is erased as one.
  const byHandle = (
    await perValue<{ event: string; link: string }>(
      db,
      handleValues,
      (v) => `SELECT event, link FROM event_links WHERE handle = ${v};`,
    )
  )
    .flat()
    .filter((l) => l.link === 'participant');
  const candidateEvents = [
    ...new Set([...linksToRecord.map((l) => l.event), ...byHandle.map((l) => l.event)]),
  ];
  const eventEntries = await entriesOf(op, candidateEvents);
  const noteType = schema.internalNote?.id;
  const eventSet = new Set<string>();
  for (const link of linksToRecord) {
    const entry = eventEntries.get(link.event);
    if (link.link === 'participant' || (entry && entry.object_type_id === noteType)) {
      eventSet.add(link.event);
    }
  }
  for (const link of byHandle) eventSet.add(link.event);
  for (const recordId of recordIds) {
    if (schema.objectsById.get(entries.get(recordId)?.object_type_id ?? '')?.isEvent) {
      eventSet.add(recordId);
    }
  }
  const eventIds = [...eventSet].sort();
  const erased = [...new Set([...recordIds, ...eventIds])].sort();
  const erasedSet = new Set(erased);

  const reviewCandidates = await findMentions(
    db,
    schema,
    erasedSet,
    records.flatMap((r) => (r.label?.trim() ? [r.label.trim()] : [])),
    handleValues,
  );

  // Claims on other records that cite those events or point at the record.
  const object = schema.objectsById.get(entries.get(root)?.object_type_id ?? '');
  const relationFieldIds = new Set(object ? inboundRelationFields(schema, object) : []);
  const [citingRows, pointingRows] = await Promise.all([
    perValue<StoredAssertion>(
      db,
      eventIds,
      (v) => `SELECT * FROM field_assertions WHERE source = ${v};`,
    ),
    perValue<StoredAssertion>(
      db,
      recordIds,
      (v) => `SELECT * FROM field_assertions WHERE refs CONTAINS ${v};`,
    ),
  ]);
  const elsewhere = (row: AssertionRow) => !erasedSet.has(row.record);
  const cited = new Map(
    citingRows
      .flat()
      .map(fromStored)
      .filter(elsewhere)
      .map((row) => [row.id, row]),
  );
  const pointing = pointingRows
    .flat()
    .map(fromStored)
    .filter((row) => elsewhere(row) && relationFieldIds.has(row.field_id) && !cited.has(row.id));
  const inboundRemoved = pointing.filter((row) => !Array.isArray(row.value));
  const inboundTrimmed = pointing.filter((row) => Array.isArray(row.value));

  const affected = [...cited.values(), ...pointing].map((row) => row.record);
  const locked = await lockRecordsForUpdate(context, affected);

  // Surviving events whose initial values are erased lose their raw
  // identity (6.4): the caller-chosen channel and external ID may identify.
  const initialErased = [
    ...new Set(pointing.filter((row) => row.is_initial).map((row) => row.record)),
  ];
  const identityRows = await db.rows<{
    id: RecordId;
    channel?: string | null;
    external_id?: string | null;
  }>('SELECT id, channel, external_id FROM $ids;', {
    ids: [...eventIds, ...initialErased].map((e) => new RecordId('event_identity', e)),
  });
  const identities = identityRows.flatMap((row) =>
    row.channel && row.external_id ? [{ channel: row.channel, externalId: row.external_id }] : [],
  );

  // Removed claims leave the plan's view first, so recomputation never
  // brings one back; the rows themselves are deleted below.
  const removed: RemovedClaim[] = [];
  for (const row of [...cited.values(), ...inboundRemoved]) {
    updateAssertion(context, row, { status: 'retracted' });
    removed.push({ record_id: row.record, field_id: row.field_id, status: row.status });
  }
  // A set (many_to_many) that holds the record, in any assertion, current
  // or historical: the record is removed from it, so no recomputation can
  // bring it back (5.3).
  const trimmedRecords = new Set(recordIds);
  for (const row of inboundTrimmed) {
    const value = (row.value as string[]).filter((v) => !trimmedRecords.has(v)).sort();
    updateAssertion(context, row, { value });
    removed.push({ record_id: row.record, field_id: row.field_id, status: row.status });
  }
  const recomputed = await releaseAndRecompute(
    context,
    locked.filter((r) => !erasedSet.has(r.id)),
    removed,
  );

  // Facts: those of erased records go; facts elsewhere lose the deleted
  // sources, and go once no live source remains.
  const [ownFactRows, sourceRows] = await Promise.all([
    perValue<{ id: RecordId }>(db, erased, (v) => `SELECT id FROM facts WHERE record = ${v};`),
    perValue<{ id: RecordId; fact: string }>(
      db,
      eventIds,
      (v) => `SELECT id, fact FROM fact_sources WHERE source = ${v};`,
    ),
  ]);
  const ownFacts = ownFactRows.flat().map((f) => publicId(f.id));
  const ownFactSet = new Set(ownFacts);
  const unsourced = [...new Set(sourceRows.flat().map((s) => s.fact))].filter(
    (f) => !ownFactSet.has(f),
  );
  const remaining = await liveFactSources(db, unsourced);
  const orphanCandidates = unsourced.filter(
    (f) => !(remaining.get(f) ?? []).some((s) => !erasedSet.has(s.source)),
  );
  const orphanFacts = (
    await db.rows<{ id: RecordId; deleted_at?: Date | null }>('SELECT id, deleted_at FROM $ids;', {
      ids: orphanCandidates.map((f) => new RecordId('facts', f)),
    })
  ).map((f) => publicId(f.id));
  const erasedFacts = [...ownFacts, ...orphanFacts];

  await tombstoneEventIdentity(op, workspaceId, identities);
  for (const eventId of initialErased.filter((e) => !erasedSet.has(e))) {
    op.batch.update('event_identity', eventId, { channel: undefined, external_id: undefined });
  }

  // Hard deletion. These statements run last, after every plan step above,
  // and delete by indexed condition so nothing derived from an erased row
  // is left, whichever step wrote it.
  const batch = op.batch;
  const sweep = (statement: string, label: string) =>
    batch.write(`${statement} RETURN BEFORE`, { min: 0 }, label);
  const claimIds = [...cited.keys(), ...inboundRemoved.map((r) => r.id)];
  if (claimIds.length > 0) batch.deleteIds('field_assertions', claimIds);
  for (const factId of erasedFacts) {
    const fact = batch.v(factId);
    sweep(`DELETE fact_sources WHERE fact = ${fact}`, 'fact_sources');
    sweep(`DELETE ${batch.v(new RecordId('search_documents', factId))}`, 'search_documents');
  }
  if (erasedFacts.length > 0) batch.deleteIds('facts', erasedFacts);
  for (const eventId of eventIds) {
    sweep(`DELETE fact_sources WHERE source = ${batch.v(eventId)}`, 'fact_sources');
    sweep(`DELETE field_assertions WHERE source = ${batch.v(eventId)}`, 'field_assertions');
  }
  for (const recordId of erased) {
    const entry = (await entriesOf(op, [recordId])).get(recordId);
    const owner = entry ? schema.objectsById.get(entry.object_type_id) : undefined;
    const v = batch.v(recordId);
    sweep(`DELETE field_assertions WHERE record = ${v}`, 'field_assertions');
    sweep(`DELETE record_identifiers WHERE record = ${v}`, 'record_identifiers');
    sweep(`DELETE unique_claims WHERE record = ${v}`, 'unique_claims');
    sweep(`DELETE search_documents WHERE owner = ${v}`, 'search_documents');
    sweep(`DELETE event_links WHERE record = ${v}`, 'event_links');
    sweep(`DELETE event_links WHERE event = ${v}`, 'event_links');
    sweep(`DELETE event_attachments WHERE event = ${v}`, 'event_attachments');
    sweep(`DELETE event_attachments WHERE target = ${v}`, 'event_attachments');
    sweep(`DELETE rollup_attachments WHERE event = ${v}`, 'rollup_attachments');
    sweep(`DELETE rollup_attachments WHERE target = ${v}`, 'rollup_attachments');
    sweep(`DELETE rollup_attachments WHERE source = ${v}`, 'rollup_attachments');
    sweep(`DELETE merge_suggestions WHERE record_a = ${v}`, 'merge_suggestions');
    sweep(`DELETE merge_suggestions WHERE record_b = ${v}`, 'merge_suggestions');
    if (owner) {
      const node = batch.v(new RecordId(owner.table, recordId));
      for (const field of owner.state.fields) {
        if (field.type === 'relation' && !field.settings.isInverse) {
          sweep(`DELETE ${ident(relationTable(field.universalId))} WHERE in = ${node}`, 'edges');
        }
      }
      for (const fieldId of inboundRelationFields(schema, owner)) {
        const field = schema.fieldOwners.get(fieldId)?.fieldsById.get(fieldId);
        if (field) {
          sweep(`DELETE ${ident(relationTable(field.universalId))} WHERE out = ${node}`, 'edges');
        }
      }
      batch.delete(owner.table, recordId);
    }
    if (owner?.isEvent) batch.delete('event_identity', recordId);
    batch.delete('record_directory', recordId);
  }

  // Receipts mentioning any erased row keep their status, not their result.
  for (const ref of [...erased, ...erasedFacts]) {
    batch.write(
      `UPDATE operations SET status = 'erased', result = NONE WHERE refs CONTAINS ${batch.v(ref)} RETURN id`,
      { min: 0 },
      'operations',
    );
  }

  const suppressedHandles = await suppress(op, workspaceId, [...handles.values()]);
  const ownAssertionCount = (
    await perValue<{ count: number }>(
      db,
      eventIds.filter((e) => !recordIds.includes(e)),
      (v) => `SELECT count() FROM field_assertions WHERE record = ${v} GROUP ALL;`,
    )
  ).reduce((sum, rows) => sum + (rows[0]?.count ?? 0), ownAssertions.length);
  const counts: ForgetResult['counts'] = {
    records: recordIds.length,
    events: eventIds.filter((e) => !recordIds.includes(e)).length,
    facts: erasedFacts.length,
    assertions: ownAssertionCount + cited.size,
    inboundRelations: inboundRemoved.length + inboundTrimmed.length,
    suppressedHandles,
  };
  batch.create('deletion_audit_log', op.newId(), {
    actor_type: context.actor.type,
    actor_id: context.actor.id,
    counts,
    created_at: op.now,
  });

  const orphanSet = new Set(orphanFacts);
  return {
    id: root,
    forgotten: true,
    counts,
    recomputedRecordIds: recomputed,
    // Candidates already exclude the erased records and events; only
    // facts orphaned by the deletion can have gone since.
    reviewCandidates: {
      ...reviewCandidates,
      facts: reviewCandidates.facts.filter((f) => !orphanSet.has(f)),
    },
  };
}

type SearchHit = { id: RecordId; kind: 'record' | 'fact'; owner: string; object_type_id: string };

/**
 * Live rows outside the deletion that may mention the person: by the name
 * (a phrase in the search text) or by a handle in the text, and other
 * records sharing a handle. A best-effort list for a person to check.
 */
async function findMentions(
  db: Db,
  schema: CompiledSchema,
  erased: ReadonlySet<string>,
  names: readonly string[],
  handles: readonly string[],
): Promise<ForgetResult['reviewCandidates']> {
  const phrases = [...new Set([...names, ...handles].map(fold).filter((p) => p.length > 0))];
  const hits = (
    await perValue<SearchHit>(
      db,
      phrases,
      (v) =>
        `SELECT id, kind, owner, object_type_id FROM search_documents WHERE folded @1@ ${v} AND string::contains(folded, ${v}) LIMIT ${CANDIDATE_LIMIT * 4};`,
    )
  ).flat();
  const sharing = (
    await perValue<{ record: string }>(
      db,
      handles,
      (v) => `SELECT record FROM record_identifiers WHERE value = ${v};`,
    )
  ).flat();
  const entityTypes = new Set(schema.entityTypeIds);
  const eventTypes = new Set(schema.eventTypeIds);
  const recordIds = new Set<string>(sharing.map((s) => s.record));
  const eventIds = new Set<string>();
  const factIds = new Set<string>();
  for (const hit of hits) {
    if (hit.kind === 'fact') factIds.add(publicId(hit.id));
    else if (eventTypes.has(hit.object_type_id)) eventIds.add(hit.owner);
    else if (entityTypes.has(hit.object_type_id)) recordIds.add(hit.owner);
  }
  const live = async (ids: Set<string>, types: Set<string>) => {
    const candidates = [...ids].filter((id) => !erased.has(id));
    const rows = await db.rows<{ id: RecordId; object_type_id: string; deleted_at?: Date | null }>(
      'SELECT id, object_type_id, deleted_at FROM $ids;',
      { ids: candidates.map((id) => new RecordId('record_directory', id)) },
    );
    return rows
      .filter((r) => !r.deleted_at && types.has(r.object_type_id))
      .map((r) => publicId(r.id))
      .sort()
      .slice(0, CANDIDATE_LIMIT);
  };
  const facts = await db.rows<{ id: RecordId; record: string; deleted_at?: Date | null }>(
    'SELECT id, record, deleted_at FROM $ids;',
    { ids: [...factIds].map((id) => new RecordId('facts', id)) },
  );
  return {
    records: await live(recordIds, entityTypes),
    facts: facts
      .filter((f) => !f.deleted_at && !erased.has(f.record))
      .map((f) => publicId(f.id))
      .sort()
      .slice(0, CANDIDATE_LIMIT),
    events: await live(eventIds, eventTypes),
  };
}
