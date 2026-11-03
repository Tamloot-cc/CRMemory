import type { ForgetResult } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { requireUser } from '../errors.js';
import { type Handle, parseHandle } from '../memory/handles.js';
import { NOTE_CHANNEL } from '../memory/interactions.js';
import { inboundRelationFields } from '../records/merge.js';
import {
  lockRecordsForUpdate,
  type RemovedClaim,
  releaseAndRecompute,
  resolveRecordId,
  type WriteContext,
} from '../records/write.js';
import { requireSuppressionKey, suppress, suppressibleHandles } from './suppression.js';

/** How many review candidates of each kind `forget` returns. */
const CANDIDATE_LIMIT = 100;

/**
 * `forget` (2.1): the hard delete for privacy requests. The caller holds
 * the privacy lock exclusively, so no other write runs in the workspace
 * until this commits, and every later write checks the suppression list.
 *
 * Everything is collected first, before cascades or `SET NULL` can erase
 * the dependencies:
 *
 * - the record and every record merged into it;
 * - its emails and phones, from current identifiers, every past email or
 *   phone claim, and the handles of interactions it was matched in;
 * - the interactions it took part in, by record or by handle, and the
 *   notes `remember` wrote about it (interactions only `about` it stay,
 *   without the link);
 * - candidates for human review: other live records, facts and
 *   interactions that mention its name or handles.
 *
 * Then, in this one transaction: claims on other records that cite those
 * interactions are deleted (facts only once no live source remains) and
 * inbound relation claims are deleted; the affected records are recomputed;
 * the interactions and the records are hard-deleted, with their assertions,
 * facts, links and identifiers; stored idempotent responses that mention
 * them are deleted; the handles are suppressed by keyed HMAC; and an audit
 * row records who and how many, never what.
 */
export async function forgetRecord(
  tx: Tx,
  context: WriteContext,
  id: string,
): Promise<ForgetResult> {
  requireUser(context.actor, 'forget a record');
  requireSuppressionKey();
  const { workspaceId, schema } = context;
  const root = await resolveRecordId(tx, workspaceId, id);

  const chain = await tx<{ id: string; label: string | null; object_type_id: string }[]>`
    with recursive chain (id) as (
      select ${root}::uuid
      union
      select r.id from records r join chain c on r.merged_into_id = c.id
      where r.workspace_id = ${workspaceId}
    )
    select r.id, r.label, r.object_type_id from records r join chain c on c.id = r.id
    order by r.id`;
  const recordIds = chain.map((r) => r.id);

  // Handles: current identifiers, past claims, and matched participants.
  const handles = new Map<string, Handle>();
  const addHandle = (handle: Handle | null) => {
    if (handle) handles.set(`${handle.kind}:${handle.value}`, handle);
  };
  const identifiers = await tx<{ kind: 'email' | 'phone'; value: string }[]>`
    select distinct kind, value from record_identifiers
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])
      and kind in ('email', 'phone')`;
  for (const row of identifiers) addHandle(row);
  const claims = await tx<{ field_id: string; value: unknown }[]>`
    select field_id, value from field_assertions
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])
      and value is not null`;
  for (const claim of claims) {
    const field = schema.fieldOwners.get(claim.field_id)?.fieldsById.get(claim.field_id);
    if (field) for (const handle of suppressibleHandles(field, claim.value)) addHandle(handle);
  }
  const matched = await tx<{ handle: string }[]>`
    select distinct handle from interaction_participants
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])
      and handle is not null`;
  for (const row of matched) addHandle(parseHandle(row.handle));
  const handleValues = [...handles.values()].map((h) => h.value);

  // Interactions the record took part in, and the notes remember wrote about
  // it. An interaction that is only `about` the record (a meeting about a
  // company) is someone else's conversation: it stays, without the link.
  const interactions = await tx<{ id: string }[]>`
    select distinct p.interaction_id as id from interaction_participants p
    join interactions i on i.id = p.interaction_id
    where p.workspace_id = ${workspaceId}
      and ((p.link = 'participant'
          and (p.record_id = any(${recordIds}::uuid[]) or p.handle = any(${handleValues}::text[])))
        or (p.link = 'about' and p.record_id = any(${recordIds}::uuid[])
          and i.kind = 'note' and i.channel = ${NOTE_CHANNEL}))
    order by 1`;
  const interactionIds = interactions.map((r) => r.id);

  const reviewCandidates = await findMentions(
    tx,
    workspaceId,
    recordIds,
    interactionIds,
    chain.flatMap((r) => (r.label?.trim() ? [r.label.trim()] : [])),
    handleValues,
  );

  // Claims on other records that cite those interactions or point at the record.
  const object = schema.objectsById.get(chain[0]?.object_type_id ?? '');
  const relationFieldIds = object ? inboundRelationFields(schema, object) : [];
  const pointsAtRecord = tx`field_id = any(${relationFieldIds}::uuid[])
    and value = any(array(select to_jsonb(x::text) from unnest(${recordIds}::uuid[]) x))`;
  const elsewhere = tx`workspace_id = ${workspaceId} and record_id <> all(${recordIds}::uuid[])`;
  const affected = await tx<{ record_id: string }[]>`
    select distinct record_id from field_assertions
    where ${elsewhere}
      and (source_interaction_id = any(${interactionIds}::uuid[]) or (${pointsAtRecord}))`;
  const locked = await lockRecordsForUpdate(tx, workspaceId, [
    ...new Set([...recordIds, ...affected.map((r) => r.record_id)]),
  ]);
  if (interactionIds.length > 0) {
    await tx`select id from interactions where id = any(${interactionIds}::uuid[])
      order by id for update`;
  }

  const [counted] = await tx<{ assertions: number }[]>`
    select count(*)::int as assertions from field_assertions
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])`;
  const ownFacts = await tx<{ id: string }[]>`
    select id from facts where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])`;

  const cited = await tx<RemovedClaim[]>`
    delete from field_assertions
    where ${elsewhere} and source_interaction_id = any(${interactionIds}::uuid[])
    returning record_id, field_id, status`;
  const inboundRelations = await tx<RemovedClaim[]>`
    delete from field_assertions where ${elsewhere} and ${pointsAtRecord}
    returning record_id, field_id, status`;
  const recomputed = await releaseAndRecompute(
    tx,
    context,
    locked.filter((r) => !recordIds.includes(r.id)),
    [...cited, ...inboundRelations],
  );

  // Facts on other records: drop the deleted sources, then any fact left
  // without a live source.
  const unsourced = await tx<{ fact_id: string }[]>`
    delete from fact_sources
    where workspace_id = ${workspaceId} and interaction_id = any(${interactionIds}::uuid[])
    returning fact_id`;
  const orphaned = await tx<{ id: string }[]>`
    delete from facts f
    where f.workspace_id = ${workspaceId}
      and f.id = any(${[...new Set(unsourced.map((s) => s.fact_id))]}::uuid[])
      and f.record_id <> all(${recordIds}::uuid[])
      and not exists (
        select 1 from fact_sources s
        join interactions i on i.id = s.interaction_id and i.deleted_at is null
        where s.fact_id = f.id)
    returning f.id`;

  await tx`delete from interactions where id = any(${interactionIds}::uuid[])`;
  await tx`
    delete from interaction_participants
    where workspace_id = ${workspaceId} and link = 'about'
      and record_id = any(${recordIds}::uuid[])`;
  await tx`delete from records where id = any(${recordIds}::uuid[])`;

  // Stored responses mentioning any erased row are erased too.
  const orphanedIds = new Set(orphaned.map((f) => f.id));
  const erasedIds = [...recordIds, ...interactionIds, ...orphanedIds, ...ownFacts.map((f) => f.id)];
  await tx`
    delete from idempotency_keys k
    where k.workspace_id = ${workspaceId} and k.result is not null
      and exists (select 1 from unnest(${erasedIds}::text[]) x
        where strpos(k.result::text, x) > 0)`;

  const suppressedHandles = await suppress(tx, workspaceId, [...handles.values()]);
  const counts: ForgetResult['counts'] = {
    records: recordIds.length,
    interactions: interactionIds.length,
    facts: ownFacts.length + orphaned.length,
    assertions: (counted?.assertions ?? 0) + cited.length,
    inboundRelations: inboundRelations.length,
    suppressedHandles,
  };
  await tx`
    insert into deletion_audit_log (workspace_id, actor_type, actor_id, counts)
    values (${workspaceId}, ${context.actor.type}, ${context.actor.id}, ${tx.json(counts)})`;

  return {
    id: root,
    forgotten: true,
    counts,
    recomputedRecordIds: recomputed,
    // Candidates already exclude the erased records and interactions; only
    // facts orphaned by the deletion can have gone since.
    reviewCandidates: {
      ...reviewCandidates,
      facts: reviewCandidates.facts.filter((f) => !orphanedIds.has(f)),
    },
  };
}

