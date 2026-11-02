import type { Actor, PresentedInteraction } from '@retainer/shared';
import { z } from 'zod';
import { INTERACTION_KINDS, type InteractionKind, type UnmatchedReason } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { searchVector } from '../records/search-sql.js';
import { type LockedRecord, recomputeFields, type WriteContext } from '../records/write.js';
import { type Handle, parseHandle } from './handles.js';

/**
 * The interaction log (1.3, 4.1): what happened, written by the agent, and
 * who took part. Participants are matched synchronously against unique
 * identifiers; Retainer never creates records for the ones it cannot match.
 */

export const MAX_PARTICIPANTS = 200;
/** How far past the server's clock `occurredAt` may be, for clock skew. */
const FUTURE_SKEW = '10 minutes';
/** Merge chains are short; this only stops a corrupt cycle. */
const MAX_MERGE_HOPS = 16;

export const participantInputSchema = z.strictObject({
  handle: z.string().trim().min(1).max(320).optional(),
  recordId: z.uuid().optional(),
  role: z.string().trim().min(1).max(100).optional(),
});

/**
 * The channel of the `note` interactions `remember` creates for uncited
 * facts. It is reserved, so retrieval can tell those notes apart from any
 * interaction an agent logs.
 */
export const NOTE_CHANNEL = 'retainer';

export const logInteractionInputSchema = z.strictObject({
  kind: z.enum(INTERACTION_KINDS),
  channel: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((channel) => channel !== NOTE_CHANNEL, {
      message: `channel "${NOTE_CHANNEL}" is reserved for the notes remember creates`,
    }),
  externalId: z.string().min(1).max(500).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  title: z.string().max(500).optional(),
  summary: z.string().max(20_000).optional(),
  participants: z.array(participantInputSchema).max(MAX_PARTICIPANTS).default([]),
});
export type LogInteractionInput = z.infer<typeof logInteractionInputSchema>;

export type MatchedParticipant = { handle: string | null; role: string | null; recordId: string };
export type UnmatchedParticipant = {
  handle: string | null;
  role: string | null;
  reason: UnmatchedReason;
  /** For `ambiguous`: the live records that claim the handle (1.2). */
  candidates?: string[];
};
export type Participants = { matched: MatchedParticipant[]; unmatched: UnmatchedParticipant[] };

/** What `log_interaction` returns (6.2). */
export type LogInteractionResult = { id: string; created: boolean; participants: Participants };

export type { PresentedInteraction } from '@retainer/shared';

type NormalizedParticipant = {
  handle: Handle | null;
  recordId: string | null;
  role: string | null;
};

type ParticipantRow = {
  handle: string | null;
  role: string | null;
  record_id: string | null;
  unmatched_reason: UnmatchedReason | null;
};

/** Parses every handle, listing all invalid participants in one error. */
function normalizeParticipants(
  input: LogInteractionInput['participants'],
): NormalizedParticipant[] {
  const errors: { index: number; handle?: string; message: string }[] = [];
  const participants = input.map((p, index) => {
    if (p.handle === undefined && p.recordId === undefined) {
      errors.push({ index, message: 'give a handle (email or phone), a recordId, or both' });
    }
    let handle: Handle | null = null;
    if (p.handle !== undefined) {
      handle = parseHandle(p.handle);
      if (!handle) {
        errors.push({ index, handle: p.handle, message: 'not an email address or phone number' });
      }
    }
    return { handle, recordId: p.recordId ?? null, role: p.role ?? null };
  });
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_participants', 'some participants are invalid', { errors });
  }
  return participants;
}

type CanonicalRecord = { id: string; deleted: boolean };

/**
 * Follows `merged_into_id` from each ID to the surviving record (4.2) and
 * reports whether it is deleted. Unknown IDs are absent from the map.
 */
async function canonicalRecords(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
): Promise<Map<string, CanonicalRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<{ start_id: string; id: string; deleted_at: Date | null }[]>`
    with recursive chain (start_id, id, merged_into_id, deleted_at, hops) as (
      select r.id, r.id, r.merged_into_id, r.deleted_at, 0 from records r
      where r.workspace_id = ${workspaceId} and r.id = any(${ids as string[]}::uuid[])
      union all
      select c.start_id, r.id, r.merged_into_id, r.deleted_at, c.hops + 1 from chain c
      join records r on r.id = c.merged_into_id and r.workspace_id = ${workspaceId}
      where c.hops < ${MAX_MERGE_HOPS}
    )
    select start_id, id, deleted_at from chain where merged_into_id is null`;
  return new Map(rows.map((r) => [r.start_id, { id: r.id, deleted: r.deleted_at !== null }]));
}

