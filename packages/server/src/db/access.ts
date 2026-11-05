import {
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { accessName } from './names.js';

/**
 * Record-access JWTs for runtime database sessions (spec section 4). Retainer
 * signs them with a server-side RS256 key; each workspace database defines
 * one access method per accepted key (`backend_<key id>`), and the server
 * signs with the newest key a workspace has.
 */

export type SigningKey = {
  id: string;
  privateKey: KeyObject;
  /** SPKI PEM, as `DEFINE ACCESS … KEY` takes it. */
  publicKeyPem: string;
};

export type SigningKeys = {
  /** New access methods are defined for this key. */
  current: SigningKey;
  /** Still accepted until every workspace has the current key. */
  previous: SigningKey[];
  /**
   * Compromised key IDs: removed in the same upgrade that adds the current
   * key, rather than after every workspace has moved (section 4).
   */
  revoked: string[];
};

/** `id:base64(PKCS#8 PEM)` → a signing key. */
export function parseSigningKey(entry: string): SigningKey {
  const separator = entry.indexOf(':');
  if (separator <= 0) throw new Error('a signing key is "<id>:<base64 PKCS#8 PEM>"');
  const id = entry.slice(0, separator).trim();
  accessName(id);
  const raw = entry.slice(separator + 1).trim();
  const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const privateKey = createPrivateKey(pem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  return { id, privateKey, publicKeyPem: String(publicKeyPem) };
}

export function parseSigningKeys(input: {
  current: string;
  previous?: string;
  revoked?: string;
}): SigningKeys {
  const list = (value: string | undefined) =>
    (value ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  const current = parseSigningKey(input.current);
  const previous = list(input.previous).map(parseSigningKey);
  const revoked = list(input.revoked);
  if (revoked.includes(current.id)) throw new Error('the current signing key cannot be revoked');
  return { current, previous: previous.filter((k) => !revoked.includes(k.id)), revoked };
}

/** A new key entry for configuration: `id:base64(PEM)`. */
export function generateSigningKeyEntry(id = `k${Date.now().toString(36)}`): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return `${id}:${Buffer.from(String(pem)).toString('base64')}`;
}

/** Every key still accepted: current first. */
export const acceptedKeys = (keys: SigningKeys) => [keys.current, ...keys.previous];

/** Token lifetime; refreshed a minute before expiry. */
const TOKEN_SECONDS = 15 * 60;

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs a record-access token bound to one namespace, database and access method. */
export function signAccessToken(
  key: SigningKey,
  target: { namespace: string; database: string },
  now = Date.now(),
): { token: string; expiresAt: number } {
  const iat = Math.floor(now / 1000);
  const exp = iat + TOKEN_SECONDS;
  const claims = {
    iss: 'retainer',
    iat,
    nbf: iat - 30,
    exp,
    ns: target.namespace,
    db: target.database,
    ac: accessName(key.id),
    id: 'principal:backend',
  };
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT', kid: key.id })}.${part(claims)}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.privateKey);
  return { token: `${unsigned}.${signature.toString('base64url')}`, expiresAt: exp * 1000 };
}

/** The definition of a key's access method, for a database. */
export function defineAccess(key: SigningKey): string {
  const pem = key.publicKeyPem.trim().replace(/\n/g, '\\n');
  return `DEFINE ACCESS OVERWRITE ${accessName(key.id)} ON DATABASE TYPE RECORD WITH JWT ALGORITHM RS256 KEY "${pem}" DURATION FOR TOKEN 15m, FOR SESSION 15m;`;
}
