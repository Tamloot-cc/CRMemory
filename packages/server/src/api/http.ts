import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from '../errors.js';
import type { Caller } from '../records/service.js';
import { SchemaValidationError } from '../schema-engine/types.js';

/** Hono environment: every authenticated request carries its caller. */
export type AppEnv = {
  Variables: {
    caller: Caller;
  };
};

export type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

/** Maps a thrown error to the AppError the API reports, if it is a known one. */
export function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  if (error instanceof SchemaValidationError) {
    return new AppError(422, 'schema_invalid', 'the schema change is invalid', {
      issues: error.issues,
    });
  }
  return undefined;
}

/** `{ error: { code, message, details } }`, shared by REST responses and MCP tool errors. */
export function errorBody(error: AppError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function errorResponse(c: Context, error: AppError) {
  return c.json(errorBody(error), error.status as ContentfulStatusCode);
}
