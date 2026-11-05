import { decode, encode } from './cbor.js';

/**
 * The one module that talks to SurrealDB (spec section 9): HTTP `/rpc` with
 * CBOR parameters and token authentication. It checks the HTTP status, the
 * RPC envelope and every statement's status, and classifies the errors the
 * write protocol retries.
 */

export type StatementResult =
  | { status: 'OK'; result: unknown; time?: string }
  | { status: 'ERR'; result: string; kind?: string; time?: string };

/** Supplies a bearer token; called again after a 401 with `refresh: true`. */
export type TokenSource = (refresh: boolean) => Promise<string>;

export type SurrealTarget = {
  /** Base URL of the server, e.g. `http://127.0.0.1:8000`. */
  url: string;
  namespace: string;
  /** Omitted for namespace-level statements (DEFINE DATABASE …). */
  database?: string;
  token: TokenSource;
};

/** Thrown when a request fails before statements run, or a statement fails. */
export class SurrealError extends Error {
  constructor(
    message: string,
    readonly detail: {
      httpStatus?: number;
      statement?: number;
      kind?: string;
      /** Every statement's result, when the request reached the server. */
      results?: StatementResult[];
    } = {},
  ) {
    super(message);
    this.name = 'SurrealError';
  }
}

/** The lost-response case: the request may or may not have committed (section 7). */
export class SurrealTimeoutError extends SurrealError {
  constructor(message: string) {
    super(message);
    this.name = 'SurrealTimeoutError';
  }
}

const CONFLICT_PATTERNS = [
  /transaction write conflict/i,
  /transaction conflict/i,
  /this transaction can be retried/i,
];

/**
 * The single classifier for retryable commit conflicts (section 6, step 5).
 * The pinned release reports `Transaction write conflict. This transaction
 * can be retried`; Cloud reports `Transaction conflict: conflict (409)`.
 */
export function isRetryableConflict(message: string): boolean {
  return CONFLICT_PATTERNS.some((pattern) => pattern.test(message));
}