/**
 * Live rows outside the deletion that may mention the person: by the name
 * (a phrase match on the search vectors) or by a handle in the text, and
 * other records sharing a handle. A best-effort list for a person to check.
 */
async function findMentions(
  tx: Tx,
  workspaceId: string,
  recordIds: readonly string[],
  interactionIds: readonly string[],
  names: readonly string[],
  handles: readonly string[],
): Promise<ForgetResult['reviewCandidates']> {
  const patterns = handles.map((h) => `%${h.replace(/[\\%_]/g, '\\$&')}%`);
  const nameQuery =
    names.length === 0
      ? tx`false`
      : tx`exists (select 1 from unnest(${names as string[]}::text[]) n
          where search @@ phraseto_tsquery('simple', n))`;
  const records = await tx<{ id: string }[]>`
    select id from records
    where workspace_id = ${workspaceId} and deleted_at is null
      and id <> all(${recordIds as string[]}::uuid[])
      and (${nameQuery}
        or id in (select record_id from record_identifiers
          where workspace_id = ${workspaceId} and value = any(${handles as string[]}::text[])))
    order by id limit ${CANDIDATE_LIMIT}`;
  const facts = await tx<{ id: string }[]>`
    select id from facts
    where workspace_id = ${workspaceId} and deleted_at is null
      and record_id <> all(${recordIds as string[]}::uuid[])
      and (${nameQuery} or content ilike any(${patterns}::text[]))
    order by id limit ${CANDIDATE_LIMIT}`;
  const interactions = await tx<{ id: string }[]>`
    select id from interactions
    where workspace_id = ${workspaceId} and deleted_at is null
      and id <> all(${interactionIds as string[]}::uuid[])
      and (${nameQuery} or title ilike any(${patterns}::text[])
        or summary ilike any(${patterns}::text[]))
    order by id limit ${CANDIDATE_LIMIT}`;
  return {
    records: records.map((r) => r.id),
    facts: facts.map((r) => r.id),
    interactions: interactions.map((r) => r.id),
  };
}
