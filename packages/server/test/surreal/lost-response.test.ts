import type { Actor } from '@retainer/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { remember } from '../../src/memory/service.js';
import { getOperation } from '../../src/operations/service.js';
import { type Caller, createRecord } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * A lost mutation response (spec sections 7 and 11): the commit reaches
 * SurrealDB and applies, but the client never sees the answer. The caller
 * gets `unknown_outcome` with the operation ID, `get_operation` resolves it,
 * and a retry with the same key replays the original instead of writing
 * twice.
 */
const backend = useTestBackend();
const AGENT: Actor = { type: 'agent', id: 'inbox' };
let caller: Caller;
const realFetch = globalThis.fetch;

/** Lets the next commit reach the server, then reports a timeout. */
function loseNextCommitResponse() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    const isCommit =
      body instanceof Uint8Array && Buffer.from(body).includes(Buffer.from('COMMIT;'));
    const response = await realFetch(input, init);
    if (!isCommit) return response;
    globalThis.fetch = realFetch;
    await response.arrayBuffer();
    throw Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeAll(async () => {
  const workspaceId = (await createWorkspace(backend, { name: 'Lost', template: 'sales' })).id;
  caller = { workspaceId, actor: AGENT, scopes: ['read', 'write'] };
});

describe('lost mutation response', () => {
  it('reports unknown_outcome, resolves through get_operation, and retries safely', async () => {
    const dana = await createRecord(backend, caller, 'person', { emails: 'lost@acme.test' });
    loseNextCommitResponse();
    const error = await remember(
      backend,
      caller,
      dana.id,
      { text: 'Prefers mornings' },
      'lost-key',
    ).catch((e: unknown) => e as { code: string; details: { operationId: string } });
    expect(error).toMatchObject({ code: 'unknown_outcome' });
    const { operationId } = (error as { details: { operationId: string } }).details;

    // The write did commit: the receipt says so.
    const receipt = await getOperation(backend, caller, { operationId });
    expect(receipt).toMatchObject({ operationId, kind: 'remember', status: 'completed' });

    // A retry with the same key replays it: one fact, the same one.
    const retried = await remember(
      backend,
      caller,
      dana.id,
      { text: 'Prefers mornings' },
      'lost-key',
    );
    expect(retried).toEqual(receipt.result);
    const db = await backend.workspace(caller.workspaceId);
    expect(await db.rows('SELECT id FROM facts WHERE record = $r;', { r: dana.id })).toHaveLength(
      1,
    );
  });
});