/** A unique index refused a write: `Database index `x` already contains …`. */
export function uniqueIndexViolation(message: string): string | null {
  const match = /Database index `([^`]+)` already contains/.exec(message);
  return match?.[1] ?? null;
}

/** A `THROW` from Retainer's own statements: `An error occurred: retainer:<code>…`. */
export function thrownCode(message: string): string | null {
  const match = /retainer:([a-z_]+)(?::([^\s'"]*))?/.exec(message);
  return match ? (match[1] as string) : null;
}

export function thrownDetail(message: string): string | null {
  const match = /retainer:[a-z_]+:([^\s'"]*)/.exec(message);
  return match?.[1] ?? null;
}

export type QueryOptions = {
  /** Milliseconds before the request is abandoned (its outcome is then unknown). */
  timeoutMs?: number;
};

let requestCounter = 0;

/** Runs a SurrealQL batch; returns every statement's result without judging it. */
export async function rawQuery(
  target: SurrealTarget,
  query: string,
  vars: Record<string, unknown> = {},
  options: QueryOptions = {},
): Promise<StatementResult[]> {
  const body = encode({ id: ++requestCounter, method: 'query', params: [query, vars] });
  for (let attempt = 0; ; attempt++) {
    const token = await target.token(attempt > 0);
    const headers: Record<string, string> = {
      Accept: 'application/cbor',
      'Content-Type': 'application/cbor',
      Authorization: `Bearer ${token}`,
      'surreal-ns': target.namespace,
    };
    if (target.database) headers['surreal-db'] = target.database;
    let response: Response;
    try {
      response = await fetch(`${target.url}/rpc`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        throw new SurrealTimeoutError(`SurrealDB request timed out: ${(error as Error).message}`);
      }
      throw new SurrealError(`SurrealDB is unreachable: ${(error as Error).message}`);
    }
    // An expired token: refresh once and resend.
    if (response.status === 401 && attempt === 0) {
      await response.arrayBuffer();
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok && bytes.length === 0) {
      throw new SurrealError(`SurrealDB returned HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    let envelope: { result?: unknown; error?: { message?: string; kind?: string } };
    try {
      envelope = decode(bytes) as typeof envelope;
    } catch {
      throw new SurrealError(
        `SurrealDB returned HTTP ${response.status}: ${bytes.toString('utf8').slice(0, 300)}`,
        { httpStatus: response.status },
      );
    }
    if (envelope.error) {
      const message = envelope.error.message ?? 'unknown RPC error';
      throw new SurrealError(message, {
        httpStatus: response.status,
        ...(envelope.error.kind ? { kind: envelope.error.kind } : {}),
      });
    }
    if (!response.ok) {
      throw new SurrealError(`SurrealDB returned HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    if (!Array.isArray(envelope.result)) {
      throw new SurrealError('SurrealDB returned no statement results');
    }
    return envelope.result as StatementResult[];
  }
}

/**
 * Runs a batch and requires every statement to succeed. Returns each
 * statement's result. `BEGIN`/`COMMIT` appear as results of their own.
 */
export async function query(
  target: SurrealTarget,
  text: string,
  vars: Record<string, unknown> = {},
  options: QueryOptions = {},
): Promise<unknown[]> {
  const results = await rawQuery(target, text, vars, options);
  const failed = results.findIndex((r) => r.status !== 'OK');
  if (failed >= 0) {
    // The first real failure; statements after it only say they were not run.
    const cause =
      results.find(
        (r) =>
          r.status !== 'OK' &&
          !/not executed due to a failed transaction|transaction was aborted/i.test(
            String(r.result),
          ),
      ) ?? results[failed];
    const index = results.indexOf(cause as StatementResult);
    throw new SurrealError(String(cause?.result), {
      statement: index,
      ...(cause && 'kind' in cause && cause.kind ? { kind: cause.kind } : {}),
      results,
    });
  }
  return results.map((r) => r.result);
}

/** Signs in a system user over HTTP; returns its token. */
export async function signin(
  url: string,
  credentials: { user: string; pass: string; namespace?: string },
): Promise<string> {
  const response = await fetch(`${url}/signin`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: credentials.user,
      pass: credentials.pass,
      ...(credentials.namespace ? { ns: credentials.namespace } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new SurrealError(`SurrealDB sign-in failed: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { token?: string; result?: string } | string;
  const token = typeof body === 'string' ? body : (body.token ?? body.result);
  if (!token) throw new SurrealError('SurrealDB sign-in returned no token');
  return token;
}

/** `/version` text, recorded with operational checks (section 9). */
export async function serverVersion(url: string): Promise<string> {
  const response = await fetch(`${url}/version`, { signal: AbortSignal.timeout(10_000) });
  return (await response.text()).trim();
}

/** `/health`: true when the server answers. */
export async function serverHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Reads the `exp` claim of a JWT, in milliseconds; undefined when absent. */
export function tokenExpiry(token: string): number | undefined {
  const [, payload] = token.split('.');
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return claims.exp ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A token source that signs in once and again shortly before the token
 * expires, or when the server refuses it.
 */
export function systemTokenSource(
  url: string,
  credentials: { user: string; pass: string; namespace?: string },
): TokenSource {
  let token: string | undefined;
  let expires = 0;
  let pending: Promise<string> | undefined;
  return async (refresh) => {
    if (!refresh && token && Date.now() < expires - 60_000) return token;
    pending ??= signin(url, credentials)
      .then((value) => {
        token = value;
        expires = tokenExpiry(value) ?? Date.now() + 10 * 60_000;
        return value;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

/** Quotes an identifier generated from validated metadata (never caller text). */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to use "${name}" as a SurrealQL identifier`);
  }
  return `\`${name}\``;
}
