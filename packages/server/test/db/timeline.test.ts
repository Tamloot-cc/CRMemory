import type { Actor, TimelineItem } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import type { LogEventInput } from '../../src/memory/events.js';
import { logEventFor, remember, retractFactFor } from '../../src/memory/service.js';
import { type Caller, createRecord, deleteRecord, patchRecord } from '../../src/records/service.js';
import { timelineFor } from '../../src/retrieval/service.js';
import { type TimelineInput, timelineInputSchema } from '../../src/retrieval/timeline.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * The unified record timeline (spec 8): events, asserted field values and
 * facts, merged newest first with a cursor bound to the record and filters.
 */

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
const schemaChange = (operations: SchemaOperation[]) =>
  inWorkspace(app, workspaceId, (tx) =>
    runSchemaChange(tx, {
      workspaceId,
      actor: USER,
      scopes: ['schema:write', 'admin'],
      operations,
    }),
  );

let n = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 2, 1, 9, minute)).toISOString();
const log = (input: Partial<LogEventInput> = {}) =>
  logEventFor(app, as(AGENT), {
    type: 'conversation',
    channel: 'zoom',
    externalId: `evt-${++n}`,
    occurredAt: at(0),
    title: `Call ${n}`,
    fields: {},
    participants: [],
    about: [],
    ...input,
  });
const company = () => createRecord(app, as(AGENT), 'company', { name: `Co ${++n}` });
const deal = (values: Record<string, unknown> = {}) =>
  createRecord(app, as(AGENT), 'deal', { name: `Deal ${++n}`, ...values });

const timeline = (recordId: string, input: Partial<TimelineInput> = {}) =>
  timelineFor(app, as(AGENT), recordId, timelineInputSchema.parse(input));
const keys = (items: TimelineItem[]) => items.map((i) => `${i.kind}:${i.id}`);

