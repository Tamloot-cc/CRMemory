import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, ownerDatabaseUrl } from '../config.js';
import { AppError } from '../errors.js';
import { createSql, type Sql } from './client.js';
import { getWorkspace } from './workspaces.js';

/**
 * A read-only login role for browsing the database with Drizzle Studio or
 * psql during development. It can SELECT every table except `api_keys`, has
 * no write grants and no BYPASSRLS, so row-level security applies to it.
 *
 * The role's default `app.workspace_id` pins it to one workspace for this
 * database, so it sees that workspace's rows. The pin is a convenience, not
 * a boundary: a session can `SET app.workspace_id` to another workspace.
 * Read-only is what the role guarantees.
 */
export type Viewer = { role: string; password: string; workspaceId: string; url: string };

export const DEFAULT_VIEWER_ROLE = 'retainer_viewer';

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Creates the viewer role, or updates it on re-run: a new password, grants on
 * tables added since, and the workspace pin. `sql` connects as the migration
 * role; `databaseUrl` is that connection's URL, used to build the viewer's.
 * Grants cover existing tables only; re-run after migrations add a table.
 */
export async function grantViewer(
  sql: Sql,
  databaseUrl: string,
  options: { workspace: string; role?: string },
): Promise<Viewer> {
  const role = options.role ?? DEFAULT_VIEWER_ROLE;
  if (!ROLE_NAME.test(role)) {
    throw new AppError(400, 'invalid_request', `invalid role name "${role}"`);
  }
  const workspace = await getWorkspace(sql, options.workspace);
  const password = randomBytes(18).toString('base64url');
  const r = quoteIdent(role);

  await sql.begin(async (tx) => {
    const [{ database } = { database: '' }] = await tx<{ database: string }[]>`
      select current_database() as database`;
    const [existing] = await tx`select 1 from pg_roles where rolname = ${role}`;
    // Generated values only: the role name is validated, the password is
    // base64url and the workspace id is a uuid read from the database.
    await tx.unsafe(
      `${existing ? 'alter' : 'create'} role ${r} login password '${password}' ` +
        'nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication',
    );
    await tx.unsafe(`grant connect on database ${quoteIdent(database)} to ${r}`);
    await tx.unsafe(`grant usage on schema public to ${r}`);
    await tx.unsafe(`grant select on all tables in schema public to ${r}`);
    await tx.unsafe(`revoke all on public.api_keys from ${r}`);
    await tx.unsafe(
      `alter role ${r} in database ${quoteIdent(database)} ` +
        `set app.workspace_id = '${workspace.id}'`,
    );
  });

  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return { role, password, workspaceId: workspace.id, url: url.toString() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { workspace: { type: 'string' }, role: { type: 'string' } },
  });
  const config = loadConfig();
  const databaseUrl = ownerDatabaseUrl(config);
  const sql = createSql(databaseUrl, { max: 1 });
  try {
    const viewer = await grantViewer(sql, databaseUrl, {
      workspace: values.workspace ?? 'default',
      ...(values.role ? { role: values.role } : {}),
    });
    console.log(
      [
        `Read-only role "${viewer.role}" pinned to workspace ${viewer.workspaceId}.`,
        'The password changes on every run. Browse with:',
        '',
        `  DATABASE_URL='${viewer.url}' pnpm db:studio`,
        '',
        'The pin filters rows; it is not isolation (a session can SET',
        'app.workspace_id). Re-run after migrations add a table.',
      ].join('\n'),
    );
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
