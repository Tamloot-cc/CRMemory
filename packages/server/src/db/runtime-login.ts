import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { type Config, passwordOf } from '../config.js';
import { RUNTIME_ROLE, type Sql } from './client.js';

/**
 * Gives the runtime role a login (accounts spec 4.9), so the API and workers
 * connect as `retainer_app` and their connections can never act as the owner.
 *
 * The password comes from RETAINER_RUNTIME_DATABASE_URL, and the migration
 * role sets it on every boot or migration, so rotating it means changing the
 * URL and redeploying. Roles are cluster-wide: the password is shared by
 * every database on the server.
 */
export async function setRuntimeLogin(owner: Sql, password: string): Promise<void> {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    // SCRAM normalizes non-ASCII passwords (SASLprep); keeping to printable
    // ASCII means the verifier below needs no normalization.
    throw new Error('The runtime role password must be printable ASCII without spaces.');
  }
  const verifier = scramVerifier(password);
  await owner.begin(async (tx) => {
    // Two containers booting at once would otherwise update the role row
    // concurrently, which Postgres refuses ("tuple concurrently updated").
    await tx`select pg_advisory_xact_lock(${RUNTIME_LOGIN_LOCK})`;
    // A login for a role that is privileged, owns objects or can become
    // another role would defeat the point. The migration only creates the
    // role when it is missing, so one made or altered by hand gets here too.
    const problems = await runtimeRoleProblems(tx);
    if (problems.length > 0) {
      throw new Error(`${RUNTIME_ROLE} ${problems.join('; ')}. Fix that before giving it a login.`);
    }
    // The verifier holds only base64, digits, `$` and `:`.
    await tx.unsafe(`alter role ${RUNTIME_ROLE} login password '${verifier}'`);
  });
}

/**
 * Sets the runtime login when the config asks for one (`setRuntimeLogin`).
 * `owner` connects as the migration role. Returns whether it did.
 */
export async function applyRuntimeLogin(config: Config, owner: Sql): Promise<boolean> {
  const url = config.RETAINER_RUNTIME_DATABASE_URL;
  if (!url) return false;
  await setRuntimeLogin(owner, passwordOf(url));
  return true;
}

/** What makes the runtime role unsafe to log in as, in plain words. */
async function runtimeRoleProblems(tx: TransactionSql): Promise<string[]> {
  const [role] = await tx<
    {
      attributes: string[];
      memberOf: string[];
      owns: number;
    }[]
  >`
    select
      array_remove(array[
        case when r.rolsuper then 'SUPERUSER' end,
        case when r.rolbypassrls then 'BYPASSRLS' end,
        case when r.rolcreaterole then 'CREATEROLE' end,
        case when r.rolcreatedb then 'CREATEDB' end,
        case when r.rolreplication then 'REPLICATION' end
      ], null) as attributes,
      array(
        select m.roleid::regrole::text from pg_auth_members m where m.member = r.oid
      ) as "memberOf",
      (select count(*) from pg_class c where c.relowner = r.oid)::int
        + (select count(*) from pg_namespace n where n.nspowner = r.oid)::int
        + (select count(*) from pg_proc p where p.proowner = r.oid)::int as owns
    from pg_roles r
    where r.rolname = ${RUNTIME_ROLE}`;
  if (!role) return ['does not exist; run the migrations first'];
  const problems: string[] = [];
  if (role.attributes.length > 0) problems.push(`has ${role.attributes.join(', ')}`);
  if (role.memberOf.length > 0) problems.push(`is a member of ${role.memberOf.join(', ')}`);
  if (role.owns > 0) problems.push(`owns ${role.owns} object(s) in this database`);
  return problems;
}

/** "RTN" and a number, like the other advisory lock keys. */
const RUNTIME_LOGIN_LOCK = 0x52544e04;

/** Postgres's default for SCRAM-SHA-256 (`scram_iterations`). */
const SCRAM_ITERATIONS = 4096;

/**
 * A SCRAM-SHA-256 verifier (RFC 7677), the form Postgres stores. Sending it
 * instead of the password keeps the password out of the server's logs.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (buffer: Buffer) => buffer.toString('base64');
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}
