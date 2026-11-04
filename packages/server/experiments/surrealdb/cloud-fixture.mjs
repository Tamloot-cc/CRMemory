// Generate a replayable synthetic smoke test. This file never reads Cloud credentials.
// Execute the output through the authenticated SurrealDB MCP connection.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Database } from './database.mjs';
import { CRM } from './model.mjs';
import { compileSchema, objects, quote, relations } from './schema.mjs';

const database = new Database(
  process.env.EXPERIMENT_CLOUD_DATABASE || `trial_cloud_${randomBytes(6).toString('hex')}`,
);
const statements = [
  `DEFINE NAMESPACE IF NOT EXISTS retainer_experiment; USE NS retainer_experiment; DEFINE DATABASE ${database.name}; USE DB ${database.name};`,
  compileSchema(),
  `CREATE control:main CONTENT ${quote({ revision: 0, schemaVersion: 1, metadata: { relations, fields: objects } })};`,
];
try {
  await database.initialize();
  const originalQuery = database.query.bind(database);
  database.query = async (query) => {
    const result = await originalQuery(query);
    if (query.includes('UPDATE control:main CONTENT')) statements.push(query);
    return result;
  };
  const system = new CRM(database, 'system');
  await system.create('company:acme', { f_name: 'Synthetic Acme' }, { observedAt: 1 });
  await system.create(
    'invoice:one',
    {
      f_name: 'Synthetic INV-001',
      f_amount: 12000,
      f_status: 'sent',
      r_invoice_company: 'company:acme',
    },
    { observedAt: 1 },
  );
  const crm = new CRM(database);
  const payment = await crm.logEvent('payment', {
    channel: 'synthetic',
    externalId: 'cloud-smoke',
    occurredAt: 200,
    fields: { f_name: 'Synthetic payment', f_amount: 12000, r_payment_invoice: 'invoice:one' },
  });
  await new CRM(database, 'agent').assert('invoice:one', 'f_status', 'paid', {
    sourceUid: payment,
  });
  statements.push(`IF (SELECT VALUE f_status FROM ONLY o_invoice:one) != 'paid' { THROW 'SMOKE: sourced value was not applied'; };
    IF (SELECT VALUE out.uid FROM r_payment_invoice) != ['invoice:one'] { THROW 'SMOKE: native payment edge missing'; };
    IF (SELECT VALUE out.uid FROM r_invoice_company) != ['company:acme'] { THROW 'SMOKE: company edge missing'; };`);
  await crm.retract(payment);
  statements.push(`IF (SELECT VALUE f_status FROM ONLY o_invoice:one) != 'sent' { THROW 'SMOKE: source retraction did not restore sent'; };
    RETURN { experiment: ${quote(database.name)}, invoiceStatus: (SELECT VALUE f_status FROM ONLY o_invoice:one), retractedClaims: array::len((SELECT * FROM assertion WHERE status = 'retracted')), paymentRetracted: (SELECT VALUE retracted FROM o_payment)[0] };`);
  await mkdir(new URL('.results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('.results/cloud-smoke.surql', import.meta.url),
    `${statements.join('\n')}\n`,
  );
  await writeFile(
    new URL('.results/cloud-smoke-steps.json', import.meta.url),
    `${JSON.stringify(statements, null, 2)}\n`,
  );
  await writeFile(
    new URL('.results/cloud-smoke-meta.json', import.meta.url),
    `${JSON.stringify({ namespace: 'retainer_experiment', database: database.name, fixture: 'synthetic payment/invoice claims, native edges and source retraction' }, null, 2)}\n`,
  );
  console.log(`Generated Cloud smoke fixture for retainer_experiment/${database.name}`);
} finally {
  await database.drop();
}
