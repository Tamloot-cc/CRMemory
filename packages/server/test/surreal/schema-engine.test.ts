import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Backend } from '../../src/db/backend.js';
import { RecordId } from '../../src/db/cbor.js';
import { readWorkspace } from '../../src/db/protocol.js';
import type { ApiKeyScope } from '../../src/db/types.js';
import { AppError } from '../../src/errors.js';
import { logEventFor } from '../../src/memory/service.js';
import { createRecord, readRecord } from '../../src/records/service.js';
import { decideSchemaChange, runSchemaChange } from '../../src/schema-engine/engine.js';
import { loadSchemaState } from '../../src/schema-engine/load.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { SchemaValidationError } from '../../src/schema-engine/types.js';
import { applyTemplate } from '../../src/templates/apply.js';
import { createWorkspace, getWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();
let other: Backend;

const agent: Actor = { type: 'agent', id: 'front-desk' };
const admin: Actor = { type: 'user', id: 'dana' };
const ALL: ApiKeyScope[] = ['read', 'write', 'schema:write', 'admin'];

beforeAll(() => {
  other = backend.another();
});

function change(
  workspaceId: string,
  operations: SchemaOperation[],
  actor: Actor = agent,
  scopes: ApiKeyScope[] = ['schema:write'],
  process: Backend = backend,
) {
  return runSchemaChange(process, { workspaceId, actor, scopes, operations });
}

function decide(
  workspaceId: string,
  changeId: string,
  decision: 'approve' | 'reject',
  actor = admin,
) {
  return decideSchemaChange(backend, { workspaceId, changeId, actor, scopes: ALL, decision });
}

async function fieldNames(workspaceId: string, object: string) {
  const state = await loadSchemaState(await backend.workspace(workspaceId));
  return state.objects
    .find((o) => o.nameSingular === object)
    ?.fields.filter((f) => f.status === 'active')
    .map((f) => f.name);
}

const schemaOf = (workspaceId: string) =>
  readWorkspace(backend, workspaceId, ({ schema }) => schema());

let counter = 0;
const newWorkspace = (template?: string) =>
  createWorkspace(backend, { name: `Workspace ${++counter}`, ...(template ? { template } : {}) });

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
    const db = await backend.workspace(workspace.id);
    const changes = await db.rows('SELECT status, requested_by FROM schema_changes;');
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
      createWorkspace(backend, { name: 'Broken', template: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(getWorkspace(backend, 'broken')).rejects.toBeInstanceOf(AppError);
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

    const db = await backend.workspace(workspaceId);
    const [field] = await db.rows<{ owner: string }>(
      "SELECT owner FROM fields WHERE name = 'nickname';",
    );
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

  // needs views/service.ts (read-side port in progress): deleting a field repairs saved views.
  it.skip('marks an approval failed when the change no longer validates', async () => {
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
    const before = (await getWorkspace(backend, workspaceId)).schemaVersion;
    const names = Array.from({ length: 10 }, (_, i) => `concurrent${i}`);
    const results = await Promise.all(
      names.map((name, i) =>
        change(
          workspaceId,
          [{ op: 'create_field', object: 'company', field: { name, label: name, type: 'text' } }],
          agent,
          ['schema:write'],
          i % 2 === 0 ? backend : other,
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(names.map(() => 'applied'));
    expect(results.map((r) => r.schemaVersion).sort((a, b) => a - b)).toEqual(
      names.map((_, i) => before + i + 1),
    );
    expect(await fieldNames(workspaceId, 'company')).toEqual(expect.arrayContaining(names));
  });

  it('caches the compiled schema per schema version', async () => {
    const first = await schemaOf(workspaceId);
    const again = await schemaOf(workspaceId);
    expect(again).toBe(first);
    await change(workspaceId, [
      {
        op: 'create_field',
        object: 'task',
        field: { name: 'priority', label: 'P', type: 'number' },
      },
    ]);
    const after = await schemaOf(workspaceId);
    expect(after.version).toBe(first.version + 1);
    expect(after.objectsByName.get('task')?.fieldsByName.has('priority')).toBe(true);
  });
});

describe('templates', () => {
  const apply = (workspaceId: string, name: string, actor: Actor = agent) =>
    applyTemplate(backend, { workspaceId, actor, scopes: ['schema:write'], name });

  it('applies without approval, as owner system, and only once', async () => {
    const { id } = await newWorkspace();
    const first = await apply(id, 'sales');
    expect(first).toMatchObject({ status: 'applied', alreadyApplied: false });
    const db = await backend.workspace(id);
    const [deal] = await db.rows<{ owner: string }>(
      "SELECT owner FROM object_types WHERE name_singular = 'deal';",
    );
    expect(deal?.owner).toBe('system');

    const second = await apply(id, 'sales');
    expect(second).toMatchObject({ status: 'unchanged', alreadyApplied: true });
    expect((await getWorkspace(backend, id)).templates.map((t) => t.name)).toEqual(['sales']);
  });

  it('can add a second template later', async () => {
    const { id } = await newWorkspace('services');
    await apply(id, 'recruiting');
    const workspace = await getWorkspace(backend, id);
    expect(workspace.templates.map((t) => t.name)).toEqual(['services', 'recruiting']);
    expect(await fieldNames(id, 'company')).toEqual(
      expect.arrayContaining(['projects', 'proposals', 'jobs']),
    );
  });

  it('marks the workspace initialized with blank and adds nothing', async () => {
    const { id, schemaVersion } = await newWorkspace();
    await apply(id, 'blank');
    const workspace = await getWorkspace(backend, id);
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
    const before = await getWorkspace(backend, id);
    await expect(apply(id, 'sales')).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SchemaValidationError &&
        error.issues.some((i) => i.path === 'company.industry'),
    );
    const after = await getWorkspace(backend, id);
    expect(after).toEqual(before);
    expect(await fieldNames(id, 'deal')).toBeUndefined();
  });
});

describe('event types', () => {
  it('seeds the base event types, and hides the internal-note type from the schema', async () => {
    const { id } = await newWorkspace();
    const schema = await schemaOf(id);
    const events = [...schema.objectsByName.values()].filter((o) => o.isEvent);
    expect(events.map((o) => o.name).sort()).toEqual([
      'call',
      'email',
      'meeting',
      'message',
      'note',
    ]);
    expect(schema.eventTypeIds).toHaveLength(5);
    expect(schema.internalNote).toBeDefined();
    expect(schema.visibleObjectIds).not.toContain(schema.internalNote?.id);
  });

  it('creates an event type with class "event" and its core fields', async () => {
    const { id } = await newWorkspace();
    const result = await change(id, [
      {
        op: 'create_object',
        object: {
          nameSingular: 'payment',
          namePlural: 'payments',
          labelSingular: 'Payment',
          labelPlural: 'Payments',
          class: 'event',
          fields: [{ name: 'amount', label: 'Amount', type: 'money' }],
        },
      },
    ]);
    expect(result.status).toBe('applied');
    expect(await fieldNames(id, 'payment')).toEqual(['title', 'summary', 'amount']);
  });

  it('deletes an event type through the event deletion lifecycle, atomically', async () => {
    const { id } = await newWorkspace();
    const caller = { workspaceId: id, actor: agent, scopes: ['read', 'write'] as ApiKeyScope[] };
    const call = await logEventFor(backend, caller, {
      type: 'call',
      channel: 'zoom',
      externalId: 'z-1',
      occurredAt: '2026-10-01T10:00:00Z',
      title: 'Renewal call',
      fields: {},
      participants: [],
      about: [],
    });
    const person = await createRecord(
      backend,
      caller,
      'person',
      { emails: 'dana@acme.com', jobTitle: 'CTO' },
      { source: call.id },
    );
    expect(person.record.fields.jobTitle).toBe('CTO');

    const result = await change(id, [{ op: 'delete_object', object: 'call' }], admin, ALL);
    expect(result.status).toBe('applied');

    // The call is deleted with its type, and what it was cited for no longer counts.
    const db = await backend.workspace(id);
    const [row] = await db.rows<{ deleted_at?: Date | null }>('SELECT deleted_at FROM $dir;', {
      dir: new RecordId('record_directory', call.id),
    });
    expect(row?.deleted_at ?? null).not.toBeNull();
    const after = await readRecord(backend, caller, person.id);
    expect(after.fields.jobTitle ?? null).toBeNull();
    const statuses = await db.rows<{ status: string }>(
      'SELECT status FROM field_assertions WHERE record = $record AND source = $source;',
      { record: person.id, source: call.id },
    );
    // Both values (emails and jobTitle) cited the call.
    expect(statuses.map((s) => s.status)).toEqual(['retracted', 'retracted']);
  });
});
