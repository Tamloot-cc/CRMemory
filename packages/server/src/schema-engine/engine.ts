import type { Actor, SchemaChange as SchemaChangeView, SchemaOwner } from '@retainer/shared';
import type { Backend, Db } from '../db/backend.js';
import { publicId } from '../db/names.js';
import { mutate, type Operation, toStorable } from '../db/protocol.js';
import type { ApiKeyScope, SchemaChangeStatus } from '../db/types.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { applyOperations } from './apply.js';
import { diffSchemas, isDestructive } from './diff.js';
import type { SchemaOperation } from './operations.js';
import { checkExistingRecords, persistSchema, prepareDefinitions, SchemaCheckError } from './persist.js';
import { applyProtection } from './protection.js';
import { type DiffOp, type SchemaIssue, type SchemaState, SchemaValidationError } from './types.js';
import { issueKey, validateSchema } from './validate.js';

/** The server's own actor, for seeding and upgrades. */
export const SYSTEM_ACTOR: Actor = { type: 'system', id: 'retainer' };

export type SchemaChangeRequest = {
  workspaceId: string;
  actor: Actor;
  scopes: readonly ApiKeyScope[];
  operations: SchemaOperation[];
  reason?: string;
  /** Owner of what the change creates; defaults from the actor's type. */
  owner?: SchemaOwner;
  /**
   * Code-defined schema applied by the server itself (workspace seeding and
   * upgrades). Never set from a request: scope alone is not human approval.
   */
  trusted?: boolean;
};

export type { SchemaChange as SchemaChangeView } from '@retainer/shared';

export type SchemaChangeResult = {
  /** `unchanged` when the schema already matches the request. */
  status: SchemaChangeStatus | 'unchanged';
  change: SchemaChangeView | null;
  schemaVersion: number;
  /** For a failed change: records that conflict with it. */
  recordIds?: string[];
};

export function ownerFor(actor: Actor): SchemaOwner {
  if (actor.type === 'system') return 'system';
  if (actor.type === 'agent') return 'agent';
  return 'workspace';
}

/** Only a `user` actor with `admin` scope is a human approval (3). */
export function canApproveDestructive(actor: Actor, scopes: readonly ApiKeyScope[]): boolean {
  return actor.type === 'user' && scopes.includes('admin');
}

/**
 * Steps 2–5: apply in memory, validate, diff. Throws SchemaValidationError.
 * On the trusted path, the engine also protects the elements server code
 * depends on, which older workspaces may not have protected yet.
 */
function plan(
  current: SchemaState,
  operations: SchemaOperation[],
  owner: SchemaOwner,
  trusted = false,
) {
  const { state: desired, issues } = applyOperations(current, operations, { owner });
  if (trusted) applyProtection(desired);
  // Reference issues first; validation of a half-applied state can repeat them.
  let all = [...issues, ...validateSchema(desired)];
  if (trusted) {
    // Code-defined schema must not be blocked by an issue the workspace
    // already has, such as a name a later release reserved: only issues
    // the change itself introduces count.
    const existing = new Set(validateSchema(current).map(issueKey));
    all = all.filter((i) => !existing.has(issueKey(i)));
  }
  if (all.length > 0) throw new SchemaValidationError(dedupe(all));
  return { desired, ops: diffSchemas(current, desired) };
}

function dedupe(issues: SchemaIssue[]): SchemaIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = issueKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Plans a schema change inside a mutation (ARCHITECTURE.md 3): the change
 * row, and for an applied change its definitions, metadata and the new
 * schema version, all in the operation's one transaction. Callers that
 * write more in the same transaction (templates, workspace upgrades) call
 * this directly; everyone else uses `runSchemaChange`.
 */
