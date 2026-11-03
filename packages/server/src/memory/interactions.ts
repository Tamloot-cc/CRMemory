import type { Actor, PresentedInteraction } from '@retainer/shared';
import { z } from 'zod';
import {
  INTERACTION_KINDS,
  type InteractionKind,
  type ParticipantLink,
  type UnmatchedReason,
} from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound, requireUser } from '../errors.js';
import { isSuppressed, suppressedOf } from '../privacy/suppression.js';
import { searchVector } from '../records/search-sql.js';
import {
  lockRecordsForUpdate,
  MAX_MERGE_HOPS,
  type RemovedClaim,
  releaseAndRecompute,
  type WriteContext,
} from '../records/write.js';
import { type Handle, parseHandle } from './handles.js';

/**
 * The interaction log (1.3, 4.1): what happened, written by the agent, and
 * who took part. Participants are matched synchronously against unique
 * identifiers; Retainer never creates records for the ones it cannot match.
 */

export const MAX_PARTICIPANTS = 200;
/** How many records an interaction can be `about` in one write. */
export const MAX_ABOUT = 200;
/** How far past the server's clock `occurredAt` may be, for clock skew. */
const FUTURE_SKEW = '10 minutes';

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
  about: z.array(z.uuid()).max(MAX_ABOUT).default([]),
});
/** `about` may be left out by callers that skip the schema, such as tests. */
export type LogInteractionInput = Omit<z.infer<typeof logInteractionInputSchema>, 'about'> & {
  about?: string[];
};

/** `POST /v1/interactions/:id/participants`: links to add to a logged interaction. */
export const addLinksInputSchema = z
  .strictObject({
    participants: z.array(participantInputSchema).max(MAX_PARTICIPANTS).default([]),
    about: z.array(z.uuid()).max(MAX_ABOUT).default([]),
  })
  .refine((input) => input.participants.length > 0 || input.about.length > 0, {
    message: 'give participants, about, or both',
  });
export type AddLinksInput = z.infer<typeof addLinksInputSchema>;

export type MatchedParticipant = {
  id: string;
  handle: string | null;
  role: string | null;
  recordId: string;
};
export type UnmatchedParticipant = {
  id: string;
  handle: string | null;
  role: string | null;
  reason: UnmatchedReason;
  /** For `ambiguous`: the live records that claim the handle (1.2). */
  candidates?: string[];
};
export type Participants = { matched: MatchedParticipant[]; unmatched: UnmatchedParticipant[] };

/** What a write added to an interaction's participants and `about` records. */
export type AddedLinks = { participants: Participants; about: string[] };

/** What `log_interaction` returns (6.2). `added` is set when it was logged before. */
export type LogInteractionResult = {
  id: string;
  created: boolean;
  participants: Participants;
  about: string[];
  added?: AddedLinks;
};

export type { PresentedInteraction } from '@retainer/shared';

type NormalizedParticipant = {
  handle: Handle | null;
  recordId: string | null;
  role: string | null;
};

