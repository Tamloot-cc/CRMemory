import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { type Config, ownerDatabaseUrl } from '../config.js';
import { createSql, RUNTIME_ROLE, type Sql } from './client.js';

/**
 * Gives the runtime role a login (accounts spec 4.9), so the API and workers
 * connect as `retainer_app` and hold no credential that can become the owner.
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
    // A login for a role that can become another would defeat the point.
    const [membership] = await tx<{ roles: string[] }[]>`
      select coalesce(array_agg(m.roleid::regrole::text), '{}') as roles
      from pg_auth_members m
      where m.member = ${RUNTIME_ROLE}::regrole`;
    if (membership && membership.roles.length > 0) {
      throw new Error(
        `${RUNTIME_ROLE} is a member of ${membership.roles.join(', ')}; ` +
          'revoke that before giving it a login.',
      );
    }
    // The verifier holds only base64, digits, `$` and `:`.
    await tx.unsafe(`alter role ${RUNTIME_ROLE} login password '${verifier}'`);
  });
}

/** Sets the runtime login when the config asks for one; see `setRuntimeLogin`. */
export async function applyRuntimeLogin(config: Config, owner?: Sql): Promise<boolean> {
  const url = config.RETAINER_RUNTIME_DATABASE_URL;
  if (!url) return false;
  const password = decodeURIComponent(new URL(url).password);
  const sql = owner ?? createSql(ownerDatabaseUrl(config), { max: 1 });
  try {
    await setRuntimeLogin(sql, password);
  } finally {
    if (!owner) await sql.end({ timeout: 5 });
  }
  return true;
}

/** "RTN" and a number, like the other advisory lock keys. */
const RUNTIME_LOGIN_LOCK = 0x52544e04;

/**
 * A SCRAM-SHA-256 verifier (RFC 7677), the form Postgres stores. Sending it
 * instead of the password keeps the password out of the server's logs.
 */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = 4096,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (buffer: Buffer) => buffer.toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}
