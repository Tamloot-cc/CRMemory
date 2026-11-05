import { beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import type { Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { runSchemaChange, SYSTEM_ACTOR } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { BASE_OPERATIONS } from '../../src/templates/index.js';
import { definitionsFor, upgradeWorkspaces } from '../../src/workspaces/upgrade.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let api: TestApp;
let owner: Sql;

beforeAll(() => {
  api = startTestApp(db);
  owner = db.owner;
});

/**
 * A workspace as releases before event types created it: the base entity
 * objects only. Protection did not exist yet either; the fixture clears it,
 * as migration 0012 left it on those rows.
 */
async function legacyWorkspace(slug: string, extra: SchemaOperation[] = []) {
  const [row] = await owner<{ id: string }[]>`
    insert into workspaces (slug, name) values (${slug}, ${slug}) returning id`;
  const workspaceId = row?.id as string;
  await inWorkspace(owner, workspaceId, async (tx) => {
    await runSchemaChange(tx, {
      workspaceId,
      actor: SYSTEM_ACTOR,
      scopes: [],
      operations: BASE_OPERATIONS,
      owner: 'system',
      trusted: true,
    });
    if (extra.length > 0) {
      await runSchemaChange(tx, {
        workspaceId,
        actor: { type: 'agent', id: 'bot' },
        scopes: ['schema:write'],
        operations: extra,
      });
    }
  });
  await owner`update object_types set is_protected = false where workspace_id = ${workspaceId}`;
  await owner`update fields set is_protected = false where workspace_id = ${workspaceId}`;
  const { key } = await createApiKey(owner, {
    workspace: workspaceId,
    name: 'admin',
    actor: { type: 'user', id: 'dana' },
    scopes: ['read', 'write', 'schema:write', 'admin'],
  });
  return { workspaceId, key };
}

const logCall = (key: string, extra: Record<string, unknown> = {}) =>
  api.request('/v1/events', {
    key,
    body: {
      type: 'conversation',
      channel: 'phone',
      occurredAt: '2026-11-01T09:00:00Z',
      title: 'Intro call',
      ...extra,
    },
  });

const changesOf = (workspaceId: string) =>
  owner<{ requested_by: { type: string; id: string }; reason: string; status: string }[]>`
    select requested_by, reason, status from schema_changes
    where workspace_id = ${workspaceId} and reason = 'Upgrade built-in definitions'`;

const digestOf = async (workspaceId: string) =>
  (
    await owner<{ definitions_digest: string | null }[]>`
      select definitions_digest from workspaces where id = ${workspaceId}`
  )[0]?.definitions_digest;

describe('upgrading workspaces to the built-in definitions', () => {
  it('gives a pre-events workspace its event types, internal notes and protection', async () => {
    const { workspaceId, key } = await legacyWorkspace('legacy');
    const before = await logCall(key);
    expect(before.status).toBe(404);

    const report = await upgradeWorkspaces(owner);
    expect(report).toEqual({ upgraded: ['legacy'], conflicts: [], failed: [] });

    const schema = await api.request('/v1/schema', { key });
    const objects = schema.body.objects as {
      nameSingular: string;
      class: string;
      isProtected: boolean;
    }[];
    expect(objects.filter((o) => o.class === 'event').map((o) => o.nameSingular)).toEqual([
      'conversation',
      'note',
    ]);
    expect(objects.filter((o) => o.isProtected).map((o) => o.nameSingular)).toEqual([
      'company',
      'person',
      'task',
    ]);

    const person = await api.request('/v1/objects/person/records', {
      key,
      body: { values: { name: 'Noa Levi', emails: 'noa@example.com' } },
    });
    expect(person.status).toBe(201);
    const call = await logCall(key, { participants: [{ recordId: person.body.id }] });
    expect(call.status).toBe(201);
    // remember without a source writes an internal note.
    const fact = await api.request(`/v1/records/${person.body.id}/facts`, {
      key,
      body: { text: 'Prefers calls in the morning.' },
    });
    expect(fact.status).toBe(201);

    const deletion = await api.request('/v1/schema/changes', {
      key,
      body: { reason: 'test', operations: [{ op: 'delete_object', object: 'person' }] },
    });
    expect(deletion.status).toBe(422);
    expect(JSON.stringify(deletion.body)).toContain('protected');

    expect(await changesOf(workspaceId)).toEqual([
      {
        requested_by: SYSTEM_ACTOR,
        reason: 'Upgrade built-in definitions',
        status: 'applied',
      },
    ]);
    expect(await digestOf(workspaceId)).toBe(definitionsFor([]).digest);
  });

  it('changes nothing on a second run, and stamps a current workspace without a change', async () => {
    const { workspace } = await api.setupWorkspace({ name: 'Fresh', template: 'clinic' }, {});
    expect(await upgradeWorkspaces(owner)).toEqual({ upgraded: [], conflicts: [], failed: [] });
    expect(await changesOf(workspace.id)).toEqual([]);
    expect(await digestOf(workspace.id)).toBe(
      definitionsFor([{ name: 'clinic', version: 1, appliedAt: '' }]).digest,
    );
    expect(await upgradeWorkspaces(owner)).toEqual({ upgraded: [], conflicts: [], failed: [] });
  });

  it('upgrades each workspace once when two runs race', async () => {
    const { workspaceId } = await legacyWorkspace('raced');
    const [a, b] = await Promise.all([
      upgradeWorkspaces(db.connect({ max: 1 })),
      upgradeWorkspaces(db.connect({ max: 1 })),
    ]);
    expect([...a.upgraded, ...b.upgraded]).toEqual(['raced']);
    expect([...a.failed, ...b.failed]).toEqual([]);
    expect(await changesOf(workspaceId)).toHaveLength(1);
  });

  it('upgrades a workspace whose schema has an issue an older release allowed', async () => {
    const visit: SchemaOperation = {
      op: 'create_object',
      object: {
        nameSingular: 'visit',
        namePlural: 'visits',
        labelSingular: 'Visit',
        labelPlural: 'Visits',
        labelField: 'name',
        fields: [{ name: 'name', label: 'Name', type: 'text' }],
      },
    };
    const { workspaceId, key } = await legacyWorkspace('tolerated', [visit]);
    // Before "interaction" was reserved, a workspace could name its own object so.
    await owner`
      update object_types set name_singular = 'interaction', name_plural = 'interactions'
      where workspace_id = ${workspaceId} and name_singular = 'visit'`;

    expect(await upgradeWorkspaces(owner)).toEqual({
      upgraded: ['tolerated'],
      conflicts: [],
      failed: [],
    });
    expect((await logCall(key)).status).toBe(201);
    expect(await digestOf(workspaceId)).toBe(definitionsFor([]).digest);
    // Changes outside the trusted path still refuse the old issue.
    const change = await api.request('/v1/schema/changes', {
      key,
      body: {
        reason: 'test',
        operations: [
          {
            op: 'create_field',
            object: 'company',
            field: { name: 'size', label: 'Size', type: 'number' },
          },
        ],
      },
    });
    expect(change.status, JSON.stringify(change.body)).toBe(422);
    expect(JSON.stringify(change.body)).toContain('reserved');
  });

  it("reports a name the workspace's own object uses, and adds it once that is renamed", async () => {
    const conversation: SchemaOperation = {
      op: 'create_object',
      object: {
        nameSingular: 'conversation',
        namePlural: 'conversations',
        labelSingular: 'Conversation',
        labelPlural: 'Conversations',
        labelField: 'name',
        fields: [{ name: 'name', label: 'Name', type: 'text' }],
      },
    };
    const { workspaceId, key } = await legacyWorkspace('clash', [conversation]);
    const report = await upgradeWorkspaces(owner);
    expect(report).toEqual({
      upgraded: ['clash'],
      conflicts: [
        {
          workspace: 'clash',
          element: 'conversation',
          message: expect.stringContaining('conversation'),
        },
      ],
      failed: [],
    });
    expect(await digestOf(workspaceId)).toBeNull();
    // The rest of the upgrade still applies: notes can be logged.
    const note = await logCall(key, { type: 'note' });
    expect(note.status).toBe(201);

    const rename = await api.request('/v1/schema/changes', {
      key,
      body: {
        reason: 'make room',
        operations: [
          {
            op: 'rename_object',
            object: 'conversation',
            nameSingular: 'visit',
            namePlural: 'visits',
          },
        ],
      },
    });
    expect(rename.body.status).toBe('applied');
    expect(await upgradeWorkspaces(owner)).toEqual({
      upgraded: ['clash'],
      conflicts: [],
      failed: [],
    });
    expect(await digestOf(workspaceId)).toBe(definitionsFor([]).digest);
  });
});