type EmailMatch = { live: string[]; deleted: string[] };

/**
 * The records whose unique identifiers claim each email (1.2), resolved
 * through merges and split into live and deleted. Only claims count: a
 * non-unique email never selects a record.
 */
async function matchEmails(
  tx: Tx,
  workspaceId: string,
  emails: readonly string[],
): Promise<Map<string, EmailMatch>> {
  const matches = new Map<string, EmailMatch>();
  if (emails.length === 0) return matches;
  const claims = await tx<{ value: string; record_id: string }[]>`
    select value, record_id from record_identifiers
    where workspace_id = ${workspaceId} and kind = 'email' and is_claim
      and value = any(${emails as string[]}::text[])`;
  const canonical = await canonicalRecords(
    tx,
    workspaceId,
    claims.map((c) => c.record_id),
  );
  for (const claim of claims) {
    const record = canonical.get(claim.record_id);
    if (!record) continue;
    const match = matches.get(claim.value) ?? { live: [], deleted: [] };
    const list = record.deleted ? match.deleted : match.live;
    if (!list.includes(record.id)) list.push(record.id);
    matches.set(claim.value, match);
  }
  for (const match of matches.values()) {
    match.live.sort();
    match.deleted.sort();
  }
  return matches;
}

type Resolution = { recordId: string } | { reason: UnmatchedReason; candidates?: string[] };

/**
 * Resolves participants (4.1). A record ID the agent passes is used as
 * given, after following merges; an unknown or deleted one is an error,
 * since the agent named it explicitly. A handle alone resolves only through
 * a unique email claim: phones never resolve on their own, a handle claimed
 * only by deleted records stays unresolved for review (1.2), and one claimed
 * by several live records is ambiguous rather than matched to the first.
 */
async function resolveParticipants(
  tx: Tx,
  workspaceId: string,
  participants: readonly NormalizedParticipant[],
): Promise<Resolution[]> {
  const explicit = [...new Set(participants.flatMap((p) => (p.recordId ? [p.recordId] : [])))];
  const emails = [
    ...new Set(
      participants.flatMap((p) =>
        !p.recordId && p.handle?.kind === 'email' ? [p.handle.value] : [],
      ),
    ),
  ];
  const [records, emailMatches] = await Promise.all([
    canonicalRecords(tx, workspaceId, explicit),
    matchEmails(tx, workspaceId, emails),
  ]);

  const errors: { index: number; recordId: string; message: string }[] = [];
  const resolutions = participants.map((p, index): Resolution => {
    if (p.recordId) {
      const record = records.get(p.recordId);
      if (!record) {
        errors.push({ index, recordId: p.recordId, message: 'no record with this ID' });
      } else if (record.deleted) {
        errors.push({ index, recordId: record.id, message: 'the record is deleted' });
      }
      return { recordId: record?.id ?? p.recordId };
    }
    if (p.handle?.kind !== 'email') return { reason: 'phone_only' };
    const match = emailMatches.get(p.handle.value);
    if (!match) return { reason: 'no_match' };
    const [only, ...others] = match.live;
    if (only && others.length === 0) return { recordId: only };
    if (only) return { reason: 'ambiguous', candidates: match.live };
    return { reason: 'deleted_record' };
  });
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_participants', 'some participant records cannot be used', {
      errors,
    });
  }
  return resolutions;
}

/** Splits stored participants into matched and unmatched, in logged order (6.2). */
async function presentParticipants(
  tx: Tx,
  workspaceId: string,
  rows: readonly ParticipantRow[],
  knownCandidates?: Map<string, EmailMatch>,
): Promise<Participants> {
  const ambiguous = rows.flatMap((r) =>
    r.unmatched_reason === 'ambiguous' && r.handle ? [r.handle] : [],
  );
  const candidates = knownCandidates ?? (await matchEmails(tx, workspaceId, ambiguous));
  const participants: Participants = { matched: [], unmatched: [] };
  for (const row of rows) {
    if (row.record_id) {
      participants.matched.push({ handle: row.handle, role: row.role, recordId: row.record_id });
      continue;
    }
    const reason = row.unmatched_reason ?? 'no_match';
    participants.unmatched.push({
      handle: row.handle,
      role: row.role,
      reason,
      ...(reason === 'ambiguous'
        ? { candidates: candidates.get(row.handle ?? '')?.live ?? [] }
        : {}),
    });
  }
  return participants;
}

