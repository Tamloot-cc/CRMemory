import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Backend } from '../../db/backend.js';
import { AppError } from '../../errors.js';
import { getOperation } from '../../operations/service.js';
import type { AppEnv } from '../http.js';
import { idParam } from '../request.js';

export function operationRoutes(app: Hono<AppEnv>, backend: Backend) {
  /** get_operation by operation ID (the `Retainer-Operation-Id` header). */
  app.get('/operations/:id', requireScope('read'), async (c) =>
    c.json(await getOperation(backend, c.get('caller'), { operationId: idParam(c) })),
  );

  /** get_operation by the idempotency key and kind a write was sent with. */
  app.get('/operations', requireScope('read'), async (c) => {
    const kind = c.req.query('kind');
    const idempotencyKey = c.req.query('idempotencyKey');
    if (!kind || !idempotencyKey) {
      throw new AppError(
        400,
        'invalid_request',
        'pass /operations/<operationId>, or kind and idempotencyKey query parameters',
      );
    }
    return c.json(await getOperation(backend, c.get('caller'), { kind, idempotencyKey }));
  });
}
