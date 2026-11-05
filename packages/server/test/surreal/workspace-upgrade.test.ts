import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { Backend } from '../../src/db/backend.js';
import { mutate } from '../../src/db/protocol.js';
import { markWorkspaceActive, provisionDatabase } from '../../src/db/provision.js';
import { forgetCompiledSchema } from '../../src/schema-engine/compiled.js';
import { planSchemaChange, SYSTEM_ACTOR } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { BASE_OPERATIONS } from '../../src/templates/index.js';
import { definitionsFor, upgradeWorkspaces } from '../../src/workspaces/upgrade.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
/**
 * A process without the request-time upgrader, so a workspace stays as an
 * older release left it until `upgradeWorkspaces` runs, as in the original
 * fixture.
 */
let owner: Backend;
let api: TestApp;

beforeAll(() => {
  owner = new Backend(backend.config);
  api = startTestApp(owner);
});

/**
 * A workspace as releases before event types created it: the base entity
 * objects only. Protection did not exist yet either; the fixture clears it,
 * as migration 0012 left it on those rows.
 */
async function legacyWorkspace(slug: string, extra: SchemaOperation[] = []) {
  const workspaceId = randomUUID();
  await provisionDatabase(owner, { id: workspaceId, slug, name: slug, now: new Date() });
  await mutate(owner, workspaceId, {
    kind: 'provision_workspace',
    admin: true,
    provisioning: true,
    refs: () => [],
    plan: (op) =>
      planSchemaChange(op, {
        workspaceId,
        actor: SYSTEM_ACTOR,
        scopes: [],
        operations: BASE_OPERATIONS,
        owner: 'system',
        trusted: true,
      }),
  });
  if (extra.length > 0) {
    await mutate(owner, workspaceId, {
      kind: 'schema_change',
      admin: true,
      provisioning: true,
      refs: () => [],
      plan: (op) =>
        planSchemaChange(op, {
          workspaceId,
          actor: { type: 'agent', id: 'bot' },
          scopes: ['schema:write'],
          operations: extra,
        }),
    });
  }
  await markWorkspaceActive(owner, workspaceId);
  await adminOf(workspaceId).then((db) =>
    db.query(
      'UPDATE object_types SET is_protected = false; UPDATE fields SET is_protected = false;',
    ),
  );
  forgetCompiledSchema(workspaceId);
  const { key } = await createApiKey(owner, {
    workspace: workspaceId,
    name: 'admin',
    actor: { type: 'user', id: 'dana' },
    scopes: ['read', 'write', 'schema:write', 'admin'],
  });
  return { workspaceId, key };
}

const adminOf = async (workspaceId: string) =>
  owner.adminDb((await owner.route(workspaceId, { provisioning: true })).database);

const logCall = (key: string, extra: Record<string, unknown> = {}) =>
  api.request('/v1/events', {
    key,
    body: {
      type: 'call',
      channel: 'phone',
      occurredAt: '2026-11-01T09:00:00Z',
      title: 'Intro call',
      ...extra,
    },
  });

const changesOf = async (workspaceId: string) =>
  (await adminOf(workspaceId)).rows<{
    requested_by: { type: string; id: string };
    reason: string;
    status: string;
  }>(
    "SELECT requested_by, reason, status FROM schema_changes WHERE reason = 'Upgrade built-in definitions';",
  );

const digestOf = async (workspaceId: string) => {
  const [state] = await (await adminOf(workspaceId)).rows<{ definitions_digest?: string | null }>(
    'SELECT definitions_digest FROM ONLY workspace_state:current;',
  );
  return state?.definitions_digest ?? null;
};

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
      'meeting',
      'call',
      'email',
      'message',
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
    // Two processes, each with its own queue and sessions.
    const [a, b] = await Promise.all([
      upgradeWorkspaces(new Backend(backend.config)),
      upgradeWorkspaces(new Backend(backend.config)),
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
    await (await adminOf(workspaceId)).query(
      "UPDATE object_types SET name_singular = 'interaction', name_plural = 'interactions' WHERE name_singular = 'visit';",
    );
    forgetCompiledSchema(workspaceId);

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
    const meeting: SchemaOperation = {
      op: 'create_object',
      object: {
        nameSingular: 'meeting',
        namePlural: 'meetings',
        labelSingular: 'Meeting',
        labelPlural: 'Meetings',
        labelField: 'name',
        fields: [{ name: 'name', label: 'Name', type: 'text' }],
      },
    };
    const { workspaceId, key } = await legacyWorkspace('clash', [meeting]);
    const report = await upgradeWorkspaces(owner);
    expect(report).toEqual({
      upgraded: ['clash'],
      conflicts: [
        { workspace: 'clash', element: 'meeting', message: expect.stringContaining('meeting') },
      ],
      failed: [],
    });
    expect(await digestOf(workspaceId)).toBeNull();
    const call = await logCall(key);
    expect(call.status).toBe(201);

    const rename = await api.request('/v1/schema/changes', {
      key,
      body: {
        reason: 'make room',
        operations: [
          {
            op: 'rename_object',
            object: 'meeting',
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