export async function planSchemaChange(
  op: Operation,
  request: SchemaChangeRequest,
): Promise<SchemaChangeResult> {
  const { actor } = request;
  const current = (await op.schema()).state;
  const version = op.state.schema_version;
  const { desired, ops } = plan(
    current,
    request.operations,
    request.owner ?? ownerFor(actor),
    request.trusted,
  );

  if (ops.length === 0) return { status: 'unchanged', change: null, schemaVersion: version };

  const destructive = isDestructive(ops);
  const row = {
    request: request.operations,
    operations: ops,
    isDestructive: destructive,
    reason: request.reason ?? null,
    requestedBy: actor,
  };

  if (destructive && !request.trusted && !canApproveDestructive(actor, request.scopes)) {
    const change = insertChange(op, { ...row, status: 'proposed' });
    return { status: 'proposed', change, schemaVersion: version };
  }

  try {
    await checkExistingRecords(op.db, current, desired, ops);
  } catch (error) {
    if (!(error instanceof SchemaCheckError)) throw error;
    const change = insertChange(op, {
      ...row,
      status: 'failed',
      error: error.message,
      decidedBy: actor,
    });
    return { status: 'failed', change, schemaVersion: version, recordIds: error.recordIds };
  }

  const applied = await publish(op, current, desired, ops, actor);
  const change = insertChange(op, {
    ...row,
    status: 'applied',
    appliedVersion: applied,
    decidedBy: actor,
  });
  return { status: 'applied', change, schemaVersion: applied };
}

/** Definitions first (outside the transaction), then everything else in the batch. */
async function publish(
  op: Operation,
  current: SchemaState,
  desired: SchemaState,
  ops: DiffOp[],
  actor: Actor,
): Promise<number> {
  if (!op.admin) throw new Error('a schema change must run as an administrative operation');
  const definitions = await prepareDefinitions(op.admin, current, desired);
  return persistSchema(op, current, desired, ops, actor, definitions, op.state.schema_version + 1);
}

/** The one entry point for schema changes (ARCHITECTURE.md 3). */
export async function runSchemaChange(
  backend: Backend,
  request: SchemaChangeRequest,
): Promise<SchemaChangeResult> {
  const { result } = await mutate(backend, request.workspaceId, {
    kind: 'schema_change',
    admin: true,
    plan: (op) => planSchemaChange(op, request),
    refs: () => [],
  });
  return result;
}

/**
 * Approves or rejects a proposed change. Approval re-runs the engine on the
 * requested operations against the schema as it is now; if they no longer
 * validate, the change is marked failed with the error.
 */
export async function decideSchemaChange(
  backend: Backend,
  input: {
    workspaceId: string;
    changeId: string;
    actor: Actor;
    scopes: readonly ApiKeyScope[];
    decision: 'approve' | 'reject';
  },
): Promise<SchemaChangeResult> {
  const { changeId, actor } = input;
  if (!canApproveDestructive(actor, input.scopes)) {
    throw forbidden('only a user key with admin scope can decide schema changes');
  }
  const { result } = await mutate(backend, input.workspaceId, {
    kind: 'decide_schema_change',
    admin: true,
    refs: () => [],
    plan: async (op): Promise<SchemaChangeResult> => {
      const version = op.state.schema_version;
      const [row] = await op.rows<ChangeRow>(
        'SELECT * FROM type::record("schema_changes", $id);',
        { id: changeId },
      );
      if (!row) throw notFound('schema change');
      if (row.status !== 'proposed') {
        throw new AppError(409, 'already_decided', `this change is already ${row.status}`);
      }

      if (input.decision === 'reject') {
        const change = updateChange(op, row, { status: 'rejected', decidedBy: actor });
        return { status: 'rejected', change, schemaVersion: version };
      }

      const current = (await op.schema()).state;
      const operations = row.request as SchemaOperation[];
      let planned: ReturnType<typeof plan>;
      try {
        planned = plan(current, operations, ownerFor(row.requested_by));
        await checkExistingRecords(op.db, current, planned.desired, planned.ops);
      } catch (error) {
        if (!(error instanceof SchemaValidationError || error instanceof SchemaCheckError))
          throw error;
        const change = updateChange(op, row, {
          status: 'failed',
          decidedBy: actor,
          error: error.message,
        });
        return {
          status: 'failed',
          change,
          schemaVersion: version,
          ...(error instanceof SchemaCheckError ? { recordIds: error.recordIds } : {}),
        };
      }

      const applied =
        planned.ops.length > 0
          ? await publish(op, current, planned.desired, planned.ops, actor)
          : version;
      const change = updateChange(op, row, {
        status: 'applied',
        decidedBy: actor,
        appliedVersion: applied,
        operations: planned.ops,
      });
      return { status: 'applied', change, schemaVersion: applied };
    },
  });
  return result;
}

