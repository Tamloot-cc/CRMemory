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
  DATABASE_URL: z.string().url(),
  RETAINER_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** How often the consolidator runs per workspace (4.2). */
  RETAINER_CONSOLIDATE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  /**
   * Database connections each API process opens. The container serves many
   * requests at once; a Lambda instance serves one, so the AWS deployment
   * sets this low to keep the total under the database's limit.
   */
  RETAINER_DB_POOL_MAX: z.coerce.number().int().positive().default(10),
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
