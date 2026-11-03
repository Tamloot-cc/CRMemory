import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { requestHash } from '../../src/idempotency.js';
import type { LogInteractionInput } from '../../src/memory/interactions.js';
import { factsOf, logInteractionFor, readInteraction, remember } from '../../src/memory/service.js';
import { SUPPRESSION_KEY_ENV } from '../../src/privacy/suppression.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  forget,
  mergeRecord,
  patchRecord,
  readRecord,
} from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Privacy', template: 'sales' })).id;
});

let n = 0;
const email = () => `forget${++n}@acme.test`;
const person = (values: Record<string, unknown> = {}) =>
  createRecord(app, as(AGENT), 'person', { emails: email(), ...values });
const log = (input: Partial<LogInteractionInput> = {}) =>
  logInteractionFor(app, as(AGENT), {
    kind: 'call',
    channel: 'zoom',
    occurredAt: '2026-10-29T14:00:00+02:00',
    participants: [],
    ...input,
  });

const count = async (query: Promise<{ count: number }[]>) => (await query)[0]?.count ?? 0;

describe('forget (2.1)', () => {
  it('hard-deletes the person, the interactions they took part in, and claims resting on them', async () => {
    const acme = await createRecord(app, as(AGENT), 'company', { name: 'Acme Forget' });
    const dana = await person({
      name: 'Dana Forgetme',
      emails: { primary: 'dana@forget.test', additional: ['d.f@home.test'] },
      phones: '+972 54 765 4321',
      company: acme.id,
    });
    const ron = await person({ name: 'Ron Stays' });
    const task = await createRecord(app, as(AGENT), 'task', {
      title: 'Call Dana',
      person: dana.id,
    });

    // A call with both of them: Ron's claim and fact from it go, Dana's interaction goes.
    const call = await log({
      externalId: 'call-forget-1',
      participants: [{ handle: 'DANA@forget.test' }, { recordId: ron.id }],
    });
    await patchRecord(app, as(AGENT), ron.id, { values: { jobTitle: 'CTO' }, source: call.id });
    await remember(app, as(AGENT), ron.id, { text: 'Ron joined the call', source: call.id });
    // A fact about Ron also cited elsewhere survives with its other source.
    const other = await log({ externalId: 'call-forget-2', participants: [{ recordId: ron.id }] });
    const both = await remember(app, as(AGENT), ron.id, { text: 'Ron likes tea', source: call.id });
    await db.owner`
      insert into fact_sources (workspace_id, fact_id, interaction_id)
      values (${workspaceId}, ${both.fact.id}, ${other.id})`;
    // Mentions on other rows become review candidates.
    const mention = await remember(app, as(AGENT), acme.id, {
      text: 'Dana Forgetme is the champion at Acme',
      source: other.id,
    });
    const emailMention = await log({
      externalId: 'call-forget-3',
      summary: 'Forwarded to dana@forget.test for review',
    });
    // A note fact on Dana and a stored idempotent response that names her.
    await remember(app, as(AGENT), dana.id, { text: 'Dana prefers mornings' });
    await createRecord(
      app,
      as(AGENT),
      'task',
      { title: 'Follow up', person: dana.id },
      {
        idempotencyKey: 'task-for-dana',
      },
    );

    const result = await forget(app, as(USER), dana.id);
    expect(result).toMatchObject({
      id: dana.id,
      forgotten: true,
      counts: { records: 1, suppressedHandles: 3, inboundRelations: 2 },
    });
    expect(result.counts.interactions).toBe(2); // the call and the note
    expect(result.recomputedRecordIds).toEqual(expect.arrayContaining([ron.id, task.id]));
    expect(result.reviewCandidates.facts).toContain(mention.fact.id);
    expect(result.reviewCandidates.interactions).toContain(emailMention.id);
    // The response carries no erased content. Match the whole phone number:
    // shorter digit runs turn up in the random ids the response does carry.
    expect(JSON.stringify(result)).not.toMatch(/dana|forgetme|765 ?4321|547654321/i);

    expect(await count(db.owner`select count(*)::int from records where id = ${dana.id}`)).toBe(0);
    expect(
      await count(db.owner`select count(*)::int from interactions where id = ${call.id}`),
    ).toBe(0);
    expect(
      await count(
        db.owner`select count(*)::int from interaction_participants where handle like '%forget.test'`,
      ),
    ).toBe(0);
    expect(
      await count(db.owner`select count(*)::int from idempotency_keys where key = 'task-for-dana'`),
    ).toBe(0);

    // Ron's value from the erased call is gone.
    expect((await readRecord(app, as(USER), ron.id)).fields.jobTitle ?? null).toBeNull();
    const ronFacts = (await factsOf(app, as(USER), ron.id, 10)).facts;
    expect(ronFacts.map((f) => f.content)).toEqual(['Ron likes tea']);
    expect(ronFacts[0]?.sources).toEqual([{ interaction: other.id, quote: null }]);
    // Relations to Dana are cleared; the task stays.
    const taskAfter = await readRecord(app, as(USER), task.id);
    expect(taskAfter.fields.person ?? null).toBeNull();
    expect(
      await count(
        db.owner`select count(*)::int from record_links where target_record_id = ${dana.id}`,
      ),
    ).toBe(0);
    await expect(readInteraction(app, as(USER), other.id)).resolves.toBeDefined();

    const [audit] = await db.owner<{ actor_type: string; actor_id: string; counts: object }[]>`
      select actor_type, actor_id, counts from deletion_audit_log where workspace_id = ${workspaceId}`;
    expect(audit).toEqual({ actor_type: 'user', actor_id: 'maya', counts: result.counts });
    const suppressed = await db.owner<{ kind: string; hmac: string }[]>`
      select kind, hmac from suppressions where workspace_id = ${workspaceId} order by kind`;
    expect(suppressed.map((s) => s.kind)).toEqual(['email', 'email', 'phone']);
    for (const s of suppressed) expect(s.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps erased emails and phones from coming back', async () => {
    const dana = await person({ emails: 'gone@forget.test', phones: '+1 415 555 0199' });
    await forget(app, as(USER), dana.id);

    await expect(
      createRecord(app, as(AGENT), 'person', { emails: 'GONE@forget.test' }),
    ).rejects.toMatchObject({
      code: 'suppressed',
      details: { field: 'emails', errors: [{ field: 'emails' }] },
    });
    await expect(
      createRecord(app, as(AGENT), 'person', { emails: email(), phones: '+1 (415) 555-0199' }),
    ).rejects.toMatchObject({ code: 'suppressed', details: { field: 'phones' } });
    const someone = await person();
    await expect(
      patchRecord(app, as(USER), someone.id, {
        values: { emails: { primary: email(), additional: ['gone@forget.test'] } },
      }),
    ).rejects.toMatchObject({ code: 'suppressed' });

    const input = {
      externalId: 'after-forget-1',
      participants: [{ handle: 'gone@forget.test', role: 'customer' }, { recordId: someone.id }],
    };
    const logged = await log(input);
    expect(logged.participants.unmatched).toEqual([
      { handle: null, role: 'customer', reason: 'suppressed' },
    ]);
    expect(
      await count(
        db.owner`select count(*)::int from interaction_participants where handle = 'gone@forget.test'`,
      ),
    ).toBe(0);

    // The stored request hash does not cover the plain handle, so a dump
    // cannot confirm a guess; a retry with the same input still matches.
    const [stored] = await db.owner<{ request_hash: string }[]>`
      select request_hash from interactions where id = ${logged.id}`;
    const plain = requestHash({
      kind: 'call',
      channel: 'zoom',
      externalId: 'after-forget-1',
      occurredAt: new Date('2026-10-29T14:00:00+02:00').toISOString(),
      title: null,
      summary: null,
      participants: [
        { handle: 'gone@forget.test', recordId: null, role: 'customer' },
        { handle: null, recordId: someone.id, role: null },
      ],
    });
    expect(stored?.request_hash).not.toBe(plain);
    expect(await log(input)).toMatchObject({ id: logged.id, created: false });

    // Control: for a handle that is not suppressed, the same construction matches.
    const control = await log({
      externalId: 'after-forget-2',
      participants: [{ handle: 'still@forget.test', role: 'customer' }],
    });
    const [controlRow] = await db.owner<{ request_hash: string }[]>`
      select request_hash from interactions where id = ${control.id}`;
    expect(controlRow?.request_hash).toBe(
      requestHash({
        kind: 'call',
        channel: 'zoom',
        externalId: 'after-forget-2',
        occurredAt: new Date('2026-10-29T14:00:00+02:00').toISOString(),
        title: null,
        summary: null,
        participants: [{ handle: 'still@forget.test', recordId: null, role: 'customer' }],
      }),
    );
  });

  it('forgets every record merged into the person, and soft-deleted records too', async () => {
    const a = await person({ name: 'Merged Twice' });
    const b = await person();
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    const result = await forget(app, as(USER), b.id);
    expect(result.id).toBe(a.id);
    expect(result.counts.records).toBe(2);
    expect(
      await count(db.owner`select count(*)::int from records where id in (${a.id}, ${b.id})`),
    ).toBe(0);

    const c = await person();
    await deleteRecord(app, as(USER), c.id);
    await expect(forget(app, as(USER), c.id)).resolves.toMatchObject({ forgotten: true });
  });

  it('lets a record that shares an erased phone keep it, but no other record add it', async () => {
    const shared = '+972 3 555 0100';
    const dana = await person({ phones: shared });
    const office = await person({ phones: shared });
    await forget(app, as(USER), dana.id);
    const kept = await patchRecord(app, as(USER), office.id, {
      values: { phones: { primary: shared, additional: ['+972 3 555 0101'] } },
    });
    expect(kept.fields).toEqual({ phones: 'applied' });
    await expect(person({ phones: shared })).rejects.toMatchObject({ code: 'suppressed' });
  });

  it('needs a user and a configured suppression key', async () => {
    const dana = await person();
    await expect(forget(app, as(AGENT), dana.id)).rejects.toMatchObject({ status: 403 });
    const key = process.env[SUPPRESSION_KEY_ENV];
    delete process.env[SUPPRESSION_KEY_ENV];
    try {
      await expect(forget(app, as(USER), dana.id)).rejects.toMatchObject({
        status: 503,
        code: 'not_configured',
      });
      // Suppressions exist, so writes that could bring a handle back fail closed.
      await expect(person()).rejects.toMatchObject({ code: 'not_configured' });
    } finally {
      process.env[SUPPRESSION_KEY_ENV] = key;
    }
    expect((await readRecord(app, as(USER), dana.id)).id).toBe(dana.id);
  });

  it("does not touch another workspace's suppressions", async () => {
    const other = (await createWorkspace(db.owner, { name: 'Elsewhere', template: 'sales' })).id;
    const dana = await person({ emails: 'shared@forget.test' });
    await forget(app, as(USER), dana.id);
    await expect(
      createRecord(app, as(AGENT, other), 'person', { emails: 'shared@forget.test' }),
    ).resolves.toMatchObject({ created: true });
  });
});

describe('forget under concurrency (2.1)', () => {
  it('leaves no participant row with the handle, whichever commits first', async () => {
    for (let round = 0; round < 8; round++) {
      const handle = `race${round}@forget.test`;
      const dana = await person({ emails: handle });
      const [, logged] = await Promise.allSettled([
        forget(app, as(USER), dana.id),
        log({ participants: [{ handle }] }),
      ]);
      expect(logged.status).toBe('fulfilled');
      expect(
        await count(
          db.owner`select count(*)::int from interaction_participants where handle = ${handle}`,
        ),
      ).toBe(0);
    }
  });

  it('never lets a concurrent create keep an erased email', async () => {
    for (let round = 0; round < 8; round++) {
      const handle = `create${round}@forget.test`;
      const dana = await person({ emails: { primary: email(), additional: [handle] } });
      const [forgotten, created] = await Promise.allSettled([
        forget(app, as(USER), dana.id),
        createRecord(app, as(AGENT), 'person', { emails: handle }),
      ]);
      expect(forgotten.status).toBe('fulfilled');
      // Before forget the email is taken; after it, it is suppressed.
      expect(created.status).toBe('rejected');
      expect(
        await count(db.owner`select count(*)::int from record_identifiers where value = ${handle}`),
      ).toBe(0);
    }
  });

  it('leaves no fact behind when remember races forget', async () => {
    for (let round = 0; round < 8; round++) {
      const dana = await person();
      await Promise.allSettled([
        forget(app, as(USER), dana.id),
        remember(app, as(AGENT), dana.id, { text: `Race fact ${round}` }),
      ]);
      expect(
        await count(
          db.owner`select count(*)::int from facts where content = ${`Race fact ${round}`}`,
        ),
      ).toBe(0);
      expect(await count(db.owner`select count(*)::int from records where id = ${dana.id}`)).toBe(
        0,
      );
    }
  });
});
