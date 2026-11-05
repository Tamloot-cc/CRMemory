import type { Backend } from '../db/backend.js';
import { readWorkspace } from '../db/protocol.js';
import type { Caller } from '../records/service.js';
import { type ApplyTemplateResult, applyTemplate } from './apply.js';
import { listTemplates, type TemplateView } from './catalog.js';

/** list_templates and GET /v1/templates: every template, marked if applied (3.1). */
export async function templatesFor(
  backend: Backend,
  caller: Caller,
): Promise<{ templates: TemplateView[] }> {
  return readWorkspace(backend, caller.workspaceId, async ({ state }) => ({
    templates: listTemplates(state.templates.map((t) => t.name)),
  }));
}

/** apply_template and POST /v1/templates/:name/apply. */
export async function applyTemplateFor(
  backend: Backend,
  caller: Caller,
  name: string,
): Promise<ApplyTemplateResult> {
  return applyTemplate(backend, {
    workspaceId: caller.workspaceId,
    actor: caller.actor,
    scopes: caller.scopes,
    name,
  });
}