export async function getSchemaChange(db: Db, changeId: string): Promise<SchemaChangeView> {
  const [row] = await db.rows<ChangeRow>('SELECT * FROM type::record("schema_changes", $id);', {
    id: changeId,
  });
  if (!row) throw notFound('schema change');
  return toView(row);
}

export async function listSchemaChanges(
  db: Db,
  status: SchemaChangeStatus | undefined,
  limit: number,
): Promise<SchemaChangeView[]> {
  const rows = await db.rows<ChangeRow>(
    `SELECT * FROM schema_changes ${status ? 'WHERE status = $status' : ''}
     ORDER BY created_at DESC, id DESC LIMIT $limit;`,
    { status, limit },
  );
  return rows.map(toView);
}

type ChangeRow = {
  id: unknown;
  status: SchemaChangeStatus;
  request: unknown[];
  operations: unknown[];
  is_destructive: boolean;
  reason?: string | null;
  requested_by: Actor;
  decided_by?: Actor | null;
  applied_version?: number | null;
  error?: string | null;
  created_at: Date;
  decided_at?: Date | null;
};

function toView(row: ChangeRow): SchemaChangeView {
  return {
    id: publicId(row.id),
    status: row.status,
    operations: row.operations as DiffOp[],
    request: row.request as SchemaOperation[],
    isDestructive: row.is_destructive,
    reason: row.reason ?? null,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by ?? null,
    appliedVersion: row.applied_version ?? null,
    error: row.error ?? null,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

function insertChange(
  op: Operation,
  change: {
    status: SchemaChangeStatus;
    request: SchemaOperation[];
    operations: DiffOp[];
    isDestructive: boolean;
    reason: string | null;
    requestedBy: Actor;
    decidedBy?: Actor;
    appliedVersion?: number;
    error?: string;
  },
): SchemaChangeView {
  const decided = change.status !== 'proposed';
  const row: ChangeRow = {
    id: op.newId(),
    status: change.status,
    request: toStorable(change.request) as unknown[],
    operations: toStorable(change.operations) as unknown[],
    is_destructive: change.isDestructive,
    reason: change.reason,
    requested_by: change.requestedBy,
    decided_by: change.decidedBy ?? null,
    applied_version: change.appliedVersion ?? null,
    error: change.error ?? null,
    created_at: op.now,
    decided_at: decided ? op.now : null,
  };
  const { id, ...content } = row;
  op.batch.create('schema_changes', id as string, content);
  return toView(row);
}

function updateChange(
  op: Operation,
  row: ChangeRow,
  update: {
    status: SchemaChangeStatus;
    decidedBy: Actor;
    appliedVersion?: number;
    error?: string;
    operations?: DiffOp[];
  },
): SchemaChangeView {
  const next: ChangeRow = {
    ...row,
    status: update.status,
    decided_by: update.decidedBy,
    decided_at: op.now,
    applied_version: update.appliedVersion ?? null,
    error: update.error ?? null,
    operations: update.operations ? (toStorable(update.operations) as unknown[]) : row.operations,
  };
  op.batch.update('schema_changes', publicId(row.id), {
    status: next.status,
    decided_by: next.decided_by,
    decided_at: next.decided_at,
    applied_version: next.applied_version,
    error: next.error,
    operations: next.operations,
  });
  return toView(next);
}
