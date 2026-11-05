// Runs spike checks against a SurrealDB Cloud instance. Reads one JSON line on
// standard input: {"token": "...", "endpoint": "https://<host>", "checks": [...]}.
// The token stays in memory: never pass it as an argument or put it in a file.
// Every check uses only fresh databases in the retainer_spike namespace.
import { configure } from './lib.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const {
  token,
  endpoint,
  checks = ['latency', 'transport', 'schema', 'access', 'search'],
} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const url = new URL(endpoint);
if (url.protocol !== 'https:' || !/\.surrealdb\.(earth|cloud)$/.test(url.hostname)) {
  throw new Error('The endpoint must be an https SurrealDB Cloud host');
}
const redact = (text) => String(text).replaceAll(token, '<token>');

configure({ base: url.origin, auth: `Bearer ${token}`, target: 'cloud' });
const version = await fetch(new URL('/version', url)).then((r) => r.text());
console.log('cloud /version:', version);
for (const check of checks) {
  if (!/^[a-z]+$/.test(check)) throw new Error(`Unknown check ${check}`);
  console.log(`\n=== ${check}`);
  try {
    await import(`./${check}.mjs`);
  } catch (error) {
    const cause = error.cause ? ` (cause: ${error.cause.code ?? error.cause.message})` : '';
    console.log(`FAILED: ${redact(error.message).slice(0, 500)}${redact(cause)}`);
  }
}
