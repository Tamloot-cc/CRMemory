import { z } from 'zod';
import { type Config, loadConfig } from '../config.js';
import { createSql } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { setLogLevel } from '../log.js';
import { runCli } from '../operator/commands.js';
import { rebuildSearchText } from '../records/rebuild-search.js';

/**
 * Operator tasks as an AWS Lambda function that only the operator invokes
 * (docs/aws.md). It is the deployment's replacement for running the CLI in
 * the container, since the database is not reachable from outside the VPC.
 *
 * - `{ "command": "migrate" }` applies pending migrations and rebuilds stale
 *   search text: what the container does on every start. The deploy runs it
 *   once, with the API stopped.
 * - `{ "command": "cli", "args": ["key", "create", ...] }` runs the
 *   operator CLI (7.1).
 *
 * The CLI's output is returned to the caller and never logged: `key create`
 * prints the only copy of a key.
 */
const opsEvent = z.discriminatedUnion('command', [
  z.object({ command: z.literal('migrate') }),
  z.object({ command: z.literal('cli'), args: z.array(z.string()) }),
]);

export type OpsEvent = z.infer<typeof opsEvent>;
export type OpsResult =
  | { command: 'migrate'; rebuiltSearchText: number }
  | { command: 'cli'; exitCode: number; stdout: string; stderr: string };

export function createOpsHandler(config: Config) {
  setLogLevel(config.LOG_LEVEL);
  return async (event: unknown): Promise<OpsResult> => {
    const parsed = opsEvent.safeParse(event);
    if (!parsed.success) {
      throw new Error(
        'Expected {"command":"migrate"} or {"command":"cli","args":[...]}: ' +
          parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    // Operator commands connect as the migration role, like the CLI.
    // `max: 1`, because the search rebuild holds a session lock.
    if (parsed.data.command === 'migrate') {
      await runMigrations(config.DATABASE_URL);
      const sql = createSql(config.DATABASE_URL, { max: 1 });
      try {
        return { command: 'migrate', rebuiltSearchText: await rebuildSearchText(sql) };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    const sql = createSql(config.DATABASE_URL, { max: 1 });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runCli(parsed.data.args, {
        sql,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line),
      });
      return { command: 'cli', exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
}

let cached: ReturnType<typeof createOpsHandler> | undefined;

/** The Lambda entry point (`dist/lambda/ops.handler`). */
export const handler = (event: unknown) => {
  cached ??= createOpsHandler(loadConfig());
  return cached(event);
};
