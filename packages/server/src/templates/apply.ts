import type { Actor } from '@retainer/shared';
import type { Backend } from '../db/backend.js';
import { mutate, NoChange, type Operation } from '../db/protocol.js';
import type { ApiKeyScope, AppliedTemplate } from '../db/types.js';
import { AppError, notFound } from '../errors.js';
import {
  planSchemaChange,
  type SchemaChangeResult,
  SYSTEM_ACTOR,
} from '../schema-engine/engine.js';
import { SEED_OPERATIONS } from './base.js';
import { getTemplate, TEMPLATE_NAMES } from './index.js';

/**
 * Creates the base objects, the base event types and the hidden internal-note
 * type in a new workspace. Code-defined schema goes through the same engine
 * on its trusted path (person.emails is unique, which would otherwise need
 * approval).
 */
export async function seedBaseObjects(op: Operation): Promise<SchemaChangeResult> {
  return planSchemaChange(op, {
    workspaceId: op.workspaceId,
    actor: SYSTEM_ACTOR,
    scopes: [],
    operations: SEED_OPERATIONS,
    reason: 'Base objects',
    owner: 'system',
    trusted: true,
  });
}

export type ApplyTemplateResult = SchemaChangeResult & { alreadyApplied: boolean };

/**
 * Applies a template (3.1) as owner `system`, in the operation's
 * transaction. Template operations are all additive, so they apply without
 * approval; a name collision fails validation and lists every collision,
 * and nothing is half-applied. Applying a template twice is a no-op.
 */
export async function planApplyTemplate(
  op: Operation,
  input: { actor: Actor; scopes: readonly ApiKeyScope[]; name: string },
): Promise<ApplyTemplateResult> {
  const template = getTemplate(input.name);
  if (!template) {
    throw notFound(`template "${input.name}"`, { templates: [...TEMPLATE_NAMES] });
  }
  if (op.state.templates.some((t) => t.name === template.name)) {
    throw new NoChange<ApplyTemplateResult>({
      status: 'unchanged',
      change: null,
      schemaVersion: op.state.schema_version,
      alreadyApplied: true,
    });
  }

  const result = await planSchemaChange(op, {
    workspaceId: op.workspaceId,
    actor: input.actor,
    scopes: input.scopes,
    operations: template.operations,
    reason: `Template ${template.name} v${template.version}`,
    owner: 'system',
  });
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    // Templates are additive by construction; anything else is a bug.
    throw new AppError(409, 'template_not_applied', `template change was ${result.status}`);
  }

  const applied: AppliedTemplate = {
    name: template.name,
    version: template.version,
    appliedAt: op.now.toISOString(),
  };
  op.batch.update('workspace_state', 'current', {
    templates: [...op.state.templates, applied],
    initialized_at: op.state.initialized_at ?? op.now,
  });
  return { ...result, alreadyApplied: false };
}

export async function applyTemplate(
  backend: Backend,
  input: { workspaceId: string; actor: Actor; scopes: readonly ApiKeyScope[]; name: string },
): Promise<ApplyTemplateResult> {
  const { result } = await mutate(backend, input.workspaceId, {
    kind: 'apply_template',
    admin: true,
    refs: () => [],
    plan: (op) => planApplyTemplate(op, input),
  });
  return result;
}
