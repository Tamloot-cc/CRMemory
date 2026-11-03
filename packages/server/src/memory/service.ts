import type { InteractionQueryResult } from '@retainer/shared';
import type { Sql } from '../db/client.js';
import { claimIdempotencyKey, storeIdempotentResult } from '../idempotency.js';
import { type Caller, withRead, withWrite } from '../records/service.js';
import {
  type FactList,
  listFacts,
  type RememberInput,
  type RememberResult,
  rememberFact,
  rememberRequestHash,
  retractFact,
} from './facts.js';
import {
  type AddedLinks,
  type AddLinksInput,
  addInteractionLinks,
  getInteraction,
  type LogInteractionInput,
  type LogInteractionResult,
  logInteraction,
  type PresentedInteraction,
  type RetractInteractionResult,
  removeLink,
  retractInteraction,
} from './interactions.js';
import { type InteractionQuery, queryInteractions } from './query-interactions.js';

/**
 * Memory writes and reads for one caller, shared by REST and MCP so both
 * apply the same validation and rules. Each is one short transaction (4.1).
 */

export async function logInteractionFor(
  sql: Sql,
  caller: Caller,
  input: LogInteractionInput,
): Promise<LogInteractionResult> {
  return withWrite(sql, caller, (tx, context) => logInteraction(tx, context, input));
}

export async function readInteraction(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<PresentedInteraction> {
  return withRead(sql, caller, (tx) => getInteraction(tx, caller.workspaceId, id));
}

export async function queryInteractionsFor(
  sql: Sql,
  caller: Caller,
  input: InteractionQuery,
): Promise<InteractionQueryResult> {
  return withRead(sql, caller, (tx) => queryInteractions(tx, caller.workspaceId, input));
}

export async function addInteractionLinksFor(
  sql: Sql,
  caller: Caller,
  id: string,
  input: AddLinksInput,
): Promise<PresentedInteraction & { added: AddedLinks }> {
  return withWrite(sql, caller, (tx, context) => addInteractionLinks(tx, context, id, input));
}

/** Removes a participant, or a record from the `about` list; a person only. */
export async function removeLinkFor(
  sql: Sql,
  caller: Caller,
  id: string,
  target: { participant: string } | { about: string },
): Promise<PresentedInteraction> {
  return withWrite(sql, caller, (tx, context) => removeLink(tx, context, id, target));
}

export async function retractInteractionFor(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<RetractInteractionResult> {
  return withWrite(sql, caller, (tx, context) => retractInteraction(tx, context, id));
}

/**
 * `remember` (6.2). With an idempotency key, the key is claimed in the same
 * transaction as the fact, so a retry, even a concurrent one, returns the
 * original response instead of a second fact and note.
 */
export async function remember(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: RememberInput,
  idempotencyKey?: string,
): Promise<RememberResult> {
  return withWrite(sql, caller, async (tx, context) => {
    let claimId: string | undefined;
    if (idempotencyKey !== undefined) {
      const claim = await claimIdempotencyKey(
        tx,
        caller.workspaceId,
        'remember',
        idempotencyKey,
        rememberRequestHash(recordId, input),
      );
      if (claim.kind === 'replay') return claim.result as RememberResult;
      claimId = claim.id;
    }
    const result = await rememberFact(tx, context, recordId, input);
    if (claimId) await storeIdempotentResult(tx, claimId, result);
    return result;
  });
}

export async function factsOf(
  sql: Sql,
  caller: Caller,
  recordId: string,
  limit: number,
): Promise<FactList> {
  return withRead(sql, caller, (tx) => listFacts(tx, caller.workspaceId, recordId, limit));
}

export async function retractFactFor(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<{ id: string; deleted: true }> {
  return withWrite(sql, caller, (tx) => retractFact(tx, caller.workspaceId, id));
}
