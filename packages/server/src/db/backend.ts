import { AppError } from '../errors.js';
import { acceptedKeys, type SigningKey, type SigningKeys, signAccessToken } from './access.js';
import { CATALOG_DATABASE } from './names.js';
import { WriteQueues } from './queue.js';
import {
  type QueryOptions,
  query,
  rawQuery,
  type StatementResult,
  type SurrealTarget,
  systemTokenSource,
  type TokenSource,
} from './surreal.js';

/**
 * How Retainer reaches SurrealDB (spec sections 4 and 9): one namespace, a
 * catalog database and one database per workspace. The administrative
 * client (a configured system user) defines and provisions; runtime reads
 * and writes use record-access tokens Retainer signs, confined to one
 * database each.
 */

export type SurrealConfig = {
  url: string;
  namespace: string;
  /** System credential for definitions and provisioning (never for runtime data). */
  admin: { user: string; pass: string; level: 'root' | 'namespace' };
  signingKeys: SigningKeys;
};

/** A workspace's route, from the catalog: never from the request. */
export type WorkspaceRoute = {
  workspaceId: string;
  database: string;
  /** The newest accepted signing key the workspace database has. */
  keyId: string;
};

/** A database handle: run statements against one database. */
export type Db = {
  readonly target: SurrealTarget;
  /** Every statement must succeed; returns each statement's result. */
  query(text: string, vars?: Record<string, unknown>, options?: QueryOptions): Promise<unknown[]>;
  /** One statement's rows. */
  rows<T>(text: string, vars?: Record<string, unknown>): Promise<T[]>;
  /** Raw per-statement results. */
  raw(
    text: string,
    vars?: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<StatementResult[]>;
};

export function dbOf(target: SurrealTarget): Db {
  return {
    target,
    query: (text, vars, options) => query(target, text, vars, options),
    rows: async <T>(text: string, vars?: Record<string, unknown>) => {
      const results = await query(target, text, vars);
      const last = results.at(-1);
      return (Array.isArray(last) ? last : last === undefined || last === null ? [] : [last]) as T[];
    },
    raw: (text, vars, options) => rawQuery(target, text, vars, options),
  };
}

export class Backend {
  readonly queues = new WriteQueues();
  private readonly adminToken: TokenSource;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly routes = new Map<string, WorkspaceRoute>();
  /** Workspaces brought up to date since this process started. */
  readonly upgraded = new Set<string>();
  /** Set by the server: brings one workspace up to date before its first request. */
  upgradeWorkspace?: (workspaceId: string) => Promise<void>;
  /** False once the process lease is lost: no new writes are admitted (section 9). */
  writable = true;

  constructor(readonly config: SurrealConfig) {
    this.adminToken = systemTokenSource(config.url, {
      user: config.admin.user,
      pass: config.admin.pass,
      ...(config.admin.level === 'namespace' ? { namespace: config.namespace } : {}),
    });
  }

  get keys(): SigningKeys {
    return this.config.signingKeys;
  }

  /** Namespace-level administrative statements (DEFINE DATABASE …). */
  adminNamespace(): Db {
    return dbOf({ url: this.config.url, namespace: this.config.namespace, token: this.adminToken });
  }

  /** Administrative statements in one database: definitions and provisioning only. */
  adminDb(database: string): Db {
    return dbOf({
      url: this.config.url,
      namespace: this.config.namespace,
      database,
      token: this.adminToken,
    });
  }

  /** A record-access session confined to one database. */
  runtimeDb(database: string, keyId: string): Db {
    const key = acceptedKeys(this.keys).find((k) => k.id === keyId);
    if (!key) throw new Error(`signing key ${keyId} is not configured`);
    return dbOf({
      url: this.config.url,
      namespace: this.config.namespace,
      database,
      token: async (refresh) => this.token(key, database, refresh),
    });
  }

  private token(key: SigningKey, database: string, refresh: boolean): string {
    const cacheKey = `${database}\n${key.id}`;
    const cached = this.tokens.get(cacheKey);
    if (!refresh && cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    const signed = signAccessToken(key, { namespace: this.config.namespace, database });
    this.tokens.set(cacheKey, signed);
    return signed.token;
  }

  /** The catalog through the runtime session: key lookup, routes and the lease. */
  catalog(): Db {
    return this.runtimeDb(CATALOG_DATABASE, this.keys.current.id);
  }

  adminCatalog(): Db {
    return this.adminDb(CATALOG_DATABASE);
  }

  /**
   * A workspace's route. Requests for a workspace this process has not
   * upgraded yet trigger its upgrade first (section 7).
   */
  async route(workspaceId: string, options: { provisioning?: boolean } = {}): Promise<WorkspaceRoute> {
    if (!options.provisioning && !this.upgraded.has(workspaceId) && this.upgradeWorkspace) {
      await this.upgradeWorkspace(workspaceId);
    }
    const cached = this.routes.get(workspaceId);
    if (cached) return cached;
    const [row] = await this.catalog().rows<{
      database: string;
      state: string;
      access_keys: string[];
    }>('SELECT database, state, access_keys FROM type::record("workspaces", $id);', {
      id: workspaceId,
    });
    if (!row || (row.state !== 'active' && !(options.provisioning && row.state === 'provisioning'))) {
      throw new AppError(401, 'unauthorized', 'workspace is unavailable');
    }
    const keyId = acceptedKeys(this.keys)
      .map((k) => k.id)
      .find((id) => row.access_keys.includes(id));
    if (!keyId) {
      throw new AppError(503, 'workspace_upgrading', 'the workspace is being upgraded; retry', {
        retryable: true,
      });
    }
    const route = { workspaceId, database: row.database, keyId };
    if (row.state === 'active') this.routes.set(workspaceId, route);
    return route;
  }

  /** Forgets a cached route, after an upgrade changed its keys. */
  forgetRoute(workspaceId: string): void {
    this.routes.delete(workspaceId);
  }

  /** Runtime reads and writes for one workspace. */
  async workspace(workspaceId: string, options: { provisioning?: boolean } = {}): Promise<Db> {
    const route = await this.route(workspaceId, options);
    return this.runtimeDb(route.database, route.keyId);
  }

  /** Administrative access to one workspace database (definitions only). */
  async workspaceAdmin(workspaceId: string, options: { provisioning?: boolean } = {}): Promise<Db> {
    const route = await this.route(workspaceId, options);
    return this.adminDb(route.database);
  }
}
