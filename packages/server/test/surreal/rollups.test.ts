import type { Actor, Via } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LogEventInput } from '../../src/memory/events.js';
import { logEventFor } from '../../src/memory/service.js';
import {
  type Caller,
  createRecord,
  deleteRecord,
  patchRecord,
  withRead,
} from '../../src/records/service.js';
import {
  attachedEventPage,
  countEventHistory,
  eventHistory,
  explainHistoryStreams,
} from '../../src/retrieval/history.js';
import { contextFor } from '../../src/retrieval/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { describeSchema } from '../../src/schema-engine/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * Event rollups (spec 7.2): events attached to a record also show in the
 * history of the records it points at through a `rollUpEvents` field, one
 * hop, read-time, each event once.
 */

const app = useTestBackend();
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
const schemaChange = (operations: SchemaOperation[], ws = workspaceId) =>
  runSchemaChange(app, {
    workspaceId: ws,
    actor: USER,
    scopes: ['schema:write', 'admin'],
    operations,
  });
const rollUp = (object: string, field: string, on = true) =>
  schemaChange([{ op: 'update_field', object, field, rollUpEvents: on }]);

let n = 0;
/** Distinct, increasing times, so history order is the logging order reversed. */
const at = () => new Date(Date.UTC(2026, 0, 1) + ++n * 60_000).toISOString();
const log = (input: Partial<LogEventInput> = {}) =>
  logEventFor(app, as(AGENT), {
    type: 'call',
    channel: 'zoom',
    externalId: `evt-${++n}`,
    occurredAt: at(),
    title: 'Call',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });
const create = (object: string, values: Record<string, unknown>) =>
  createRecord(app, as(AGENT), object, values);
const company = () => create('company', { name: `Co ${++n}` });
const person = () => create('person', { emails: `p${++n}@acme.test` });
const deal = (values: Record<string, unknown> = {}) =>
  create('deal', { name: `Deal ${++n}`, ...values });

const page = (recordId: string, limit = 50, cursor?: string) =>
  withRead(app, as(AGENT), (db, schema) =>
    attachedEventPage(db, schema, workspaceId, recordId, limit, cursor),
  );
const history = async (recordId: string): Promise<[string, Via][]> =>
  (await page(recordId)).items.map((e) => [e.id, e.via]);
const ids = async (recordId: string) => (await history(recordId)).map(([id]) => id);

beforeAll(async () => {
  workspaceId = (await createWorkspace(app, { name: 'Acme', template: 'sales' })).id;
  const result = await schemaChange([
    {
      op: 'create_field',
      object: 'deal',
      field: {
        name: 'contacts',
        label: 'Contacts',
        type: 'relation',
        settings: {
          targetObject: 'person',
          relationCardinality: 'many_to_many',
          rollUpEvents: true,
        },
      },
    },
    {
      op: 'create_field',
      object: 'deal',
      field: {
        name: 'customer',
        label: 'Customer',
        type: 'relation',
        settings: { targetObjects: ['company', 'person'], rollUpEvents: true },
      },
    },
    {
      op: 'create_field',
      object: 'company',
      field: {
        name: 'parent',
        label: 'Parent',
        type: 'relation',
        settings: { targetObject: 'company', rollUpEvents: true },
      },
    },
    {
      op: 'create_object',
      object: {
        nameSingular: 'invoice',
        namePlural: 'invoices',
        labelSingular: 'Invoice',
        labelPlural: 'Invoices',
        labelField: 'number',
        fields: [
          { name: 'number', label: 'Number', type: 'text' },
          {
            name: 'company',
            label: 'Company',
            type: 'relation',
            settings: { targetObject: 'company', rollUpEvents: true },
          },
        ],
      },
    },
    {
      op: 'create_object',
      object: {
        class: 'event',
        nameSingular: 'payment',
        namePlural: 'payments',
        labelSingular: 'Payment',
        labelPlural: 'Payments',
        fields: [
          {
            name: 'invoice',
            label: 'Invoice',
            type: 'relation',
            settings: { targetObject: 'invoice' },
          },
        ],
      },
    },
  ]);
  expect(result.status).toBe('applied');
  // deal.company is the sales template's; it starts off (7.2 defaults).
  expect((await rollUp('deal', 'company')).status).toBe('applied');
});

