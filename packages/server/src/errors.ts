/**
 * An error the API returns as `{ error: { code, message, details } }`.
 * Messages are written for agents: they say what was wrong and what is
 * allowed, so the caller can retry.
 */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 422 | 500,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string, details?: Record<string, unknown>) =>
  new AppError(404, 'not_found', `${what} not found`, details);

export const forbidden = (message: string) => new AppError(403, 'forbidden', message);

export const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'invalid_request', message, details);
