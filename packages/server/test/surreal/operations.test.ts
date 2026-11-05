import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { logEventFor, remember } from '../../src/memory/service.js';
import { getOperation } from '../../src/operations/service.js';
import { type Caller, createRecord, forget, traverse } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
let n = 0;
const email = () => `ops${++n}@acme.test`;

beforeAll(async () => {
  workspaceId = (await createWorkspace(backend, { name: 'Ops', template: 'sales' })).id;
});

describe('get_operation', () => {
  it('finds a write by kind and idempotency key, and reports what it does not know', async () => {
    const dana = await createRecord(backend, as(AGENT), 'person', { emails: email() });
    const fact = await remember(backend, as(AGENT), dana.id, { text: 'Likes tea' }, 'key-1');
    const receipt = await getOperation(backend, as(AGENT), {
      kind: 'remember',
      idempotencyKey: 'key-1',
    });
    expect(receipt).toMatchObject({ kind: 'remember', status: 'completed', result: fact });
    const byId = await getOperation(backend, as(AGENT), {
      operationId: receipt.operationId as string,
    });
    expect(byId).toEqual(receipt);
    // A retry with the same key replays the receipt: no second fact.
    expect(await remember(backend, as(AGENT), dana.id, { text: 'Likes tea' }, 'key-1')).toEqual(
      fact,
    );
    expect(
      await getOperation(backend, as(AGENT), { kind: 'remember', idempotencyKey: 'never-sent' }),
    ).toMatchObject({ status: 'not_observed', result: null });
  });

  it('never returns a result that forget erased', async () => {
    const gone = await createRecord(backend, as(AGENT), 'person', { emails: email() });
    await remember(backend, as(AGENT), gone.id, { text: 'Private' }, 'key-erased');
    await forget(backend, as(USER), gone.id);
    expect(
      await getOperation(backend, as(AGENT), { kind: 'remember', idempotencyKey: 'key-erased' }),
    ).toMatchObject({ status: 'erased', result: null });
    await expect(
      remember(backend, as(AGENT), gone.id, { text: 'Private' }, 'key-erased'),
    ).rejects.toMatchObject({ code: 'result_erased' });
  });
});

describe('traverse_records', () => {
  it('follows fields both ways and event links, with evidence', async () => {
    const acme = await createRecord(backend, as(AGENT), 'company', { name: 'Acme' });
    const dana = await createRecord(backend, as(AGENT), 'person', {
      name: 'Dana Levi',
      emails: email(),
      company: acme.id,
    });
    const ron = await createRecord(backend, as(AGENT), 'person', {
      name: 'Ron Peretz',
      emails: email(),
    });
    const call = await logEventFor(backend, as(AGENT), {
      type: 'call',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00Z',
      fields: {},
      participants: [{ recordId: dana.id }, { recordId: ron.id }],
      about: [],
    });

    // Who at Acme met whom: company <- person -> event -> person.
    const result = await traverse(backend, as(AGENT), {
      starts: [acme.id],
      path: [
        { field: 'people' },
        { link: 'participant', direction: 'in' },
        { link: 'participant', direction: 'out' },
      ],
    });
    expect(result.truncated).toBeNull();
    expect(result.paths).toEqual([
      {
        records: [
          { id: acme.id, type: 'company', label: 'Acme' },
          { id: dana.id, type: 'person', label: 'Dana Levi' },
          { id: call.id, type: 'call', label: null },
          { id: ron.id, type: 'person', label: 'Ron Peretz' },
        ],
        steps: [
          { field: 'people', direction: 'out', assertionId: expect.any(String) },
          { link: 'participant', direction: 'in', eventId: call.id, linkId: expect.any(String) },
          { link: 'participant', direction: 'out', eventId: call.id, linkId: expect.any(String) },
        ],
      },
    ]);
    expect(result.examinedEdges).toBeGreaterThanOrEqual(4);

    // `in` by the owning field's name reaches the same people.
    const back = await traverse(backend, as(AGENT), {
      starts: [acme.id],
      path: [{ field: 'company', direction: 'in' }],
    });
    expect(back.paths.map((p) => p.records[1]?.id)).toEqual([dana.id]);
  });

  it('refuses unknown starts and fields', async () => {
    await expect(
      traverse(backend, as(AGENT), {
        starts: ['00000000-0000-4000-8000-000000000000'],
        path: [{ field: 'company' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_starts' });
    const acme = await createRecord(backend, as(AGENT), 'company', { name: 'Beta' });
    await expect(
      traverse(backend, as(AGENT), { starts: [acme.id], path: [{ field: 'nope' }] }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });
});