describe('the rollUpEvents setting', () => {
  it('is off by default on mutable affiliations and reported when on', async () => {
    const described = await describeSchema(app, as(AGENT));
    const settings = (object: string, field: string) =>
      described.objects.find((o) => o.nameSingular === object)?.fields.find((f) => f.name === field)
        ?.settings;
    expect(settings('person', 'company')?.rollUpEvents).toBeUndefined();
    expect(settings('deal', 'pointOfContact')?.rollUpEvents).toBeUndefined();
    expect(settings('deal', 'company')?.rollUpEvents).toBe(true);
  });

  it('changes without review, and can be turned off', async () => {
    const on = await rollUp('person', 'company');
    expect(on.status).toBe('applied');
    expect(on.change?.isDestructive).toBe(false);
    expect((await rollUp('person', 'company')).status).toBe('unchanged');
    expect((await rollUp('person', 'company', false)).status).toBe('applied');
  });

  it('is refused on inverses, event types and other field types', async () => {
    for (const [object, field] of [
      ['company', 'deals'],
      ['payment', 'invoice'],
      ['deal', 'amount'],
    ] as const) {
      await expect(rollUp(object, field)).rejects.toMatchObject({
        issues: [expect.objectContaining({ message: expect.stringContaining('rollUpEvents') })],
      });
    }
  });
});

describe('rolled-up history', () => {
  it('lists events attached to a record pointing at it, single, set and polymorphic', async () => {
    const [acme, dana] = [await company(), await person()];
    const single = await deal({ company: acme.id });
    const set = await deal({ contacts: [dana.id] });
    const poly = await deal({ customer: acme.id });
    const a = await log({ about: [single.id] });
    const b = await log({ participants: [{ recordId: set.id }] });
    const c = await log({ about: [poly.id] });

    expect(await history(acme.id)).toEqual([
      [c.id, { kind: 'rollup', field: 'customer', record: poly.id }],
      [a.id, { kind: 'rollup', field: 'company', record: single.id }],
    ]);
    expect(await history(dana.id)).toEqual([
      [b.id, { kind: 'rollup', field: 'contacts', record: set.id }],
    ]);
    // Direction is source to target only.
    const onAcme = await log({ about: [acme.id] });
    expect(await ids(single.id)).toEqual([a.id]);
    expect(await ids(acme.id)).toEqual([onAcme.id, c.id, a.id]);
  });

  it('follows the setting and the current relation', async () => {
    const [acme, globex] = [await company(), await company()];
    const d = await deal({ company: acme.id });
    const e = await log({ about: [d.id] });
    expect(await ids(acme.id)).toEqual([e.id]);

    await rollUp('deal', 'company', false);
    expect(await ids(acme.id)).toEqual([]);
    await rollUp('deal', 'company', true);
    expect(await ids(acme.id)).toEqual([e.id]);

    await patchRecord(app, as(USER), d.id, { values: { company: globex.id } });
    expect(await ids(acme.id)).toEqual([]);
    expect(await ids(globex.id)).toEqual([e.id]);

    await deleteRecord(app, as(USER), d.id);
    expect(await ids(globex.id)).toEqual([]);
  });

  it('rolls up one hop, whatever attached the event to the source', async () => {
    const [parent, child] = [await company(), await company()];
    await patchRecord(app, as(USER), child.id, { values: { parent: parent.id } });
    const invoice = await create('invoice', { number: `INV-${++n}`, company: child.id });
    // Attached to the invoice by the payment's own field (6.3), which does
    // not use up the hop: it rolls up once, to the child, never onward.
    const payment = await log({ type: 'payment', fields: { invoice: invoice.id } });
    const about = await log({ about: [invoice.id] });
    const onChild = await log({ participants: [{ recordId: child.id }] });

    expect(await history(invoice.id)).toEqual([
      [about.id, { kind: 'about' }],
      [payment.id, { kind: 'field', field: 'invoice' }],
    ]);
    expect(await history(child.id)).toEqual([
      [onChild.id, { kind: 'participant' }],
      [about.id, { kind: 'rollup', field: 'company', record: invoice.id }],
      [payment.id, { kind: 'rollup', field: 'company', record: invoice.id }],
    ]);
    // The parent gets the child's own events, not what the child has by rollup.
    expect(await history(parent.id)).toEqual([
      [onChild.id, { kind: 'rollup', field: 'parent', record: child.id }],
    ]);
  });

  it('lists an event once, by precedence, and picks one rollup path deterministically', async () => {
    const acme = await company();
    const [d1, d2] = [await deal({ company: acme.id }), await deal({ company: acme.id })];
    const both = await log({ about: [d1.id, d2.id] });
    const direct = await log({ about: [d1.id, acme.id] });
    const participant = await log({
      participants: [{ recordId: acme.id }],
      about: [acme.id, d2.id],
    });

    const first = [d1.id, d2.id].sort()[0];
    expect(await history(acme.id)).toEqual([
      [participant.id, { kind: 'participant' }],
      [direct.id, { kind: 'about' }],
      [both.id, { kind: 'rollup', field: 'company', record: first }],
    ]);

    // Two rollup fields: the smaller field ID wins, the same on every read.
    const poly = await deal({ company: acme.id, customer: acme.id });
    const twoFields = await log({ about: [poly.id] });
    const [via] = (await history(acme.id)).filter(([id]) => id === twoFields.id);
    const dealObject = await withRead(app, as(AGENT), async (_db, schema) =>
      schema.objectsByName.get('deal'),
    );
    const [first2] = ['company', 'customer']
      .map((name) => dealObject?.fieldsByName.get(name))
      .sort((x, y) => String(x?.id).localeCompare(String(y?.id)));
    expect(via?.[1]).toEqual({ kind: 'rollup', field: first2?.name, record: poly.id });
  });

  it('pages through direct and rolled-up events without gaps or repeats', async () => {
    const acme = await company();
    const deals = [await deal({ company: acme.id }), await deal({ company: acme.id })];
    const logged: string[] = [];
    for (let i = 0; i < 7; i++) {
      const target = i % 3 === 0 ? acme.id : (deals[i % 2] as { id: string }).id;
      // Some events reach the company by both paths; they still count once.
      const about = i % 4 === 0 ? [target, (deals[0] as { id: string }).id] : [target];
      logged.unshift((await log({ about: [...new Set(about)] })).id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(acme.id, 3, cursor);
      seen.push(...result.items.map((e) => e.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(logged);
  });

  it('counts and budgets each event once in the context pack', async () => {
    const acme = await company();
    const [d1, d2] = [await deal({ company: acme.id }), await deal({ company: acme.id })];
    for (let i = 0; i < 6; i++) await log({ about: [d1.id, d2.id] });
    await log({ about: [acme.id, d1.id] });

    const full = await contextFor(app, as(AGENT), acme.id, { tokenBudget: 8000 });
    expect(full.recentEvents).toHaveLength(7);
    expect(full.omitted.recentEvents).toBe(0);
    expect(full.recentEvents[0]?.via).toEqual({ kind: 'about' });
    expect(full.recentEvents[1]?.via).toMatchObject({ kind: 'rollup', field: 'company' });

    const small = await contextFor(app, as(AGENT), acme.id, { tokenBudget: 250 });
    expect(small.recentEvents.length).toBeLessThan(7);
    expect(small.recentEvents.length + small.omitted.recentEvents).toBe(7);
  });

  it('finds open tasks through set and polymorphic relations, once each', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'task',
        field: {
          name: 'regarding',
          label: 'Regarding',
          type: 'relation',
          settings: { targetObjects: ['company', 'deal'], relationCardinality: 'many_to_many' },
        },
      },
    ]);
    const acme = await company();
    const d = await deal({ company: acme.id });
    const task = await create('task', { title: 'Follow up', regarding: [acme.id, d.id] });
    for (const id of [acme.id, d.id]) {
      const pack = await contextFor(app, as(AGENT), id, { tokenBudget: 4000 });
      expect(pack.openTasks.map((t) => t.id)).toEqual([task.id]);
    }
  });
});

