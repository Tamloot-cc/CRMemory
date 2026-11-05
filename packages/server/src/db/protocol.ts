import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import type { CompiledSchema } from '../schema-engine/compiled.js';
import { loadCompiledSchema } from '../schema-engine/compiled.js';
import type { Backend, Db } from './backend.js';
import { RecordId } from './cbor.js';
import { schemaBusy } from './queue.js';
import {
  ident,
  isRetryableConflict,
  type StatementResult,
  SurrealError,
  SurrealTimeoutError,
  thrownCode,
  thrownDetail,
  uniqueIndexViolation,
} from './surreal.js';

/**
 * The write protocol (spec section 6): queue, read the revision, plan in
 * TypeScript, commit one explicit transaction that verifies the revision,
 * increments it, writes every effect with an affected-record check and the
 * operation receipt, and retries from a fresh plan on a recognized conflict.
 */

export type AppliedTemplate = { name: string; version: number; appliedAt: string };

export type WorkspaceSettings = {
  /** Agent assertions below this confidence wait for review (rule 2.3). */
  confidenceThreshold?: number;
};

export type WorkspaceState = {
  workspace_id: string;
  revision: number;
  schema_version: number;
  mode: 'active' | 'schema_update';
  schema_change?: string | null;
  plan?: unknown;
  fixed_revision: number;
  definitions_digest?: string | null;
  access_keys: string[];
  settings: WorkspaceSettings;
  templates: AppliedTemplate[];
  initialized_at?: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const MAX_ATTEMPTS = 5;
/** Completed receipts are kept this long (section 7). */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A process-wide clock that never repeats or goes backwards, so assertions
 * written in one millisecond still order by `created_at` (rule 2.2).
 */
let lastTick = 0;
export function serverNow(): Date {
  const now = Math.max(Date.now(), lastTick + 1);
  lastTick = now;
  return new Date(now);
}

/** A record ID in a table whose name is fixed in code. */
const rec = (batch: Batch, table: string, id: string) =>
  `type::record(${batch.v(table)}, ${batch.v(id)})`;

/** Statements committed together; every write checks how many records it affected. */
export class Batch {
  readonly statements: string[] = [];
  readonly vars: Record<string, unknown> = {};
  private n = 0;
  private checks = 0;

  /** A parameter placeholder for a caller or computed value (never interpolated). */
  v(value: unknown): string {
    const name = `v${this.n++}`;
    this.vars[name] = value;
    return `$${name}`;
  }

  get size(): number {
    return this.statements.length;
  }

  /**
   * A write statement returning the affected records. `expect` is their
   * exact number; `{ min }` a lower bound, for cleanups whose extent the
   * plan cannot know exactly.
   */
  write(statement: string, expect: number | { min: number; max?: number }, label = 'write'): void {
    const check = `e${this.checks++}`;
    const condition =
      typeof expect === 'number'
        ? `array::len($${check}) != ${expect}`
        : `array::len($${check}) < ${expect.min}${
            expect.max === undefined ? '' : ` OR array::len($${check}) > ${expect.max}`
          }`;
    this.statements.push(
      `LET $${check} = (${statement.replace(/;\s*$/, '')});`,
      `IF ${condition} { THROW 'retainer:effect:${label.replace(/[^a-z0-9_]/gi, '_')}' };`,
    );
  }

  /** A statement with no effect to check (LET, DEFINE, a guard). */
  plain(statement: string): void {
    this.statements.push(statement.trim().endsWith(';') ? statement.trim() : `${statement};`);
  }

  /** Fails the commit unless `condition` holds (e.g. a precondition read in the plan). */
  guard(condition: string, code: string): void {
    this.plain(`IF !(${condition}) { THROW 'retainer:${code}' }`);
  }

  create(table: string, id: string, content: Record<string, unknown>): void {
    this.write(`CREATE ${rec(this, table, id)} CONTENT ${this.v(content)} RETURN id`, 1, table);
  }

  /** Inserts many rows of one table: one statement, one check. */
  insert(table: string, rows: Array<Record<string, unknown> & { id: string }>): void {
    if (rows.length === 0) return;
    const content = rows.map(({ id, ...rest }) => ({ ...rest, id: new RecordId(table, id) }));
    this.write(`INSERT INTO ${ident(table)} ${this.v(content)} RETURN id`, rows.length, table);
  }

  /**
   * Sets fields on one existing record; `undefined` values become NONE (the
   * field is removed). Field names come from code or validated metadata.
   */
  update(table: string, id: string, set: Record<string, unknown>, label = table): void {
    const assignments = Object.entries(set).map(
      ([field, value]) =>
        `${field.split('.').map(ident).join('.')} = ${value === undefined ? 'NONE' : this.v(value)}`,
    );
    if (assignments.length === 0) return;
    this.write(
      `UPDATE ${rec(this, table, id)} SET ${assignments.join(', ')} RETURN id`,
      1,
      label,
    );
  }

  /** Creates or replaces one record's content. */
  upsert(table: string, id: string, content: Record<string, unknown>): void {
    this.write(`UPSERT ${rec(this, table, id)} CONTENT ${this.v(content)} RETURN id`, 1, table);
  }

  delete(table: string, id: string): void {
    this.write(`DELETE ${rec(this, table, id)} RETURN BEFORE`, 1, table);
  }

  /** Deletes the listed records of one table; each must exist. */
  deleteIds(table: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    this.write(
      `DELETE ${this.v(unique.map((id) => new RecordId(table, id)))} RETURN BEFORE`,
      unique.length,
      table,
    );
  }
}

/** One attempt at a mutation: the planning snapshot and the batch it builds. */
export class Operation {
  readonly batch = new Batch();
  /** The administrative session, for operations that define (sections 4, 7). */
  admin?: Db;
  /**
   * What this plan has already decided, by module: later steps of one
   * operation read through it, since nothing is written until the commit.
   */
  readonly cache = new Map<string, unknown>();
  private readonly afterCommit: Array<() => void> = [];
  private schemaCache?: CompiledSchema;

  constructor(
    readonly id: string,
    readonly attempt: number,
    readonly workspaceId: string,
    readonly db: Db,
    readonly state: WorkspaceState,
    /** Server time for this operation, the same on every attempt. */
    readonly now: Date,
    private readonly ids: string[],
    private idCursor = 0,
  ) {}

  /** A new UUID, the same on every attempt of this operation (by call order). */
  newId(): string {
    if (this.idCursor < this.ids.length) return this.ids[this.idCursor++] as string;
    const id = randomUUID();
    this.ids.push(id);
    this.idCursor++;
    return id;
  }

  /** A distinct, increasing timestamp within this operation, stable across attempts. */
  tick(): Date {
    return new Date(this.now.getTime() + this.idCursor);
  }

  /** The published schema this plan validates against. */
  async schema(): Promise<CompiledSchema> {
    this.schemaCache ??= await loadCompiledSchema(
      this.db,
      this.workspaceId,
      this.state.schema_version,
    );
    return this.schemaCache;
  }

  /** One statement's rows, read now (not inside the commit). */
  rows<T>(text: string, vars?: Record<string, unknown>): Promise<T[]> {
    return this.db.rows<T>(text, vars);
  }

  /** Runs once the commit succeeded (cache invalidation and the like). */
  onCommit(fn: () => void): void {
    this.afterCommit.push(fn);
  }

  committed(): void {
    for (const fn of this.afterCommit) fn();
  }
}

export type MutationInput<T> = {
  /** The operation kind, e.g. `upsert_record`; scopes idempotency keys. */
  kind: string;
  /** A caller's idempotency key: replays the original result (section 7). */
  idempotencyKey?: string;
  /** Hashed to detect a key reused with a different request. */
  requestHash?: string;
  /** Commit through the administrative client: definitions (sections 4, 7). */
  admin?: boolean;
  /** For the schema runner's own steps while the workspace is paused. */
  allowSchemaUpdate?: boolean;
  /** Plan: read what the mutation needs, then add its effects to `op.batch`. */
  plan: (op: Operation) => Promise<T>;
  /** Public IDs the result refers to, so erasure can sanitize the receipt. */
  refs?: (result: T) => string[];
  /** What the receipt stores; the result itself by default. */
  receipt?: (result: T) => unknown;
  /** Skip the receipt (internal maintenance writes). */
  noReceipt?: boolean;
  /** Workspace creation, before the workspace is active (section 4). */
  provisioning?: boolean;
};

export type MutationOutcome<T> = { result: T; operationId: string; replayed: boolean };

/** Thrown by a plan when it found nothing to do: commit nothing, return `value`. */
export class NoChange<T> {
  constructor(readonly value: T) {}
}

export async function readState(db: Db): Promise<WorkspaceState> {
  const [state] = await db.rows<WorkspaceState>('SELECT * FROM ONLY workspace_state:current;');
  if (!state) throw new AppError(503, 'workspace_unavailable', 'the workspace is not provisioned');
  return state;
}

type Receipt = {
  id: unknown;
  kind: string;
  request_hash?: string | null;
  status: string;
  result: unknown;
  expires_at: Date;
};

function receiptReplay(receipt: Receipt, requestHash: string | undefined): unknown {
  if (requestHash !== undefined && receipt.request_hash !== requestHash) {
    throw new AppError(
      422,
      'idempotency_key_reused',
      'this Idempotency-Key was used for a different request',
    );
  }
  if (receipt.status === 'erased') {
    throw new AppError(
      410,
      'result_erased',
      'the original result of this request was erased by a privacy request',
    );
  }
  return receipt.result;
}

/** Classifies a failed commit: retry from a fresh plan, or fail. */
function classify(results: StatementResult[]): {
  retry: boolean;
  error: Error;
} {
  const failures = results.filter(
    (r): r is Extract<StatementResult, { status: 'ERR' }> =>
      r.status === 'ERR' &&
      !/not executed due to a failed transaction|transaction was aborted|Cannot COMMIT/i.test(
        String(r.result),
      ),
  );
  // A commit-time conflict is reported only on the COMMIT result, after
  // every statement before it says it was not executed.
  const conflict = results.find(
    (r) =>
      r.status === 'ERR' &&
      (isRetryableConflict(String(r.result)) ||
        (r as { details?: { kind?: string } }).details?.kind === 'TransactionConflict'),
  );
  if (failures.length === 0 && conflict) {
    return { retry: true, error: new Error(String(conflict.result)) };
  }
  const message = String(failures[0]?.result ?? results.find((r) => r.status === 'ERR')?.result);
  const code = thrownCode(message);
  if (code === 'revision_changed') return { retry: true, error: new Error(message) };
  if (code === 'schema_busy') return { retry: false, error: schemaBusy() };
  if (code === 'effect') {
    return {
      retry: false,
      error: new AppError(500, 'internal', 'a write did not take effect', {
        statement: thrownDetail(message),
      }),
    };
  }
  if (code) return { retry: false, error: new AppError(409, code, message) };
  if (isRetryableConflict(message)) return { retry: true, error: new Error(message) };
  // A unique index refused a write planned against an older snapshot:
  // replanning sees the winner and reports the conflict properly.
  if (uniqueIndexViolation(message)) return { retry: true, error: new Error(message) };
  return { retry: false, error: new SurrealError(message, { results }) };
}

/**
 * The operation a request ran, for its response (`Retainer-Operation-Id`):
 * the HTTP layer opens a scope per request and reads it after the handler.
 */
export const operationScope = new AsyncLocalStorage<{ id?: string }>();

/**
 * Runs one workspace mutation under the write protocol. Every workspace
 * mutation goes through here; no module writes around it.
 */
export async function mutate<T>(
  backend: Backend,
  workspaceId: string,
  input: MutationInput<T>,
): Promise<MutationOutcome<T>> {
  if (!backend.writable) {
    throw new AppError(503, 'not_accepting_writes', 'this server is shutting down; retry', {
      retryable: true,
    });
  }
  const routing = { provisioning: input.provisioning === true };
  const db = await backend.workspace(workspaceId, routing);
  const commitDb = input.admin ? await backend.workspaceAdmin(workspaceId, routing) : db;
  const operationId = randomUUID();
  const scope = operationScope.getStore();
  if (scope) scope.id = operationId;
  const now = serverNow();
  const ids: string[] = [];

  return backend.queues.run(workspaceId, input.kind, async () => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        backend.queues.stats.conflicts++;
        await new Promise((r) => setTimeout(r, 5 * 2 ** attempt + Math.random() * 20));
      }
      const state = await readState(db);
      if (state.mode !== 'active' && !input.allowSchemaUpdate) throw schemaBusy();

      // A matching receipt answers a retry without running it again.
      let expiredReceipt: string | undefined;
      if (input.idempotencyKey !== undefined) {
        validateKey(input.idempotencyKey);
        const [receipt] = await db.rows<Receipt>(
          'SELECT * FROM operations WHERE kind = $kind AND idempotency_key = $key LIMIT 1;',
          { kind: input.kind, key: input.idempotencyKey },
        );
        if (receipt && receipt.expires_at.getTime() > now.getTime()) {
          const original = String((receipt.id as { id: string }).id ?? receipt.id);
          if (scope) scope.id = original;
          return {
            result: receiptReplay(receipt, input.requestHash) as T,
            operationId: original,
            replayed: true,
          };
        }
        if (receipt) expiredReceipt = String((receipt.id as { id: string }).id ?? receipt.id);
      }

      const op = new Operation(operationId, attempt, workspaceId, db, state, now, ids);
      if (input.admin) op.admin = commitDb;
      let result: T;
      try {
        result = await input.plan(op);
      } catch (error) {
        if (error instanceof NoChange) return { result: error.value as T, operationId, replayed: false };
        // A domain error from a torn read is replanned, not reported (step 2).
        const current = await readState(db);
        if (current.revision !== state.revision && attempt < MAX_ATTEMPTS) {
          lastError = error as Error;
          continue;
        }
        throw error;
      }

      const outcome = await commit(commitDb, op, state, input, result, expiredReceipt);
      if (outcome === 'ok') {
        op.committed();
        return { result, operationId, replayed: false };
      }
      if (!outcome.retry) throw outcome.error;
      lastError = outcome.error;
    }
    log.warn(`write ${input.kind} on ${workspaceId} gave up: ${lastError?.message}`);
    throw new AppError(409, 'write_conflict', 'concurrent writes kept conflicting; retry', {
      retryable: true,
      operationId,
    });
  });
}

