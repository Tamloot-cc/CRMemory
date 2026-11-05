import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dec, enc } from './cbor.mjs';

export const NS = 'retainer_spike';
export const BASIC = `Basic ${Buffer.from('experiment:local-experiment').toString('base64')}`;

/**
 * The target: the experiment's local SurrealDB (compose.yml) unless cloud.mjs
 * reconfigures it. These are live bindings, so every script sees the change.
 */
export let BASE = `http://127.0.0.1:${process.env.EXPERIMENT_SURREAL_PORT || 18180}`;
export let ADMIN = BASIC;
export let TARGET = 'local';

export function configure({ base, auth, target }) {
  BASE = base;
  ADMIN = auth;
  TARGET = target;
}

export const newDb = (prefix = 'spike') => `${prefix}_${randomBytes(6).toString('hex')}`;

function headers(auth, ns, db, type = 'application/json') {
  const h = { Accept: type, 'Content-Type': type, Authorization: auth };
  if (ns) h['surreal-ns'] = ns;
  if (db) h['surreal-db'] = db;
  return h;
}

/** POST /sql; returns every statement's result object. */
export async function sql(query, { auth = ADMIN, ns = NS, db, raw = false } = {}) {
  const response = await fetch(`${BASE}/sql`, {
    method: 'POST',
    headers: headers(auth, ns, db),
    body: query,
  });
  const text = await response.text();
  if (raw) return { status: response.status, text };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

/** Like `sql`, but throws unless every statement succeeded; returns the results only. */
export async function ok(query, options) {
  const results = await sql(query, options);
  const failed = results.filter((result) => result.status !== 'OK');
  if (failed.length) throw new Error(failed.map((result) => result.result).join('\n'));
  return results.map((result) => result.result);
}

/** Each statement's result, or `ERR <message>`. */
export const statuses = (results) =>
  results.map((r) => (r.status === 'OK' ? r.result : `ERR ${String(r.result).slice(0, 160)}`));

/** POST /rpc with a JSON body. */
export async function rpc(method, params, { auth = ADMIN, ns = NS, db } = {}) {
  const response = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: headers(auth, ns, db),
    body: JSON.stringify({ id: 1, method, params }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** POST /rpc with a CBOR body, as the official SDK sends it. */
export async function rpcCbor(method, params, { auth = ADMIN, ns = NS, db } = {}) {
  const response = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: headers(auth, ns, db, 'application/cbor'),
    body: enc({ id: 1, method, params }),
  });
  return dec(Buffer.from(await response.arrayBuffer()));
}

/** A root session token, so timings exclude per-request password verification. */
export async function rootToken() {
  if (TARGET !== 'local') return ADMIN;
  const response = await fetch(`${BASE}/signin`, {
    method: 'POST',
    headers: headers(undefined, undefined, undefined),
    body: JSON.stringify({ user: 'experiment', pass: 'local-experiment' }),
  });
  const body = await response.json();
  return `Bearer ${body.token ?? body.result ?? body}`;
}

/** An RS256 key pair and a signer for database record-access JWTs. */
export function recordAccessSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    sign(claims) {
      const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}`;
      const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
      return `Bearer ${unsigned}.${signature.toString('base64url')}`;
    },
  };
}

/** p50/p95 in ms over `n` measured calls after `warmup` calls. */
export async function time(n, fn, warmup = 3) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (q) => +samples[Math.min(n - 1, Math.floor(n * q))].toFixed(2);
  return { p50: at(0.5), p95: at(0.95) };
}

export async function createDb(db, auth = ADMIN) {
  await ok(`DEFINE NAMESPACE IF NOT EXISTS ${NS}; USE NS ${NS}; DEFINE DATABASE ${db};`, {
    db: undefined,
    auth,
  });
}

/** Runs `fn` with fresh databases and removes only those databases afterwards. */
export async function withDbs(count, fn, auth = ADMIN) {
  const dbs = Array.from({ length: count }, () => newDb());
  for (const db of dbs) await createDb(db, auth);
  try {
    return await fn(...dbs);
  } finally {
    for (const db of dbs) await ok(`REMOVE DATABASE ${db};`, { db: undefined, auth });
  }
}

export const show = (label, value) =>
  console.log(label.padEnd(48), JSON.stringify(value).slice(0, 300));
