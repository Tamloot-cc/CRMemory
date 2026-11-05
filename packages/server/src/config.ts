import { z } from 'zod';
import { LOG_LEVELS } from './log.js';

export const publicOriginSchema = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  }, 'use an http(s) origin without credentials, a path, query or fragment')
  .transform((value) => new URL(value).origin);

const configSchema = z.object({
  RETAINER_PUBLIC_ORIGIN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    publicOriginSchema.optional(),
  ),
  RETAINER_WEB_DIR: z.string().optional(),
  /** SurrealDB server (spec section 9): HTTP `/rpc` with CBOR. */
  RETAINER_SURREAL_URL: z
    .string()
    .url()
    .default('http://127.0.0.1:8000')
    .transform((value) => value.replace(/\/+$/, '')),
  /** The namespace holding the catalog and every workspace database. */
  RETAINER_SURREAL_NAMESPACE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'use letters, digits and underscores')
    .default('retainer'),
  /** System credential for definitions and provisioning only (section 4). */
  RETAINER_SURREAL_USER: z.string().min(1).default('root'),
  RETAINER_SURREAL_PASS: z.string().min(1),
  /** `root`, or `namespace` for a namespace-scoped system user. */
  RETAINER_SURREAL_AUTH_LEVEL: z.enum(['root', 'namespace']).default('root'),
  /**
   * The current signing key for runtime database sessions, `<id>:<base64
   * PKCS#8 PEM>`; generate one with `retainer signing-key generate`.
   */
  RETAINER_SIGNING_KEY: z.string().min(1, 'generate one with: retainer signing-key generate'),
  /** Earlier signing keys still accepted during a rotation, comma-separated. */
  RETAINER_SIGNING_PREVIOUS_KEYS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  ),
  /** IDs of compromised keys: removed from each workspace in the same upgrade. */
  RETAINER_SIGNING_REVOKED_KEY_IDS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  ),
  /** One process runs the API and the workers (section 9). */
  RETAINER_ROLE: z.literal('all').default('all'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** How often the consolidator runs per workspace (4.2). */
  RETAINER_CONSOLIDATE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  /** How long a write waits for its workspace's queue before `workspace_busy`. */
  RETAINER_WRITE_QUEUE_LIMIT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Secret for the keyed HMAC of suppressed handles (2.1). Needed by
   * `forget`; read from the environment where it is used.
   */
  RETAINER_SUPPRESSION_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32, 'use at least 32 characters').optional(),
  ),
  /**
   * Earlier suppression keys, comma-separated, still checked so a rotation
   * keeps erased handles and event identities suppressed (6.4).
   */
  RETAINER_SUPPRESSION_PREVIOUS_KEYS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  ),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