function validateKey(key: string): void {
  if (key.length === 0 || key.length > 200) {
    throw new AppError(400, 'invalid_request', 'Idempotency-Key must be 1 to 200 characters');
  }
}

async function commit<T>(
  db: Db,
  op: Operation,
  state: WorkspaceState,
  input: MutationInput<T>,
  result: T,
  expiredReceipt: string | undefined,
): Promise<'ok' | { retry: boolean; error: Error }> {
  const batch = op.batch;
  const head = [
    'BEGIN;',
    'LET $__state = (SELECT revision, mode FROM ONLY workspace_state:current);',
    `IF $__state.revision != ${batch.v(state.revision)} { THROW 'retainer:revision_changed' };`,
    `IF $__state.mode != ${batch.v(input.allowSchemaUpdate ? state.mode : 'active')} { THROW 'retainer:schema_busy' };`,
    `UPDATE workspace_state:current SET revision = ${batch.v(state.revision + 1)}, updated_at = ${batch.v(
      op.now,
    )};`,
  ];
  const tail: string[] = [];
  if (expiredReceipt) {
    tail.push(`DELETE type::record('operations', ${batch.v(expiredReceipt)});`);
  }
  if (!input.noReceipt) {
    const receipt = {
      kind: input.kind,
      idempotency_key: input.idempotencyKey,
      request_hash: input.requestHash ?? null,
      status: 'completed',
      result: toStorable(input.receipt ? input.receipt(result) : result),
      refs: input.refs ? [...new Set(input.refs(result))] : [],
      created_at: op.now,
      expires_at: new Date(op.now.getTime() + RECEIPT_TTL_MS),
    };
    tail.push(
      `CREATE type::record('operations', ${batch.v(op.id)}) CONTENT ${batch.v(receipt)};`,
    );
  }
  const text = [...head, ...batch.statements, ...tail, 'COMMIT;'].join('\n');
  let results: StatementResult[];
  try {
    results = await db.raw(text, batch.vars);
  } catch (error) {
    if (error instanceof SurrealTimeoutError) {
      throw new AppError(
        503,
        'unknown_outcome',
        'the write may or may not have been applied; check get_operation before retrying',
        { operationId: op.id, retryable: false },
      );
    }
    if (error instanceof SurrealError && isRetryableConflict(error.message)) {
      return { retry: true, error };
    }
    throw error;
  }
  if (results.every((r) => r.status === 'OK')) return 'ok';
  return classify(results);
}

/**
 * Values stored in `any` columns are plain JSON: dates become ISO strings,
 * so a receipt replays exactly what the original response serialized.
 */
export function toStorable(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Reads against the published schema, outside the write queue. */
export async function readWorkspace<T>(
  backend: Backend,
  workspaceId: string,
  fn: (read: { db: Db; state: WorkspaceState; schema: () => Promise<CompiledSchema> }) => Promise<T>,
): Promise<T> {
  const db = await backend.workspace(workspaceId);
  const state = await readState(db);
  let schema: CompiledSchema | undefined;
  return fn({
    db,
    state,
    schema: async () => {
      schema ??= await loadCompiledSchema(db, workspaceId, state.schema_version);
      return schema;
    },
  });
}
