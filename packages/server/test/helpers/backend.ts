import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, inject } from 'vitest';
import { parseSigningKeys } from '../../src/db/access.js';
import { Backend } from '../../src/db/backend.js';
import { ensureCatalog } from '../../src/db/provision.js';
import { ident } from '../../src/db/surreal.js';
import { installUpgrader } from '../../src/workspaces/upgrade.js';

declare module 'vitest' {
  interface ProvidedContext {
    surrealUrl: string;
    surrealVersion: string;
    /** `id:base64(PEM)` entries generated once per run. */
    signingKeys: string[];
  }
}

export type TestBackend = Backend & {
  /** A second backend on the same namespace: a separate process's sessions. */
  another: (options?: { keys?: string[] }) => Backend;
  drop: () => Promise<void>;
};

export function testBackendConfig(namespace: string, keys?: { current: string; previous?: string }) {
  const [current, previous] = inject('signingKeys');
  return {
    url: inject('surrealUrl'),
    namespace,
    admin: {
      user: process.env.RETAINER_SURREAL_USER ?? 'root',
      pass: process.env.RETAINER_SURREAL_PASS ?? 'retainer',
      level: 'root' as const,
    },
    signingKeys: parseSigningKeys(keys ?? { current: current as string }),
    spareKey: previous as string,
  };
}

/** A backend on a fresh namespace with its catalog; dropped by `drop`. */
export async function createTestBackend(): Promise<TestBackend> {
  const namespace = `rt_test_${randomBytes(6).toString('hex')}`;
  const { spareKey: _spare, ...config } = testBackendConfig(namespace);
  const backend = new Backend(config) as TestBackend;
  installUpgrader(backend);
  await ensureCatalog(backend);
  backend.another = (options) => {
    const other = new Backend(
      options?.keys
        ? {
            ...config,
            signingKeys: parseSigningKeys({
              current: options.keys[0] as string,
              ...(options.keys.length > 1 ? { previous: options.keys.slice(1).join(',') } : {}),
            }),
          }
        : config,
    );
    installUpgrader(other);
    return other;
  };
  backend.drop = async () => {
    await backend.adminNamespace().query(`REMOVE NAMESPACE IF EXISTS ${ident(namespace)};`);
  };
  return backend;
}

/** Gives the test file a fresh namespace, created before its tests and removed after. */
export function useTestBackend(): TestBackend {
  const holder = {} as { backend?: TestBackend };
  const proxy = new Proxy({} as TestBackend, {
    get(_target, property) {
      if (!holder.backend) throw new Error('the test backend is not ready yet');
      const value = Reflect.get(holder.backend, property, holder.backend);
      return typeof value === 'function' ? value.bind(holder.backend) : value;
    },
    set(_target, property, value) {
      if (!holder.backend) throw new Error('the test backend is not ready yet');
      return Reflect.set(holder.backend, property, value, holder.backend);
    },
  });
  beforeAll(async () => {
    holder.backend = await createTestBackend();
  });
  afterAll(async () => {
    await holder.backend?.drop();
  });
  return proxy;
}
