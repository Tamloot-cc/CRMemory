import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'reader' | 'dana' | 'omer' | 'admin', string>;
let otherKey: string;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'user', id: 'viewer' }, scopes: ['read'] },
      dana: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] },
      omer: { actor: { type: 'user', id: 'omer' }, scopes: ['read', 'write'] },
      admin: { actor: { type: 'user', id: 'root' }, scopes: ['admin'] },
    },
  ));
  otherKey = (
    await t.setupWorkspace(
      { name: 'Other', template: 'sales' },
      { dana: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] } },
    )
  ).keys.dana;
});

const create = (body: unknown, key = keys.dana, object = 'deal') =>
  t.request(`/v1/objects/${object}/views`, { key, body });
const patch = (id: string, body: unknown, key = keys.dana) =>
  t.request(`/v1/views/${id}`, { key, method: 'PATCH', body });
const list = async (key = keys.dana, object = 'deal') =>
  (await t.request(`/v1/objects/${object}/views`, { key })).body.views as { id: string }[];
const schemaChange = (operations: unknown[]) =>
  t.request('/v1/schema/changes', { key: keys.admin, body: { operations } });

describe('saved views', () => {
  it('saves a table view by field name and reads it back', async () => {
    const res = await create({
      name: 'Big open deals',
      kind: 'table',
      filter: { and: [{ stage: { neq: 'lost' } }, { amount: { gte: 1_000_000_000 } }] },
      sort: [{ field: 'closeDate', direction: 'desc' }],
      columns: {
        order: ['stage', 'amount'],
        widths: { amount: 160 },
        aggregates: { amount: 'sum' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: 'deal',
      name: 'Big open deals',
      kind: 'table',
      visibility: 'workspace',
      filter: { and: [{ stage: { neq: 'lost' } }, { amount: { gte: 1_000_000_000 } }] },
      sort: [{ field: 'closeDate', direction: 'desc' }],
      columns: {
        order: ['stage', 'amount'],
        widths: { amount: 160 },
        aggregates: { amount: 'sum' },
      },
      groupBy: null,
      hiddenGroups: [],
      dateField: null,
      createdBy: { type: 'user', id: 'dana' },
      issues: [],
    });

    const fetched = await t.request(`/v1/views/${res.body.id}`, { key: keys.reader });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(res.body);
    expect((await list(keys.reader)).map((v) => v.id)).toContain(res.body.id);
  });

  it('lists views in their saved order, new ones last', async () => {
    const a = await create({ name: 'A', kind: 'table' }, keys.dana, 'company');
    const b = await create({ name: 'B', kind: 'table' }, keys.dana, 'company');
    expect(b.body.position).toBeGreaterThan(a.body.position);
    await patch(b.body.id, { position: a.body.position - 1 });
    expect((await list(keys.dana, 'company')).map((v) => v.id)).toEqual([b.body.id, a.body.id]);
  });

  it('saves boards and calendars with the field they need', async () => {
    const board = await create({
      name: 'Pipeline',
      kind: 'board',
      groupBy: 'stage',
      hiddenGroups: ['lost', null],
      groupAggregate: { field: 'amount', op: 'sum' },
    });
    expect(board.status).toBe(201);
    expect(board.body).toMatchObject({
      groupBy: 'stage',
      hiddenGroups: ['lost', null],
      groupAggregate: { field: 'amount', op: 'sum' },
    });
    const calendar = await create({ name: 'Closing', kind: 'calendar', dateField: 'closeDate' });
    expect(calendar.status).toBe(201);
    expect(calendar.body.dateField).toBe('closeDate');
  });

  it('rejects views that would not run', async () => {
    const cases: [unknown, string][] = [
      [{ name: 'No group', kind: 'board' }, 'invalid_view'],
      [{ name: 'Text group', kind: 'board', groupBy: 'name' }, 'invalid_view'],
      [{ name: 'No date', kind: 'calendar' }, 'invalid_view'],
      [{ name: 'Not a date', kind: 'calendar', dateField: 'amount' }, 'invalid_view'],
      [{ name: 'Unknown', kind: 'table', columns: { order: ['nope'] } }, 'invalid_view'],
      [{ name: 'Twice', kind: 'table', columns: { order: ['stage', 'stage'] } }, 'invalid_view'],
      [
        { name: 'Bad op', kind: 'table', columns: { order: [], aggregates: { name: 'sum' } } },
        'invalid_view',
      ],
      [{ name: 'Bad filter', kind: 'table', filter: { stage: { gt: 'won' } } }, 'invalid_filter'],
      [{ name: 'Bad sort', kind: 'table', sort: [{ field: 'company' }] }, 'invalid_filter'],
    ];
    for (const [body, code] of cases) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe(code);
    }
    expect((await create({ name: '', kind: 'table' })).status).toBe(400);
    expect((await create({ name: 'X', kind: 'gantt' })).status).toBe(400);
  });

  it('changes only the keys a PATCH gives, and null clears one', async () => {
    const view = await create({
      name: 'Mine',
      kind: 'table',
      filter: { stage: 'won' },
      sort: [{ field: 'createdAt', direction: 'desc' }],
    });
    const renamed = await patch(view.body.id, { name: 'Won deals', filter: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'Won deals',
      filter: null,
      sort: [{ field: 'createdAt', direction: 'desc' }],
      updatedBy: { type: 'user', id: 'dana' },
    });
    // A table can become a board once it has a group field.
    expect((await patch(view.body.id, { kind: 'board' })).status).toBe(422);
    const board = await patch(view.body.id, { kind: 'board', groupBy: 'stage' }, keys.omer);
    expect(board.body).toMatchObject({ kind: 'board', groupBy: 'stage' });
    expect(board.body.updatedBy).toEqual({ type: 'user', id: 'omer' });
    expect((await patch(view.body.id, { groupBy: null })).status).toBe(422);
  });

  it('serializes updates, so two at once to different settings both land', async () => {
    const view = await create({ name: 'Busy', kind: 'table' });
    const updates = Array.from({ length: 6 }, (_, i) =>
      i % 2
        ? patch(view.body.id, { columns: { order: ['stage'], widths: { stage: 100 + i } } })
        : patch(view.body.id, { sort: [{ field: 'name', direction: 'asc' }] }),
    );
    const results = await Promise.all(updates);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    const final = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(final.body.sort).toEqual([{ field: 'name', direction: 'asc' }]);
    expect(final.body.columns.order).toEqual(['stage']);
  });

  it('keeps private views to the actor that made them', async () => {
    const mine = await create({ name: 'Just me', kind: 'table', visibility: 'private' });
    expect(mine.status).toBe(201);
    expect((await list(keys.dana)).map((v) => v.id)).toContain(mine.body.id);
    expect((await list(keys.omer)).map((v) => v.id)).not.toContain(mine.body.id);
    expect((await t.request(`/v1/views/${mine.body.id}`, { key: keys.omer })).status).toBe(404);
    expect((await patch(mine.body.id, { name: 'Hijacked' }, keys.omer)).status).toBe(404);
    expect(
      (await t.request(`/v1/views/${mine.body.id}`, { key: keys.omer, method: 'DELETE' })).status,
    ).toBe(404);

    // Only the creator decides who sees a view.
    const shared = await create({ name: 'Team', kind: 'table' });
    const res = await patch(shared.body.id, { visibility: 'private' }, keys.omer);
    expect(res.status).toBe(403);
    expect((await patch(shared.body.id, { visibility: 'private' })).body.visibility).toBe(
      'private',
    );
  });

  it('needs write to change views, and stays in its workspace', async () => {
    expect((await create({ name: 'Nope', kind: 'table' }, keys.reader)).status).toBe(403);
    const view = await create({ name: 'Ours', kind: 'table' });
    expect((await patch(view.body.id, { name: 'Read only' }, keys.reader)).status).toBe(403);
    expect((await t.request(`/v1/views/${view.body.id}`, { key: otherKey })).status).toBe(404);
    expect((await list(otherKey)).map((v) => v.id)).not.toContain(view.body.id);
    // Agents can save views too; the actor is theirs.
    const agents = await create({ name: 'Agent view', kind: 'table' }, keys.agent);
    expect(agents.body.createdBy).toEqual({ type: 'agent', id: 'inbox' });
  });

  it('deletes a view', async () => {
    const view = await create({ name: 'Gone soon', kind: 'table' });
    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana, method: 'DELETE' });
    expect(res.body).toEqual({ id: view.body.id, deleted: true });
    expect((await t.request(`/v1/views/${view.body.id}`, { key: keys.dana })).status).toBe(404);
    expect((await t.request('/v1/views/not-an-id', { key: keys.dana })).status).toBe(404);
  });
});

