import { describe, expect, it } from 'vitest';
import { acquireLease, type Lease, LeaseHeldError } from '../../src/db/lease.js';
import { bootstrap } from '../../src/operator/bootstrap.js';
import { runCli } from '../../src/operator/commands.js';
import { startTestApp } from '../helpers/app.js';
import { createTestBackend, useTestBackend } from '../helpers/backend.js';

const backend = useTestBackend();

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    backend: () => backend,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('retainer workspace', () => {
  it('creates a workspace with a template and lists it', async () => {
    const created = await cli(
      'workspace',
      'create',
      '--name',
      'Acme Clinic',
      '--template',
      'clinic',
    );
    expect(created.code).toBe(0);
    expect(created.out).toContain('slug: acme-clinic');
    expect(created.out).toContain('template: clinic');

    const listed = await cli('workspace', 'list', '--json');
    expect(JSON.parse(listed.out)).toEqual([
      expect.objectContaining({
        slug: 'acme-clinic',
        templates: [expect.objectContaining({ name: 'clinic' })],
      }),
    ]);
  });

  it('reports bad input with a non-zero exit code', async () => {
    const unknownTemplate = await cli(
      'workspace',
      'create',
      '--name',
      'X',
      '--template',
      'dentist',
    );
    expect(unknownTemplate.code).toBe(1);
    expect(unknownTemplate.err).toContain('template "dentist" not found');
    expect(unknownTemplate.err).toContain('Templates: sales, services');

    const duplicate = await cli('workspace', 'create', '--name', 'Acme Clinic');
    expect(duplicate).toMatchObject({ code: 1, err: expect.stringContaining('already exists') });

    expect((await cli('workspace', 'create')).err).toContain('missing --name');
    expect((await cli('frobnicate')).code).toBe(2);
    expect((await cli('--help')).code).toBe(0);
  });
});

describe('retainer key', () => {
  it('creates a key that authenticates as its actor, then revokes it', async () => {
    const created = await cli(
      'key',
      'create',
      '--workspace',
      'acme-clinic',
      '--name',
      'Front-desk agent',
      '--actor',
      'agent:front-desk',
      '--scopes',
      'read,write,schema:write',
      '--json',
    );
    expect(created.code).toBe(0);
    const key = JSON.parse(created.out);
    expect(key).toMatchObject({
      actor: { type: 'agent', id: 'front-desk' },
      scopes: ['read', 'write', 'schema:write'],
      key: expect.stringMatching(/^rtn_/),
    });

    const { request } = startTestApp(backend);
    const schema = await request('/v1/schema', { key: key.key });
    expect(schema.status).toBe(200);
    expect(schema.body.workspace.slug).toBe('acme-clinic');

    const listed = await cli('key', 'list', '--workspace', 'acme-clinic');
    expect(listed.out).toContain('Front-desk agent');
    expect(listed.out).not.toContain(key.key);

    expect((await cli('key', 'revoke', key.id)).code).toBe(0);
    expect((await request('/v1/schema', { key: key.key })).status).toBe(401);
  });

  it('prints the key once in human output', async () => {
    const created = await cli(
      'key',
      'create',
      '--workspace',
      'acme-clinic',
      '--name',
      'Human',
      '--actor',
      'user:dana',
      '--scopes',
      'admin',
    );
    expect(created.out).toMatch(/\n {2}rtn_[0-9A-Za-z]{43}\n/);
    expect(created.out).toContain('shown once');
  });

  it('validates actor, scopes and workspace', async () => {
    const base = ['key', 'create', '--name', 'k'];
    expect(
      (await cli(...base, '--workspace', 'acme-clinic', '--actor', 'bot', '--scopes', 'read')).err,
    ).toContain('type:id');
    expect(
      (await cli(...base, '--workspace', 'acme-clinic', '--actor', 'agent:x', '--scopes', 'root'))
        .err,
    ).toContain('scopes must be');
    expect(
      (await cli(...base, '--workspace', 'nope', '--actor', 'agent:x', '--scopes', 'read')).err,
    ).toContain('not found');
    expect((await cli('key', 'revoke', 'not-a-key')).code).toBe(1);
  });
});

describe('first boot', () => {
  it('creates one default workspace and an admin key, once, even concurrently', async () => {
    const fresh = await createTestBackend();
    const leases: Lease[] = [];
    try {
      // The advisory lock is replaced by the process lease (spec sections 9 and 13): of
      // four processes starting at once, one holds it and boots; the others refuse to start.
      const processes = Array.from({ length: 4 }, () => fresh.another());
      const acquired = await Promise.allSettled(
        processes.map((p, i) => acquireLease(p, { holder: `boot-${i}`, heartbeatMs: 60_000 })),
      );
      const holders = processes.filter((_, i) => acquired[i]?.status === 'fulfilled');
      for (const a of acquired) if (a.status === 'fulfilled') leases.push(a.value);
      const results = await Promise.allSettled(holders.map((p) => bootstrap(p)));
      expect(acquired.filter((a) => a.status === 'rejected').map((a) => a.reason)).toEqual(
        Array.from({ length: 3 }, () => expect.any(LeaseHeldError)),
      );
      expect(holders).toHaveLength(1);
      const boots = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
      expect(boots).toHaveLength(1);
      expect(boots[0]?.workspaceSlug).toBe('default');

      const workspaces = await fresh.adminCatalog().rows('SELECT slug FROM workspaces;');
      expect(workspaces).toEqual([{ slug: 'default' }]);
      expect(await bootstrap(fresh.another())).toBeNull();

      // The admin key is a user with every scope, so it can approve schema changes.
      const app = startTestApp(fresh);
      const proposal = await app.request('/v1/schema/changes', {
        key: boots[0]?.key as string,
        body: { operations: [{ op: 'delete_field', object: 'person', field: 'jobTitle' }] },
      });
      expect(proposal.body.status).toBe('applied');
    } finally {
      await Promise.all(leases.map((lease) => lease.release()));
      await fresh.drop();
    }
  });
});
