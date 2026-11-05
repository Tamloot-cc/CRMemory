import type { OperationReceipt } from '@retainer/shared';
import { z } from 'zod';
import type { Backend } from '../db/backend.js';
import { RecordId } from '../db/cbor.js';
import { isUuid, publicId } from '../db/names.js';
import { readWorkspace } from '../db/protocol.js';
import { AppError } from '../errors.js';
import type { Caller } from '../records/service.js';

/**
 * `get_operation` (spec section 7): what became of a write, by its
 * operation ID or by the idempotency key and kind it was sent with. Scoped
 * to the caller's workspace like every read. A receipt whose result was
 * erased by `forget` says so and never returns the result.
 */

export const getOperationSchema = z.union([
  z.strictObject({ operationId: z.uuid() }),
  z.strictObject({
    kind: z.string().min(1).max(100),
    idempotencyKey: z.string().min(1).max(200),
  }),
]);
export type GetOperationInput = z.infer<typeof getOperationSchema>;

type ReceiptRow = {
  id: RecordId;
  kind: string;
  status: string;
  result?: unknown;
  created_at: Date;
  expires_at: Date;
};

export async function getOperation(
  backend: Backend,
  caller: Caller,
  input: GetOperationInput,
): Promise<OperationReceipt> {
  return readWorkspace(backend, caller.workspaceId, async ({ db }) => {
    let row: ReceiptRow | undefined;
    if ('operationId' in input) {
      if (!isUuid(input.operationId)) throw new AppError(400, 'invalid_request', 'not an ID');
      [row] = await db.rows<ReceiptRow>('SELECT * FROM $id;', {
        id: new RecordId('operations', input.operationId),
      });
    } else {
      [row] = await db.rows<ReceiptRow>(
        'SELECT * FROM operations WHERE kind = $kind AND idempotency_key = $key LIMIT 1;',
        { kind: input.kind, key: input.idempotencyKey },
      );
    }
    const now = Date.now();
    if (!row || row.expires_at.getTime() <= now) {
      return {
        operationId: 'operationId' in input ? input.operationId : null,
        kind: 'kind' in input ? input.kind : null,
        status: 'not_observed',
        result: null,
        createdAt: null,
        expiresAt: null,
      };
    }
    const erased = row.status === 'erased';
    return {
      operationId: publicId(row.id),
      kind: row.kind,
      status: erased ? 'erased' : 'completed',
      result: erased ? null : (row.result ?? null),
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  });
}