describe('history streams', () => {
  it('reads every stream shape by index, with the limit pushed down', async () => {
    const acme = await company();
    const plans = await withRead(app, as(AGENT), (db) => explainHistoryStreams(db, acme.id));
    for (const [shape, plan] of Object.entries(plans)) {
      const text = JSON.stringify(plan);
      expect(text, shape).toContain('"operator":"IndexScan"');
      expect(text, shape).not.toContain('TableScan');
      const index = shape.startsWith('direct')
        ? 'event_attachments_target_idx'
        : 'rollup_attachments_target_idx';
      expect(text, shape).toContain(`"index":"${index}"`);
      if (!shape.endsWith('Group')) expect(text, shape).toContain('"limit":"51"');
    }
  });

  it('merges many sources and ties without gaps, repeats or a whole-set read', async () => {
    const acme = await company();
    const noise = await company();
    const deals = [];
    for (let i = 0; i < 12; i++)
      deals.push(await deal({ company: i % 4 === 0 ? noise.id : acme.id }));
    // Several events share one time, so pages break inside a tie.
    const tie = new Date(Date.UTC(2026, 0, 1) + (n + 20) * 60_000).toISOString();
    const logged: { id: string; at: string }[] = [];
    for (let i = 0; i < 24; i++) {
      const target = deals[i % deals.length] as { id: string };
      const occurredAt = i % 3 === 0 ? tie : at();
      const e = await log({ about: [target.id, ...(i % 5 === 0 ? [acme.id] : [])], occurredAt });
      logged.push({ id: e.id, at: occurredAt });
    }
    const all = (await page(acme.id, 200)).items.map((e) => e.id);
    for (const limit of [1, 2, 5]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await page(acme.id, limit, cursor);
        seen.push(...result.items.map((e) => e.id));
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(all);
    }
    expect(new Set(all).size).toBe(all.length);
    const total = await withRead(app, as(AGENT), (db, schema) =>
      countEventHistory(db, schema, workspaceId, acme.id),
    );
    expect(total).toBe(all.length);
    const newest = await withRead(app, as(AGENT), (db, schema) =>
      eventHistory(db, schema, acme.id, { limit: 3, batch: 2 }),
    );
    expect(newest.map((h) => h.event_id)).toEqual(all.slice(0, 3));
  });
});
