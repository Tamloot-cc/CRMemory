import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import {
  addComment,
  commentInputSchema,
  deleteComment,
  editComment,
  listComments,
} from '../../comments/service.js';
import type { Sql } from '../../db/client.js';
import { idParam, limitParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';

/** Comments (6.1), on the same services as `get_record` and `list_comments`. */
export function commentRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.get('/records/:id/comments', requireScope('read'), async (c) =>
    c.json(
      await listComments(
        sql,
        c.get('caller'),
        idParam(c),
        limitParam(c, 50, 200),
        c.req.query('cursor'),
      ),
    ),
  );

  app.post('/records/:id/comments', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, commentInputSchema);
    const key = c.req.header('idempotency-key');
    return c.json(await addComment(sql, c.get('caller'), id, input, key), 201);
  });

  app.patch('/comments/:id', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, commentInputSchema);
    const key = c.req.header('idempotency-key');
    return c.json(await editComment(sql, c.get('caller'), id, input, key));
  });

  app.delete('/comments/:id', requireScope('write'), async (c) =>
    c.json(await deleteComment(sql, c.get('caller'), idParam(c), c.req.header('idempotency-key'))),
  );
}