/** Every page, following the cursor. */
async function walk(recordId: string, input: Partial<TimelineInput> = {}) {
  const items: TimelineItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await timeline(recordId, { ...input, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 20 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Acme', template: 'sales' })).id;
  await schemaChange([
    { op: 'update_field', object: 'deal', field: 'company', rollUpEvents: true },
  ]);
});

describe('record timeline', () => {
  it('merges the three kinds, and at equal times orders event, value, fact', async () => {
    const d = await deal();
    const call = await log({ about: [d.id], occurredAt: at(10) });
    // A value and a fact citing the call take its time (rules 2.2, 2.6).
    await patchRecord(app, as(AGENT), d.id, {
      values: { stage: 'qualified' },
      source: call.id,
    });
    const fact = await remember(app, as(AGENT), d.id, { text: 'Wants SSO', source: call.id });

    const { items } = await timeline(d.id, { from: at(10), to: at(11) });
    expect(items.map((i) => [i.kind, i.at])).toEqual([
      ['event', at(10)],
      ['field_change', at(10)],
      ['fact', at(10)],
    ]);
    const [event, change, stated] = items;
    expect(event).toMatchObject({
      id: call.id,
      type: 'conversation',
      title: expect.stringMatching(/^Call /),
      via: { kind: 'about' },
    });
    expect(change).toMatchObject({
      field: 'stage',
      value: 'qualified',
      status: 'active',
      current: true,
      actor: AGENT,
      source: { id: call.id, type: 'conversation' },
    });
    expect(stated).toMatchObject({ id: fact.fact.id, content: 'Wants SSO', status: 'current' });

    // Paging one at a time through equal times loses and repeats nothing.
    const paged = await walk(d.id, { from: at(10), to: at(11), limit: 1 });
    expect(keys(paged)).toEqual(keys(items));
  });

  it('lists superseded values as claims, not as the current value', async () => {
    const d = await deal({ stage: 'lead' });
    await patchRecord(app, as(AGENT), d.id, { values: { stage: 'qualified' } });
    const { items } = await timeline(d.id, { fields: ['stage'] });
    expect(items.every((i) => i.kind === 'field_change')).toBe(true);
    expect(items.map((i) => i.kind === 'field_change' && [i.value, i.status, i.current])).toEqual([
      ['qualified', 'active', true],
      ['lead', 'superseded', false],
    ]);
  });

  it('places a backdated claim at its time, superseded without ever winning', async () => {
    const d = await deal();
    const recent = await log({ about: [d.id], occurredAt: at(50) });
    const old = await log({ about: [d.id], occurredAt: at(5) });
    await patchRecord(app, as(AGENT), d.id, { values: { stage: 'proposal' }, source: recent.id });
    // Learned later from an older conversation: observed at that time, so
    // the newer observation keeps winning and this one never did.
    await patchRecord(app, as(AGENT), d.id, { values: { stage: 'lead' }, source: old.id });

    const items = await walk(d.id, { types: ['field_change'], fields: ['stage'] });
    expect(items.map((i) => i.kind === 'field_change' && [i.value, i.at, i.current])).toEqual([
      ['proposal', at(50), true],
      ['lead', at(5), false],
    ]);
  });

  it('shows a set assertion as the whole asserted membership', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'contacts',
          label: 'Contacts',
          type: 'relation',
          settings: { targetObject: 'person', relationCardinality: 'many_to_many' },
        },
      },
    ]);
    const people = await Promise.all(
      [1, 2, 3].map((i) =>
        createRecord(app, as(AGENT), 'person', { emails: `tl${i}-${++n}@acme.test` }),
      ),
    );
    const [p1, p2, p3] = people.map((p) => p.id) as [string, string, string];
    const d = await deal({ contacts: [p1, p2] });
    await patchRecord(app, as(AGENT), d.id, { values: { contacts: [p2, p3] } });
    const items = await walk(d.id, { fields: ['contacts'] });
    expect(items.map((i) => i.kind === 'field_change' && [i.value, i.current])).toEqual([
      [[p2, p3].sort(), true],
      [[p1, p2].sort(), false],
    ]);
    expect(items[0]).toMatchObject({ relationReferences: { [p3]: { id: p3, object: 'person' } } });
  });

  it('includes superseded and ended facts, never retracted or source-less ones', async () => {
    const d = await deal();
    const kept = await remember(app, as(AGENT), d.id, { text: 'Budget is 50k' });
    const dup = await remember(app, as(AGENT), d.id, { text: 'Budget is about 50k' });
    const retracted = await remember(app, as(AGENT), d.id, { text: 'Wrong' });
    const call = await log({ about: [d.id], occurredAt: at(20) });
    const sourced = await remember(app, as(AGENT), d.id, { text: 'Gone later', source: call.id });
    // The consolidator marks a duplicate superseded by the canonical fact.
    await db.owner`update facts set superseded_by = ${kept.fact.id} where id = ${dup.fact.id}`;
    await retractFactFor(app, as(USER), retracted.fact.id);
    await deleteRecord(app, as(USER), call.id);

    const facts = (await timeline(d.id, { types: ['fact'] })).items;
    expect(new Map(facts.map((f) => [f.id, f.kind === 'fact' && f.status]))).toEqual(
      new Map([
        [kept.fact.id, 'current'],
        [dup.fact.id, 'superseded'],
      ]),
    );
    expect(facts.map((f) => f.id)).not.toContain(sourced.fact.id);
    // Facts resting on an internal note say so, and the note is no event.
    expect(facts[0]).toMatchObject({ sources: [{ event: null, internal: true }] });
    const events = (await timeline(d.id, { types: ['event'] })).items;
    expect(events).toEqual([]);
  });

  it('includes rolled-up events once, with via', async () => {
    const acme = await company();
    const [d1, d2] = [await deal({ company: acme.id }), await deal({ company: acme.id })];
    const both = await log({ about: [d1.id, d2.id], occurredAt: at(30) });
    const direct = await log({ about: [acme.id, d1.id], occurredAt: at(31) });
    const events = (await timeline(acme.id, { types: ['event'] })).items;
    expect(events.map((e) => e.kind === 'event' && [e.id, e.via.kind])).toEqual([
      [direct.id, 'about'],
      [both.id, 'rollup'],
    ]);
  });

  it('filters by field, event type and time; a kind filter leaves the others out', async () => {
    await schemaChange([
      {
        op: 'create_object',
        object: {
          class: 'event',
          nameSingular: 'visit',
          namePlural: 'visits',
          labelSingular: 'Visit',
          labelPlural: 'Visits',
          fields: [],
        },
      },
    ]);
    const d = await deal({ stage: 'lead' });
    const call = await log({ about: [d.id], occurredAt: at(40) });
    const visit = await log({ type: 'visit', about: [d.id], occurredAt: at(41) });
    await remember(app, as(AGENT), d.id, { text: 'Met at the expo' });

    const stage = (await timeline(d.id, { fields: ['stage'] })).items;
    expect(stage.map((i) => i.kind === 'field_change' && i.field)).toEqual(['stage']);

    const visits = (await timeline(d.id, { eventTypes: ['visit'] })).items;
    expect(keys(visits)).toEqual([`event:${visit.id}`]);

    // Named explicitly, other kinds come back too, each filter on its own kind.
    const mixed = (await timeline(d.id, { types: ['event', 'fact'], eventTypes: ['conversation'] }))
      .items;
    expect(mixed.map((i) => i.kind).sort()).toEqual(['event', 'fact']);
    expect(mixed.find((i) => i.kind === 'event')?.id).toBe(call.id);

    const window = (await timeline(d.id, { from: at(40), to: at(41) })).items;
    expect(keys(window)).toEqual([`event:${call.id}`]);

    await expect(timeline(d.id, { fields: ['nope'] })).rejects.toMatchObject({
      code: 'unknown_field',
    });
    await expect(timeline(d.id, { eventTypes: ['company'] })).rejects.toMatchObject({
      code: 'unknown_event_type',
    });
  });

  it('binds the cursor to the record and the filters, not to field names', async () => {
    const [a, b] = [await deal({ stage: 'lead' }), await deal({ stage: 'lead' })];
    for (const stage of ['qualified', 'proposal']) {
      await patchRecord(app, as(AGENT), a.id, { values: { stage } });
    }
    const first = await timeline(a.id, { fields: ['stage'], limit: 1 });
    const cursor = first.nextCursor as string;
    expect(cursor).toBeTruthy();

    await expect(timeline(b.id, { fields: ['stage'], cursor })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(timeline(a.id, { cursor })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(timeline(a.id, { fields: ['stage'], cursor: 'nonsense' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });

    // Fields are matched by identity: after a rename the same cursor goes on.
    await schemaChange([{ op: 'rename_field', object: 'deal', field: 'stage', name: 'phase' }]);
    try {
      const next = await timeline(a.id, { fields: ['phase'], limit: 1, cursor });
      expect(next.items).toEqual([
        expect.objectContaining({ kind: 'field_change', field: 'phase', value: 'qualified' }),
      ]);
    } finally {
      await schemaChange([{ op: 'rename_field', object: 'deal', field: 'phase', name: 'stage' }]);
    }
  });

  it('leaves out values of deleted fields and resolves merged record IDs', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'temp', label: 'Temp', type: 'text' },
      },
    ]);
    const d = await deal({ temp: 'x' });
    expect(
      (await timeline(d.id, { types: ['field_change'] })).items.map(
        (i) => i.kind === 'field_change' && i.field,
      ),
    ).toContain('temp');
    await schemaChange([{ op: 'delete_field', object: 'deal', field: 'temp' }]);
    expect(
      (await timeline(d.id, { types: ['field_change'] })).items.map(
        (i) => i.kind === 'field_change' && i.field,
      ),
    ).not.toContain('temp');
  });
});
