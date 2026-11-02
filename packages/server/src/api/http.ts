import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppError } from '../errors.js';
import type { Caller } from '../records/service.js';

/** Hono environment: every authenticated request carries its caller. */
export type AppEnv = {
  Variables: {
    caller: Caller;
  };
};

export type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

export function errorResponse(c: Context, error: AppError) {
  const body: ErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
  return c.json(body, error.status as ContentfulStatusCode);
}
