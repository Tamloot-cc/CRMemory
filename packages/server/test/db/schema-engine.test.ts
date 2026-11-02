import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import type { ApiKeyScope } from '../../src/db/schema.js';
import { inWorkspace } from '../../src/db/tx.js';
import { AppError } from '../../src/errors.js';
import { getSchema } from '../../src/schema-engine/compiled.js';
import { decideSchemaChange, runSchemaChange } from '../../src/schema-engine/engine.js';
import { loadSchemaState } from '../../src/schema-engine/load.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { SchemaValidationError } from '../../src/schema-engine/types.js';
import { applyTemplate } from '../../src/templates/apply.js';
import { createWorkspace, getWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;

const agent: Actor = { type: 'agent', id: 'front-desk' };
const admin: Actor = { type: 'user', id: 'dana' };
const ALL: ApiKeyScope[] = ['read', 'write', 'schema:write', 'admin'];

beforeAll(() => {
  app = db.connect({ role: RUNTIME_ROLE, max: 20 });
});

function change(
  workspaceId: string,
  operations: SchemaOperation[],
  actor: Actor = agent,
  scopes: ApiKeyScope[] = ['schema:write'],
) {
  return inWorkspace(app, workspaceId, (tx) =>
    runSchemaChange(tx, { workspaceId, actor, scopes, operations }),
  );
}

function decide(
  workspaceId: string,
  changeId: string,
  decision: 'approve' | 'reject',
  actor = admin,
) {
  return inWorkspace(app, workspaceId, (tx) =>
    decideSchemaChange(tx, { workspaceId, changeId, actor, scopes: ALL, decision }),
  );
}

function fieldNames(workspaceId: string, object: string) {
  return inWorkspace(app, workspaceId, async (tx) => {
    const state = await loadSchemaState(tx, workspaceId);
    return state.objects
      .find((o) => o.nameSingular === object)
      ?.fields.filter((f) => f.status === 'active')
      .map((f) => f.name);
  });
}

let counter = 0;
const newWorkspace = (template?: string) =>
  createWorkspace(db.owner, { name: `Workspace ${++counter}`, ...(template ? { template } : {}) });

describe('workspace creation', () => {
  it('seeds the base objects through the engine', async () => {
    const workspace = await newWorkspace();
    expect(workspace).toMatchObject({ schemaVersion: 1, templates: [], initializedAt: null });
    expect(await fieldNames(workspace.id, 'person')).toEqual([
      'name',
      'emails',
      'phones',
      'address',
      'jobTitle',
      'company',
      'tasks',
    ]);
    const changes = await db.owner`select status, requested_by from schema_changes
      where workspace_id = ${workspace.id}`;
    expect(changes).toEqual([
      { status: 'applied', requested_by: { type: 'system', id: 'retainer' } },
    ]);
  });

  it('applies a template and records it', async () => {
    const workspace = await newWorkspace('clinic');
    expect(workspace.templates).toEqual([
      { name: 'clinic', version: 1, appliedAt: expect.any(String) },
    ]);
    expect(workspace.initializedAt).not.toBeNull();
    expect(await fieldNames(workspace.id, 'appointment')).toEqual([
      'title',
      'startsAt',
      'type',
      'status',
      'person',
    ]);
  });

  it('leaves nothing behind when the template does not exist', async () => {
    await expect(
      createWorkspace(db.owner, { name: 'Broken', template: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(getWorkspace(db.owner, 'broken')).rejects.toBeInstanceOf(AppError);
  });
});

describe('schema changes', () => {
  let workspaceId: string;
  beforeAll(async () => {
    workspaceId = (await newWorkspace()).id;
  });

  it('applies additive changes requested by an agent', async () => {
    const result = await change(workspaceId, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'nickname', label: 'Nickname', type: 'text' },
      },
    ]);
    expect(result).toMatchObject({ status: 'applied', schemaVersion: 2 });
    expect(result.change?.requestedBy).toEqual(agent);
    expect(await fieldNames(workspaceId, 'person')).toContain('nickname');

    const [field] = await db.owner`select owner from fields where name = 'nickname'
      and workspace_id = ${workspaceId}`;
    expect(field?.owner).toBe('agent');
  });

  it('returns unchanged for a change that changes nothing', async () => {
    const result = await change(workspaceId, [
      { op: 'update_field', object: 'person', field: 'nickname', label: 'Nickname' },
    ]);
    expect(result).toMatchObject({ status: 'unchanged', change: null });
  });

  it('rejects invalid changes with every issue', async () => {
    await expect(
      change(workspaceId, [
        { op: 'create_field', object: 'person', field: { name: 'id', label: 'Id', type: 'text' } },
        { op: 'delete_object', object: 'nothing' },
      ]),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof SchemaValidationError && error.issues.length === 2,
    );
  });

  it('proposes destructive changes from an agent, even with an admin key', async () => {
    const result = await change(
      workspaceId,
      [{ op: 'rename_field', object: 'person', field: 'nickname', name: 'alias' }],
      agent,
      ALL,
    );
    expect(result.status).toBe('proposed');
    expect(result.change?.isDestructive).toBe(true);
    expect(await fieldNames(workspaceId, 'person')).toContain('nickname');

    const approved = await decide(workspaceId, result.change?.id as string, 'approve');
    expect(approved.status).toBe('applied');
    expect(approved.change?.decidedBy).toEqual(admin);
    expect(await fieldNames(workspaceId, 'person')).toContain('alias');
  });

  it('applies destructive changes from a user with admin scope directly', async () => {
    const result = await change(
      workspaceId,
      [{ op: 'rename_field', object: 'person', field: 'alias', name: 'nickname' }],
      admin,
      ALL,
    );
    expect(result.status).toBe('applied');
  });

  it('proposes destructive changes from a user without admin scope', async () => {
    const result = await change(
      workspaceId,
      [{ op: 'delete_field', object: 'person', field: 'nickname' }],
      admin,
      ['schema:write'],
    );
    expect(result.status).toBe('proposed');
    const rejected = await decide(workspaceId, result.change?.id as string, 'reject');
    expect(rejected.status).toBe('rejected');
    expect(await fieldNames(workspaceId, 'person')).toContain('nickname');
  });

  it('marks an approval failed when the change no longer validates', async () => {
    const proposed = await change(workspaceId, [
      { op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' },
    ]);
    await change(
      workspaceId,
      [{ op: 'delete_field', object: 'person', field: 'jobTitle' }],
      admin,
      ALL,
    );
    const result = await decide(workspaceId, proposed.change?.id as string, 'approve');
    expect(result.status).toBe('failed');
    expect(result.change?.error).toContain('unknown field');
  });

  it('lets only a user with admin scope decide', async () => {
    const proposed = await change(workspaceId, [
      { op: 'delete_field', object: 'person', field: 'nickname' },
    ]);
    await expect(
      decide(workspaceId, proposed.change?.id as string, 'approve', agent),
    ).rejects.toMatchObject({
      status: 403,
    });
    await decide(workspaceId, proposed.change?.id as string, 'reject');
    await expect(
      decide(workspaceId, proposed.change?.id as string, 'approve'),
    ).rejects.toMatchObject({
      code: 'already_decided',
    });
  });

  it('serializes concurrent changes in one workspace', async () => {
    const before = (await getWorkspace(db.owner, workspaceId)).schemaVersion;
    const names = Array.from({ length: 10 }, (_, i) => `concurrent${i}`);
    const results = await Promise.all(
      names.map((name) =>
        change(workspaceId, [
          { op: 'create_field', object: 'company', field: { name, label: name, type: 'text' } },
        ]),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(names.map(() => 'applied'));
    expect(results.map((r) => r.schemaVersion).sort((a, b) => a - b)).toEqual(
      names.map((_, i) => before + i + 1),
    );
    expect(await fieldNames(workspaceId, 'company')).toEqual(expect.arrayContaining(names));
  });

  it('caches the compiled schema per schema version', async () => {
    const first = await inWorkspace(app, workspaceId, (tx) => getSchema(tx, workspaceId));
    const again = await inWorkspace(app, workspaceId, (tx) => getSchema(tx, workspaceId));
    expect(again).toBe(first);
    await change(workspaceId, [
      {
        op: 'create_field',
        object: 'task',
        field: { name: 'priority', label: 'P', type: 'number' },
      },
    ]);
    const after = await inWorkspace(app, workspaceId, (tx) => getSchema(tx, workspaceId));
    expect(after.version).toBe(first.version + 1);
    expect(after.objectsByName.get('task')?.fieldsByName.has('priority')).toBe(true);
  });
});

describe('templates', () => {
  const apply = (workspaceId: string, name: string, actor: Actor = agent) =>
    inWorkspace(app, workspaceId, (tx) =>
      applyTemplate(tx, { workspaceId, actor, scopes: ['schema:write'], name }),
    );

  it('applies without approval, as owner system, and only once', async () => {
    const { id } = await newWorkspace();
    const first = await apply(id, 'sales');
    expect(first).toMatchObject({ status: 'applied', alreadyApplied: false });
    const [deal] = await db.owner`select owner from object_types
      where workspace_id = ${id} and name_singular = 'deal'`;
    expect(deal?.owner).toBe('system');

    const second = await apply(id, 'sales');
    expect(second).toMatchObject({ status: 'unchanged', alreadyApplied: true });
    expect((await getWorkspace(db.owner, id)).templates.map((t) => t.name)).toEqual(['sales']);
  });

  it('can add a second template later', async () => {
    const { id } = await newWorkspace('services');
    await apply(id, 'recruiting');
    const workspace = await getWorkspace(db.owner, id);
    expect(workspace.templates.map((t) => t.name)).toEqual(['services', 'recruiting']);
    expect(await fieldNames(id, 'company')).toEqual(
      expect.arrayContaining(['projects', 'proposals', 'jobs']),
    );
  });

  it('marks the workspace initialized with blank and adds nothing', async () => {
    const { id, schemaVersion } = await newWorkspace();
    await apply(id, 'blank');
    const workspace = await getWorkspace(db.owner, id);
    expect(workspace.initializedAt).not.toBeNull();
    expect(workspace.schemaVersion).toBe(schemaVersion);
  });

  it('fails on collisions with custom names and applies nothing', async () => {
    const { id } = await newWorkspace();
    await change(id, [
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'industry', label: 'I', type: 'text' },
      },
    ]);
    const before = await getWorkspace(db.owner, id);
    await expect(apply(id, 'sales')).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SchemaValidationError &&
        error.issues.some((i) => i.path === 'company.industry'),
    );
    const after = await getWorkspace(db.owner, id);
    expect(after).toEqual(before);
    expect(await fieldNames(id, 'deal')).toBeUndefined();
  });
});