async function loadParticipants(
  tx: Tx,
  workspaceId: string,
  interactionId: string,
): Promise<Participants> {
  const rows = await tx<ParticipantRow[]>`
    select handle, role, record_id, unmatched_reason from interaction_participants
    where workspace_id = ${workspaceId} and interaction_id = ${interactionId}
    order by position`;
  return presentParticipants(tx, workspaceId, rows);
}

/**
 * Logs an interaction (4.1). The same `(channel, externalId)` with the same
 * normalized input returns the existing interaction with `created: false`;
 * different input is a conflict (1.3). A concurrent duplicate waits on the
 * unique index until the first commits, then takes the same path.
 */
export async function logInteraction(
  tx: Tx,
  context: WriteContext,
  input: LogInteractionInput,
): Promise<LogInteractionResult> {
  const participants = normalizeParticipants(input.participants);
  const occurredAt = new Date(input.occurredAt);
  const [check] = await tx<{ future: boolean }[]>`
    select ${occurredAt}::timestamptz > clock_timestamp() + ${FUTURE_SKEW}::interval as future`;
  if (check?.future) {
    throw new AppError(
      422,
      'invalid_occurred_at',
      'occurredAt is in the future; log interactions that already happened, with their UTC offset',
      { occurredAt: input.occurredAt },
    );
  }

  const hash = requestHash({
    kind: input.kind,
    channel: input.channel,
    externalId: input.externalId ?? null,
    occurredAt: occurredAt.toISOString(),
    title: input.title ?? null,
    summary: input.summary ?? null,
    participants: participants.map((p) => ({
      handle: p.handle?.value ?? null,
      recordId: p.recordId,
      role: p.role,
    })),
  });

  const [inserted] = await tx<{ id: string }[]>`
    insert into interactions (workspace_id, kind, channel, external_id, occurred_at, title,
      summary, request_hash, search, created_by)
    values (${context.workspaceId}, ${input.kind}, ${input.channel}, ${input.externalId ?? null},
      ${occurredAt}, ${input.title ?? null}, ${input.summary ?? null}, ${hash},
      ${searchVector(tx, input.title ?? null, input.summary ?? '')}, ${tx.json(context.actor)})
    on conflict (workspace_id, channel, external_id) where external_id is not null do nothing
    returning id`;

  if (!inserted) return existingInteraction(tx, context.workspaceId, input, hash);

  const resolutions = await resolveParticipants(tx, context.workspaceId, participants);
  const rows = participants.map((p, position) => {
    const resolution = resolutions[position] as Resolution;
    return {
      workspace_id: context.workspaceId,
      interaction_id: inserted.id,
      position,
      handle: p.handle?.value ?? null,
      role: p.role,
      record_id: 'recordId' in resolution ? resolution.recordId : null,
      unmatched_reason: 'reason' in resolution ? resolution.reason : null,
    };
  });
  if (rows.length > 0) await tx`insert into interaction_participants ${tx(rows)}`;
  return {
    id: inserted.id,
    created: true,
    participants: await presentParticipants(tx, context.workspaceId, rows),
  };
}

async function existingInteraction(
  tx: Tx,
  workspaceId: string,
  input: LogInteractionInput,
  hash: string,
): Promise<LogInteractionResult> {
  const [existing] = await tx<{ id: string; request_hash: string; deleted_at: Date | null }[]>`
    select id, request_hash, deleted_at from interactions
    where workspace_id = ${workspaceId} and channel = ${input.channel}
      and external_id = ${input.externalId ?? null}`;
  if (!existing) throw new AppError(500, 'internal', 'the conflicting interaction vanished');
  if (existing.deleted_at) {
    throw new AppError(
      409,
      'interaction_retracted',
      `interaction ${existing.id} with this channel and externalId was retracted; ` +
        'log an edited source with a new externalId',
      { id: existing.id },
    );
  }
  if (existing.request_hash !== hash) {
    throw new AppError(
      409,
      'interaction_conflict',
      `interaction ${existing.id} was already logged with this channel and externalId and ` +
        'different input. An edited source needs a new externalId; retract the old one with ' +
        `DELETE /v1/interactions/${existing.id} if it is wrong`,
      { id: existing.id },
    );
  }
  return {
    id: existing.id,
    created: false,
    participants: await loadParticipants(tx, workspaceId, existing.id),
  };
}

export type InteractionRow = {
  id: string;
  kind: InteractionKind;
  channel: string;
  external_id: string | null;
  occurred_at: Date;
  title: string | null;
  summary: string | null;
  created_by: Actor;
  created_at: Date;
  deleted_at: Date | null;
};

