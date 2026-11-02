import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { inWorkspace } from '../../db/tx.js';
import { applyTemplate } from '../../templates/apply.js';
import { listTemplates } from '../../templates/catalog.js';
import type { AppEnv } from '../http.js';

export function templateRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.get('/templates', requireScope('read'), async (c) => {
    const { workspaceId } = c.get('caller');
    const [workspace] = await inWorkspace(
      sql,
      workspaceId,
      (tx) => tx<{ templates: { name: string }[] }[]>`
        select templates from workspaces where id = ${workspaceId}`,
    );
    return c.json({ templates: listTemplates(workspace?.templates.map((t) => t.name) ?? []) });
  });

  app.post('/templates/:name/apply', requireScope('schema:write'), async (c) => {
    const caller = c.get('caller');
    const result = await inWorkspace(sql, caller.workspaceId, (tx) =>
      applyTemplate(tx, {
        workspaceId: caller.workspaceId,
        actor: caller.actor,
        scopes: caller.scopes,
        name: c.req.param('name'),
      }),
    );
    return c.json(result);
  });
}
