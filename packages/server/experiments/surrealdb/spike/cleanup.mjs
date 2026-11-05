// Removes every database in the retainer_spike namespace, then the namespace:
// for runs that were interrupted before their own cleanup. Touches nothing else.
import { NS, ok } from './lib.mjs';

const [namespaces] = await ok('INFO FOR ROOT;', { ns: undefined, db: undefined });
if (!(NS in (namespaces.namespaces ?? {}))) {
  console.log(`no ${NS} namespace`);
} else {
  const [info] = await ok('INFO FOR NS;', { db: undefined });
  const databases = Object.keys(info.databases ?? {});
  console.log(`removing ${databases.length} database(s) from ${NS}:`, databases);
  for (const db of databases) await ok(`REMOVE DATABASE ${db};`, { db: undefined });
  await ok(`REMOVE NAMESPACE ${NS};`, { ns: undefined, db: undefined });
  console.log(`removed namespace ${NS}`);
}