/** One live interaction with its participants. */
export async function getInteraction(
  tx: Tx,
  workspaceId: string,
  id: string,
): Promise<PresentedInteraction> {
  const [row] = await tx<InteractionRow[]>`
    select id, kind, channel, external_id, occurred_at, title, summary, created_by, created_at,
      deleted_at
    from interactions where id = ${id} and workspace_id = ${workspaceId}`;
  if (!row) throw notFound('interaction', { id });
  if (row.deleted_at) {
    throw new AppError(404, 'interaction_deleted', `interaction ${id} was retracted`, { id });
  }
  return presentInteraction(row, await loadParticipants(tx, workspaceId, row.id));
}
function presentInteraction(row: InteractionRow, participants: Participants): PresentedInteraction {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    externalId: row.external_id,
    occurredAt: row.occurred_at.toISOString(),
    title: row.title,
    summary: row.summary,
    participants,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
/** Hydrates a page with one participant read and one shared candidate lookup. */
export async function presentInteractions(
  tx: Tx,
  workspaceId: string,
  rows: readonly InteractionRow[],
): Promise<PresentedInteraction[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const participants = await tx<
    (ParticipantRow & { interaction_id: string })[]
  >`select interaction_id,handle,role,record_id,unmatched_reason from interaction_participants where workspace_id = ${workspaceId} and interaction_id = any(${ids}::uuid[]) order by interaction_id,position`;
  const candidates = await matchEmails(
    tx,
    workspaceId,
    participants.flatMap((p) => (p.unmatched_reason === 'ambiguous' && p.handle ? [p.handle] : [])),
  );
  const grouped = new Map<string, ParticipantRow[]>(ids.map((id) => [id, []]));
  for (const p of participants) grouped.get(p.interaction_id)?.push(p);
  return Promise.all(
    rows.map(async (row) =>
      presentInteraction(
        row,
        await presentParticipants(tx, workspaceId, grouped.get(row.id) ?? [], candidates),
      ),
    ),
  );
}

/** A live interaction cited as a source, and when it happened (rules 2.1, 2.2). */
export type CitedSource = { id: string; occurredAt: Date };

/**
 * Locks a cited interaction in share mode for the rest of the transaction.
 * Retraction locks it exclusively, so a write citing it either commits
 * before the retraction (which then retracts its claims) or sees it
 * retracted. Take this before any record lock: retraction locks the
 * interaction first, then records.
 */
export async function lockSource(
  tx: Tx,
  workspaceId: string,
  interactionId: string,
): Promise<CitedSource> {
  const [row] = await tx<{ id: string; occurred_at: Date; deleted_at: Date | null }[]>`
    select id, occurred_at, deleted_at from interactions
    where id = ${interactionId} and workspace_id = ${workspaceId}
    for share`;
  if (!row) {
    throw new AppError(
      422,
      'invalid_source',
      `source ${interactionId} is not an interaction in this workspace; log it with ` +
        'log_interaction first and pass the id it returns',
      { source: interactionId },
    );
  }
  if (row.deleted_at) {
    throw new AppError(409, 'source_retracted', `source interaction ${row.id} was retracted`, {
      source: row.id,
    });
  }
  return { id: row.id, occurredAt: row.occurred_at };
}

export type RetractInteractionResult = {
  id: string;
  deleted: true;
  /** Field assertions that cited the interaction and no longer count. */
  retractedAssertions: number;
  /** Records whose field values were recomputed (rule 2.4). */
  recomputedRecordIds: string[];
  /** Facts hidden because the interaction was their last live source (2.1). */
  hiddenFactIds: string[];
};

/**
 * Retracts an interaction (2.1): a soft delete that also makes every field
 * assertion citing it `retracted` and recomputes the fields where one of
 * them was winning, so an older value takes over. A retracted assertion is
 * never eligible again, so an older superseded claim from this source
 * cannot win either (rule 2.4). Facts are hidden on read once they have no
 * live source; facts with other live sources remain.
 */
export async function retractInteraction(
  tx: Tx,
  context: WriteContext,
  id: string,
): Promise<RetractInteractionResult> {
  const [row] = await tx<{ id: string; deleted_at: Date | null }[]>`
    select id, deleted_at from interactions
    where id = ${id} and workspace_id = ${context.workspaceId}
    for update`;
  if (!row) throw notFound('interaction', { id });
  if (row.deleted_at) {
    throw new AppError(409, 'interaction_deleted', `interaction ${id} is already retracted`, {
      id,
    });
  }
  await tx`update interactions set deleted_at = clock_timestamp() where id = ${id}`;

  // No new claim can cite the interaction now: writers lock it in share mode
  // first. Lock the affected records in sorted ID order (rule 2.5).
  const affected = await tx<{ record_id: string }[]>`
    select distinct record_id from field_assertions
    where workspace_id = ${context.workspaceId} and source_interaction_id = ${id}
      and status in ('active', 'superseded', 'pending_review')`;
  const recordIds = affected.map((a) => a.record_id).sort();
  const locked =
    recordIds.length === 0
      ? []
      : await tx<LockedRecord[]>`
          select id, object_type_id, data, updated_at, deleted_at, merged_into_id from records
          where workspace_id = ${context.workspaceId} and id = any(${recordIds}::uuid[])
          order by id for update`;

  const retracted = await tx<{ record_id: string; field_id: string; status: string }[]>`
    with target as (
      select id, record_id, field_id, status from field_assertions
      where workspace_id = ${context.workspaceId} and source_interaction_id = ${id}
        and status in ('active', 'superseded', 'pending_review')
    )
    update field_assertions a set status = 'retracted'
    from target t where a.id = t.id
    returning t.record_id, t.field_id, t.status`;

  // Release every identifier the retracted winners held, across all affected
  // records, before recomputing any of them. Otherwise a claim from this very
  // interaction on a record later in the order would block another record's
  // previous value from coming back.
  const released = retracted.filter((a) => a.status === 'active');
  if (released.length > 0) {
    await tx`
      delete from record_identifiers ri
      using unnest(${released.map((a) => a.record_id)}::uuid[],
        ${released.map((a) => a.field_id)}::uuid[]) as r(record_id, field_id)
      where ri.workspace_id = ${context.workspaceId}
        and ri.record_id = r.record_id and ri.field_id = r.field_id`;
  }

  const recomputed: string[] = [];
  for (const record of locked) {
    const fieldIds = [
      ...new Set(
        retracted
          .filter((a) => a.record_id === record.id && a.status === 'active')
          .map((a) => a.field_id),
      ),
    ];
    const object = context.schema.objectsById.get(record.object_type_id);
    if (fieldIds.length === 0 || !object) continue;
    await recomputeFields(tx, context, object, record, fieldIds);
    recomputed.push(record.id);
  }

  const hidden = await tx<{ id: string }[]>`
    select distinct f.id from facts f
    join fact_sources s on s.fact_id = f.id and s.interaction_id = ${id}
    where f.workspace_id = ${context.workspaceId} and f.deleted_at is null
      and not exists (
        select 1 from fact_sources s2
        join interactions i on i.id = s2.interaction_id and i.deleted_at is null
        where s2.fact_id = f.id)
    order by f.id`;

  return {
    id,
    deleted: true,
    retractedAssertions: retracted.length,
    recomputedRecordIds: recomputed,
    hiddenFactIds: hidden.map((f) => f.id),
  };
}

export type UnresolvedParticipant = {
  interactionId: string;
  handle: string | null;
  role: string | null;
  occurredAt: string;
  title: string | null;
  /** The deleted, unmerged records that claim the handle. */
  deletedRecordIds: string[];
};

/**
 * Participants of live interactions whose handle belongs only to deleted,
 * unmerged records (1.2). They stay unresolved rather than attach new
 * interactions to a hidden record, and wait here for a person.
 */
export async function listUnresolvedParticipants(
  tx: Tx,
  workspaceId: string,
  limit: number,
): Promise<UnresolvedParticipant[]> {
  const rows = await tx<
    {
      interaction_id: string;
      handle: string | null;
      role: string | null;
      occurred_at: Date;
      title: string | null;
    }[]
  >`
    select p.interaction_id, p.handle, p.role, i.occurred_at, i.title
    from interaction_participants p
    join interactions i on i.id = p.interaction_id and i.deleted_at is null
    where p.workspace_id = ${workspaceId} and p.unmatched_reason = 'deleted_record'
      and p.record_id is null
    order by i.occurred_at desc, p.interaction_id, p.position
    limit ${limit}`;
  const matches = await matchEmails(
    tx,
    workspaceId,
    rows.flatMap((r) => (r.handle ? [r.handle] : [])),
  );
  return rows.map((r) => ({
    interactionId: r.interaction_id,
    handle: r.handle,
    role: r.role,
    occurredAt: r.occurred_at.toISOString(),
    title: r.title,
    deletedRecordIds: matches.get(r.handle ?? '')?.deleted ?? [],
  }));
}