describe('views across schema changes', () => {
  it('follows a renamed field, because it stores keys', async () => {
    const created = await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'region', label: 'Region', type: 'text' },
      },
    ]);
    expect(created.status).toBe(200);
    const view = await create({
      name: 'By region',
      kind: 'table',
      filter: { region: { contains: 'EU' } },
      columns: { order: ['region'] },
    });
    expect(
      (await schemaChange([{ op: 'rename_field', object: 'deal', field: 'region', name: 'area' }]))
        .status,
    ).toBe(200);
    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.body).toMatchObject({
      filter: { area: { contains: 'EU' } },
      columns: { order: ['area'] },
      issues: [],
    });
  });

  // The schema change rewrites the stored view in its own transaction, so a
  // read after it has nothing left to drop: `issues` stays empty, and the
  // view was last updated by whoever changed the schema.
  const repaired = { issues: [], updatedBy: { type: 'user', id: 'root' } };

  it('drops references to a removed field when the field is removed', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'priority',
          label: 'Priority',
          type: 'select',
          settings: {
            options: [
              { value: 'high', label: 'High' },
              { value: 'low', label: 'Low' },
            ],
          },
        },
      },
    ]);
    const view = await create({
      name: 'By priority',
      kind: 'board',
      groupBy: 'priority',
      filter: { or: [{ priority: 'high' }, { stage: 'won' }], not: { priority: 'low' } },
      sort: [{ field: 'priority', direction: 'asc' }],
      columns: { order: ['priority', 'stage'], widths: { priority: 120 } },
    });
    expect(view.status).toBe(201);
    expect(
      (await schemaChange([{ op: 'delete_field', object: 'deal', field: 'priority' }])).status,
    ).toBe(200);

    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'board',
      groupBy: null,
      // The `or` keeps its other branch; the emptied `not` goes, rather than
      // turning into "not (true)".
      filter: { or: [{ stage: 'won' }] },
      sort: null,
      columns: { order: ['stage'], widths: {} },
      ...repaired,
    });
    // The view still runs as a query.
    const query = await t.request('/v1/objects/deal/query', {
      key: keys.dana,
      body: { filter: res.body.filter },
    });
    expect(query.status).toBe(200);
    // It can still be renamed; choosing a new group field fixes it.
    expect((await patch(view.body.id, { name: 'Renamed' })).status).toBe(200);
    expect((await patch(view.body.id, { groupBy: 'stage' })).body.groupBy).toBe('stage');
  });

  it('drops a board or calendar field that can no longer be used for it', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'tier',
          label: 'Tier',
          type: 'select',
          settings: { options: [{ value: 'gold', label: 'Gold' }] },
        },
      },
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'renewsOn', label: 'Renews on', type: 'date' },
      },
    ]);
    const board = await create({ name: 'By tier', kind: 'board', groupBy: 'tier' });
    const calendar = await create({ name: 'Renewals', kind: 'calendar', dateField: 'renewsOn' });
    expect(
      (
        await schemaChange([
          { op: 'update_field', object: 'deal', field: 'tier', isFilterable: false },
          { op: 'update_field', object: 'deal', field: 'renewsOn', isFilterable: false },
        ])
      ).status,
    ).toBe(200);

    const read = async (id: string) =>
      (await t.request(`/v1/views/${id}`, { key: keys.dana })).body;
    // The views stay, waiting for a new field, rather than being deleted.
    expect(await read(board.body.id)).toMatchObject({ kind: 'board', groupBy: null, ...repaired });
    expect(await read(calendar.body.id)).toMatchObject({
      kind: 'calendar',
      dateField: null,
      ...repaired,
    });
  });

  it('drops conditions and sorts that no longer compile', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'source', label: 'Source', type: 'text' },
      },
    ]);
    const view = await create({
      name: 'From referrals',
      kind: 'table',
      filter: { and: [{ source: { eq: 'referral' } }, { stage: { neq: 'lost' } }] },
      sort: [{ field: 'source', direction: 'asc' }],
    });
    expect(view.status).toBe(201);
    // The field stays, but can no longer be filtered or sorted by.
    expect(
      (
        await schemaChange([
          { op: 'update_field', object: 'deal', field: 'source', isFilterable: false },
        ])
      ).status,
    ).toBe(200);

    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      filter: { and: [{ stage: { neq: 'lost' } }] },
      sort: null,
      ...repaired,
    });
    // What is left still runs as a query.
    const query = await t.request('/v1/objects/deal/query', {
      key: keys.dana,
      body: { filter: res.body.filter },
    });
    expect(query.status).toBe(200);
  });

  it('drops a removed option from filters and hidden columns', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'segment',
          label: 'Segment',
          type: 'select',
          settings: {
            options: [
              { value: 'smb', label: 'SMB' },
              { value: 'mid', label: 'Mid-market' },
              { value: 'ent', label: 'Enterprise' },
            ],
          },
        },
      },
    ]);
    const board = await create({
      name: 'By segment',
      kind: 'board',
      groupBy: 'segment',
      hiddenGroups: ['mid', null],
      filter: { or: [{ segment: { in: ['smb', 'mid'] } }, { segment: { eq: 'mid' } }] },
    });
    expect(board.status).toBe(201);
    // No record holds "mid", so the engine lets it go.
    expect(
      (
        await schemaChange([
          { op: 'remove_option', object: 'deal', field: 'segment', value: 'mid' },
        ])
      ).status,
    ).toBe(200);

    const res = await t.request(`/v1/views/${board.body.id}`, { key: keys.dana });
    expect(res.body).toMatchObject({
      groupBy: 'segment',
      hiddenGroups: [null],
      // `in` keeps the options left; a condition naming only "mid" goes.
      filter: { or: [{ segment: { in: ['smb'] } }] },
      ...repaired,
    });
  });

  it('leaves views alone when a change gives them nothing to repair', async () => {
    const view = await create({
      name: 'Open deals',
      kind: 'table',
      filter: { stage: { neq: 'lost' } },
    });
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'notes2', label: 'Side notes', type: 'text' },
      },
    ]);
    await schemaChange([{ op: 'delete_field', object: 'deal', field: 'notes2' }]);
    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.body).toMatchObject({
      updatedBy: { type: 'user', id: 'dana' },
      updatedAt: view.body.updatedAt,
    });
  });
});