type ParticipantRow = {
  id: string;
  handle: string | null;
  role: string | null;
  record_id: string | null;
  unmatched_reason: UnmatchedReason | null;
  link: ParticipantLink;
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

/**
 * Splits stored participant rows into matched and unmatched, in logged
 * order (6.2). `about` rows are left out: they are not attendees.
 */
async function presentParticipants(
  tx: Tx,
  workspaceId: string,
  allRows: readonly ParticipantRow[],
  knownCandidates?: Map<string, EmailMatch>,
): Promise<Participants> {
  const rows = allRows.filter((r) => r.link === 'participant');
  const ambiguous = rows.flatMap((r) =>
    r.unmatched_reason === 'ambiguous' && r.handle ? [r.handle] : [],
  );
  const candidates = knownCandidates ?? (await matchEmails(tx, workspaceId, ambiguous));
  const participants: Participants = { matched: [], unmatched: [] };
  for (const row of rows) {
    if (row.record_id) {
      participants.matched.push({
        id: row.id,
        handle: row.handle,
        role: row.role,
        recordId: row.record_id,
      });
      continue;
    }
    const reason = row.unmatched_reason ?? 'no_match';
    participants.unmatched.push({
      id: row.id,
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

/** The records an interaction is `about`, in logged order. */
function aboutOf(rows: readonly ParticipantRow[]): string[] {
  return rows.flatMap((r) => (r.link === 'about' && r.record_id ? [r.record_id] : []));
}

async function loadRows(
  tx: Tx,
  workspaceId: string,
  interactionId: string,
): Promise<(ParticipantRow & { position: number })[]> {
  return tx<(ParticipantRow & { position: number })[]>`
    select id, position, handle, role, record_id, unmatched_reason, link
    from interaction_participants
    where workspace_id = ${workspaceId} and interaction_id = ${interactionId}
    order by position`;
}

/**
 * The identity of a participant when a write is compared with what is
 * stored (1.3): the role, and the handle if there is one, else the record
 * (after merges). An erased handle is stored as null, so it is compared as
 * "suppressed" rather than by value.
 */
function participantKey(role: string | null, handle: string | null, recordId: string | null) {
  return JSON.stringify([role, handle ? `h:${handle}` : recordId ? `r:${recordId}` : 's']);
}

/**
 * Adds participants and `about` records to an interaction (1.3). A
 * participant already stored (by handle, or by record when it has none) is
 * not added again, so a retry or a re-log adds nothing; nothing stored is
 * ever removed here. An `about` record already linked to the interaction,
 * as an attendee or as `about`, is skipped. The caller holds the
 * interaction row lock (or has just inserted it), so positions never clash.
 */
async function addLinks(
  tx: Tx,
  workspaceId: string,
  interactionId: string,
  input: { participants: readonly NormalizedParticipant[]; about: readonly string[] },
): Promise<{ rows: ParticipantRow[]; added: AddedLinks }> {
  const stored = await loadRows(tx, workspaceId, interactionId);

  // A handle erased by forget is never stored again (2.1). The caller holds
  // the privacy lock in shared mode, so forget cannot run between this check
  // and the commit.
  const suppressed = await suppressedOf(
    tx,
    workspaceId,
    input.participants.flatMap((p) => (p.handle ? [p.handle] : [])),
  );
  const erased = input.participants.map(
    (p) => p.handle !== null && isSuppressed(suppressed, p.handle),
  );
  const kept = input.participants.map((p, i) => (erased[i] ? { ...p, handle: null } : p));

  const given = [
    ...new Set([...kept.flatMap((p) => (p.recordId ? [p.recordId] : [])), ...input.about]),
  ];
  const canonical = await canonicalRecords(tx, workspaceId, given);

  // Participants not stored yet. Matching counts duplicates, so a list that
  // names the same handle twice keeps both, as when it was first logged.
  const remaining = new Map<string, number>();
  for (const row of stored) {
    if (row.link !== 'participant') continue;
    const key = participantKey(row.role, row.handle, row.record_id);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const newParticipants: { participant: NormalizedParticipant; erased: boolean }[] = [];
  kept.forEach((p, i) => {
    const recordId = p.recordId ? (canonical.get(p.recordId)?.id ?? p.recordId) : null;
    const key = participantKey(p.role, p.handle?.value ?? null, recordId);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else newParticipants.push({ participant: p, erased: erased[i] as boolean });
  });

  const resolutions = await resolveParticipants(
    tx,
    workspaceId,
    newParticipants.map((n) => n.participant),
  );

  // About records: known and live, not linked already, each once.
  const linked = new Set(stored.flatMap((r) => (r.record_id ? [r.record_id] : [])));
  for (const r of resolutions) if ('recordId' in r) linked.add(r.recordId);
  const errors: { index: number; recordId: string; message: string }[] = [];
  const newAbout: string[] = [];
  input.about.forEach((id, index) => {
    const record = canonical.get(id);
    if (!record) {
      errors.push({ index, recordId: id, message: 'no record with this ID' });
      return;
    }
    if (linked.has(record.id)) return;
    if (record.deleted) {
      errors.push({ index, recordId: record.id, message: 'the record is deleted' });
      return;
    }
    linked.add(record.id);
    newAbout.push(record.id);
  });
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_about', 'some about records cannot be used', { errors });
  }

  let position = Math.max(-1, ...stored.map((r) => r.position)) + 1;
  const inserts = [
    ...newParticipants.map(({ participant: p, erased }, n) => {
      const resolution = resolutions[n] as Resolution;
      const matched = 'recordId' in resolution;
      return {
        workspace_id: workspaceId,
        interaction_id: interactionId,
        position: position++,
        handle: p.handle?.value ?? null,
        role: p.role,
        record_id: matched ? resolution.recordId : null,
        unmatched_reason: matched ? null : erased ? 'suppressed' : resolution.reason,
        link: 'participant',
      };
    }),
    ...newAbout.map((recordId) => ({
      workspace_id: workspaceId,
      interaction_id: interactionId,
      position: position++,
      handle: null,
      role: null,
      record_id: recordId,
      unmatched_reason: null,
      link: 'about',
    })),
  ];
  const inserted =
    inserts.length > 0
      ? await tx<ParticipantRow[]>`
          insert into interaction_participants ${tx(inserts)}
          returning id, handle, role, record_id, unmatched_reason, link`
      : [];
  return {
    rows: [...stored, ...inserted],
    added: {
      participants: await presentParticipants(tx, workspaceId, inserted),
      about: aboutOf(inserted),
    },
  };
}

/**
 * Logs an interaction (4.1). Logging the same `(channel, externalId)` again
 * with the same kind, time, title and summary returns the existing
 * interaction with `created: false`, after adding any participants and
 * `about` records it did not have yet (1.3). A different kind, time, title
 * or summary is a conflict. A concurrent duplicate waits on the unique index
 * until the first commits, then takes the same path.
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

  const [inserted] = await tx<{ id: string }[]>`
    insert into interactions (workspace_id, kind, channel, external_id, occurred_at, title,
      summary, search, created_by)
    values (${context.workspaceId}, ${input.kind}, ${input.channel}, ${input.externalId ?? null},
      ${occurredAt}, ${input.title ?? null}, ${input.summary ?? null},
      ${searchVector(tx, input.title ?? null, input.summary ?? '')}, ${tx.json(context.actor)})
    on conflict (workspace_id, channel, external_id) where external_id is not null do nothing
    returning id`;
  const id = inserted?.id ?? (await lockExisting(tx, context.workspaceId, input, occurredAt));
  const { rows, added } = await addLinks(tx, context.workspaceId, id, {
    participants,
    // Absent when a caller skips the schema's default.
    about: input.about ?? [],
  });
  return {
    id,
    created: inserted !== undefined,
    participants: await presentParticipants(tx, context.workspaceId, rows),
    about: aboutOf(rows),
    ...(inserted ? {} : { added }),
  };
}

/**
 * Locks the interaction already logged under this `(channel, externalId)`
 * and checks it is the same source: same kind, time, title and summary.
 */
async function lockExisting(
  tx: Tx,
  workspaceId: string,
  input: LogInteractionInput,
  occurredAt: Date,
): Promise<string> {
  const [existing] = await tx<{ id: string; deleted_at: Date | null; same: boolean }[]>`
    select id, deleted_at,
      kind = ${input.kind} and occurred_at = ${occurredAt}
        and title is not distinct from ${input.title ?? null}::text
        and summary is not distinct from ${input.summary ?? null}::text as same
    from interactions
    where workspace_id = ${workspaceId} and channel = ${input.channel}
      and external_id = ${input.externalId ?? null}
    for update`;
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
  if (!existing.same) {
    throw new AppError(
      409,
      'interaction_conflict',
      `interaction ${existing.id} was already logged with this channel and externalId and a ` +
        'different kind, occurredAt, title or summary. Participants and about records may ' +
        'differ: logging it again adds the new ones. An edited source needs a new externalId; ' +
        'a person can retract the old interaction if it is wrong',
      { id: existing.id },
    );
  }
  return existing.id;
}

/** Locks a live interaction for a change to its links. */
async function lockLive(tx: Tx, workspaceId: string, id: string): Promise<void> {
  const [row] = await tx<{ deleted_at: Date | null }[]>`
    select deleted_at from interactions
    where id = ${id} and workspace_id = ${workspaceId}
    for update`;
  if (!row) throw notFound('interaction', { id });
  if (row.deleted_at) {
    throw new AppError(404, 'interaction_deleted', `interaction ${id} was retracted`, { id });
  }
}

/**
 * Adds participants and `about` records to a logged interaction, with the
 * same matching as `logInteraction` (1.3). Idempotent: links it already has
 * are not added again.
 */
export async function addInteractionLinks(
  tx: Tx,
  context: WriteContext,
  id: string,
  input: AddLinksInput,
): Promise<PresentedInteraction & { added: AddedLinks }> {
  const participants = normalizeParticipants(input.participants);
  await lockLive(tx, context.workspaceId, id);
  const { added } = await addLinks(tx, context.workspaceId, id, {
    participants,
    about: input.about,
  });
  return { ...(await getInteraction(tx, context.workspaceId, id)), added };
}

/**
 * Removes one participant from an interaction (1.3). Only a person removes
 * links: what an agent logged stays until someone decides otherwise.
 */
export async function removeParticipant(
  tx: Tx,
  context: WriteContext,
  id: string,
  participantId: string,
): Promise<PresentedInteraction> {
  requireUser(context.actor, 'remove a participant');
  await lockLive(tx, context.workspaceId, id);
  const [removed] = await tx<{ id: string }[]>`
    delete from interaction_participants
    where workspace_id = ${context.workspaceId} and interaction_id = ${id}
      and id = ${participantId} and link = 'participant'
    returning id`;
  if (!removed) throw notFound('participant', { id: participantId, interaction: id });
  return getInteraction(tx, context.workspaceId, id);
}

/** Removes a record from an interaction's `about` list (1.3); a person only. */
export async function removeAbout(
  tx: Tx,
  context: WriteContext,
  id: string,
  recordId: string,
): Promise<PresentedInteraction> {
  requireUser(context.actor, 'remove an about record');
  await lockLive(tx, context.workspaceId, id);
  const canonical = (await canonicalRecords(tx, context.workspaceId, [recordId])).get(recordId);
  const [removed] = await tx<{ id: string }[]>`
    delete from interaction_participants
    where workspace_id = ${context.workspaceId} and interaction_id = ${id} and link = 'about'
      and record_id = ${canonical?.id ?? recordId}
    returning id`;
  if (!removed) throw notFound('about record', { id: recordId, interaction: id });
  return getInteraction(tx, context.workspaceId, id);
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
  const rows = await loadRows(tx, workspaceId, row.id);
  return presentInteraction(row, await presentParticipants(tx, workspaceId, rows), aboutOf(rows));
}
function presentInteraction(
  row: InteractionRow,
  participants: Participants,
  about: string[],
): PresentedInteraction {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    externalId: row.external_id,
    occurredAt: row.occurred_at.toISOString(),
    title: row.title,
    summary: row.summary,
    participants,
    about,
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
  >`select interaction_id,id,handle,role,record_id,unmatched_reason,link from interaction_participants where workspace_id = ${workspaceId} and interaction_id = any(${ids}::uuid[]) order by interaction_id,position`;
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
        aboutOf(grouped.get(row.id) ?? []),
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
  const locked = await lockRecordsForUpdate(
    tx,
    context.workspaceId,
    affected.map((a) => a.record_id),
  );

  const retracted = await tx<RemovedClaim[]>`
    with target as (
      select id, record_id, field_id, status from field_assertions
      where workspace_id = ${context.workspaceId} and source_interaction_id = ${id}
        and status in ('active', 'superseded', 'pending_review')
    )
    update field_assertions a set status = 'retracted'
    from target t where a.id = t.id
    returning t.record_id, t.field_id, t.status`;

  // A claim from this very interaction on a record later in the order must
  // not block another record's previous value from coming back.
  const recomputed = await releaseAndRecompute(tx, context, locked, retracted);

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
