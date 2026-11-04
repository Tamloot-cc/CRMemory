// Direct Cloud SQL fallback when Earth's instance MCP route is unavailable.
// Read a broker-issued short-lived token from one stdin JSON line. Never persist it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Database, RetryConflict, writeReport } from './database.mjs';
import { CRM } from './model.mjs';
import { events, introductions } from './reads.mjs';
import { compileSchema } from './schema.mjs';

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
const input = await new Promise((resolve, reject) => {
  reader.once('line', resolve);
  reader.once('error', reject);
});
reader.close();
process.stdin.pause();
const {
  token,
  endpoint,
  mode = 'probe',
  query: queryText,
  namespace,
  database,
} = JSON.parse(input);
const url = new URL(endpoint);
if (
  url.protocol !== 'https:' ||
  url.hostname !== '06gqgdeeopvn31kjrjo9hrq4cs.surrealdb.earth' ||
  url.pathname !== '/'
)
  throw new Error('Unexpected Cloud endpoint');
if (typeof token !== 'string' || token.length < 20)
  throw new Error('Expected short-lived database token on stdin');
const redact = (text) => String(text).replaceAll(token, '[REDACTED]');

async function query(text, { namespace, database } = {}) {
  const response = await fetch(new URL('/sql', url), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(namespace ? { 'surreal-ns': namespace } : {}),
      ...(database ? { 'surreal-db': database } : {}),
    },
    body: text,
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Cloud HTTP ${response.status}: ${redact(body)}`);
  const results = JSON.parse(body);
  const failures = results.filter((item) => item.status !== 'OK');
  if (failures.length) throw new Error(redact(JSON.stringify(failures)));
  return results;
}

try {
  if (mode === 'probe') {
    const results = await query('RETURN 1; INFO FOR ROOT;');
    assert.equal(results[0].result, 1);
    console.log(
      JSON.stringify({
        connected: true,
        endpoint: url.origin,
        result: results.map((item) => item.result),
      }),
    );
  } else if (mode === 'query') {
    if (typeof queryText !== 'string' || !queryText.trim()) throw new Error('Expected query text');
    const results = await query(queryText, { namespace, database });
    console.log(
      JSON.stringify(
        results.map((item) => item.result),
        null,
        2,
      ),
    );
  } else if (mode === 'explore') {
    const metadata = JSON.parse(
      await readFile(new URL('.results/cloud-smoke-meta.json', import.meta.url), 'utf8'),
    );
    if (
      metadata.namespace !== 'retainer_experiment' ||
      !/^trial_cloud_[a-z0-9]+$/.test(metadata.database)
    )
      throw new Error('Unexpected experiment context');
    const database = new Database(metadata.database);
    database.query = async (text) => {
      try {
        return (await query(text, metadata)).map((item) => item.result);
      } catch (error) {
        if (
          /EXPERIMENT_RETRY|can be retried|transaction conflict|read or write conflict/i.test(
            error.message,
          )
        )
          throw new RetryConflict(error.message);
        throw error;
      }
    };
    const system = new CRM(database, 'system');
    for (const [uid, fields] of [
      ['company:globex', { f_name: 'Synthetic Globex' }],
      ['person:alex', { f_name: 'Alex Chen', f_email: 'alex@example.test' }],
      ['person:dana', { f_name: 'Dana Cohen', f_email: 'dana@example.test' }],
      ['person:sam', { f_name: 'Sam Levi', f_email: 'sam@example.test' }],
      [
        'deal:one',
        {
          f_name: 'Acme renewal',
          r_deal_contacts: ['person:alex'],
          r_deal_customer: 'company:acme',
        },
      ],
      [
        'stakeholder:buyer',
        {
          f_name: 'Dana on Acme renewal',
          f_role: 'decision_maker',
          r_stakeholder_person: 'person:dana',
          r_stakeholder_deal: 'deal:one',
        },
      ],
    ]) {
      const existing = await system.get(uid);
      if (!existing) await system.create(uid, fields, { observedAt: 1 });
      else
        for (const [field, value] of Object.entries(fields))
          if (field.startsWith('f_'))
            assert.deepEqual(
              existing[field],
              value,
              `Existing fixture record changed: ${uid}/${field}`,
            );
      console.log(JSON.stringify({ phase: 'entity', uid }));
    }
    await system.logEvent('meeting', {
      channel: 'calendar',
      externalId: 'cloud-introduction',
      occurredAt: 300,
      fields: { f_name: 'Alex introduced Dana' },
      links: [
        { targetUid: 'person:alex', kind: 'participant' },
        { targetUid: 'person:dana', kind: 'participant' },
      ],
    });
    const payment = await system.logEvent('payment', {
      channel: 'synthetic',
      externalId: 'cloud-active-payment',
      occurredAt: 400,
      fields: {
        f_name: 'Active synthetic payment',
        f_amount: 12000,
        r_payment_invoice: 'invoice:one',
      },
    });
    if ((await system.get('invoice:one')).f_status !== 'paid')
      await new CRM(database, 'agent').assert('invoice:one', 'f_status', 'paid', {
        sourceUid: payment,
      });
    const companyEvents = await events(database, 'company:acme');
    const introductionPaths = await introductions(database, 'deal:one');
    assert.equal(companyEvents.length, 1);
    assert.equal(companyEvents[0].uid, payment);
    assert.equal(companyEvents[0].via.kind, 'rollup');
    assert.equal(introductionPaths.length, 1);
    assert.equal(introductionPaths[0].buyer, 'person:dana');
    assert.equal(introductionPaths[0].introducer, 'person:alex');
    const snapshot = await database.snapshot();
    const report = {
      verifiedAt: new Date().toISOString(),
      endpoint: url.origin,
      namespace: metadata.namespace,
      database: metadata.database,
      counts: Object.fromEntries(
        Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length]),
      ),
      invoice: await system.get('invoice:one'),
      companyEvents,
      introductionPaths,
    };
    await writeReport('cloud-exploration', report);
    console.log(JSON.stringify(report, null, 2));
  } else if (mode === 'smoke') {
    const metadata = JSON.parse(
      await readFile(new URL('.results/cloud-smoke-meta.json', import.meta.url), 'utf8'),
    );
    if (
      metadata.namespace !== 'retainer_experiment' ||
      !/^trial_cloud_[a-z0-9]+$/.test(metadata.database)
    )
      throw new Error('Unexpected experiment context');
    const steps = JSON.parse(
      await readFile(new URL('.results/cloud-smoke-steps.json', import.meta.url), 'utf8'),
    );
    await query(
      `DEFINE NAMESPACE IF NOT EXISTS ${metadata.namespace}; USE NS ${metadata.namespace}; DEFINE DATABASE IF NOT EXISTS ${metadata.database};`,
    );
    // Each DEFINE stands alone in compiler output. Keep empty-schema setup requests small
    // and resumable; a timeout does not mean earlier statements were rolled back.
    const definitions = compileSchema()
      .trim()
      .split('\n')
      .map((statement) =>
        statement.replace(/^DEFINE (TABLE|FIELD|INDEX) /, 'DEFINE $1 IF NOT EXISTS '),
      );
    let statementCount = 0;
    for (let i = 0; i < definitions.length; i += 4) {
      const results = await query(definitions.slice(i, i + 4).join('\n'), metadata);
      statementCount += results.length;
      console.log(
        JSON.stringify({
          phase: 'schema',
          completed: Math.min(i + 4, definitions.length),
          total: definitions.length,
        }),
      );
    }
    let control = (await query('SELECT * FROM control:main;', metadata))[0].result[0];
    if (!control) {
      await query(steps[2], metadata);
      control = (await query('SELECT * FROM control:main;', metadata))[0].result[0];
    }
    if (control.schemaVersion !== 1 || !Number.isInteger(control.revision))
      throw new Error('Unexpected experiment control state');
    for (const step of steps.slice(3)) {
      const match = step.match(/!=\s*(\d+)\s*\{ THROW 'EXPERIMENT_RETRY'/);
      const currentRevision = (
        await query('SELECT VALUE revision FROM ONLY control:main;', metadata)
      )[0].result;
      if (match) {
        const expectedRevision = Number(match[1]);
        if (currentRevision > expectedRevision) continue;
        if (currentRevision !== expectedRevision)
          throw new Error('Unexpected gap in experiment revisions');
        await query(step, metadata);
        console.log(JSON.stringify({ phase: 'data', revision: expectedRevision + 1 }));
      } else if (step.includes('sourced value was not applied')) {
        // This checkpoint is historical once the retraction transaction has committed.
        if (currentRevision === 4) await query(step, metadata);
        else if (currentRevision !== 5) throw new Error('Unexpected pre-retraction checkpoint');
      }
    }
    const results = await query(steps.at(-1), metadata);
    const summary = results.at(-1).result;
    assert.equal(summary.experiment, metadata.database);
    assert.equal(summary.invoiceStatus, 'sent');
    assert.equal(summary.paymentRetracted, true);
    assert.equal(summary.retractedClaims, 1);
    const schema = (await query('INFO FOR DB;', metadata))[0].result;
    const counts = (
      await query(
        'RETURN { companies: count(SELECT * FROM o_company), invoices: count(SELECT * FROM o_invoice), payments: count(SELECT * FROM o_payment), assertions: count(SELECT * FROM assertion), invoiceCompanyEdges: count(SELECT * FROM r_invoice_company) };',
        metadata,
      )
    )[0].result;
    const report = {
      verifiedAt: new Date().toISOString(),
      endpoint: url.origin,
      ...metadata,
      transport: 'Direct HTTPS /sql with a broker-issued short-lived token (not persisted)',
      serverVersion: await (await fetch(new URL('/version', url))).text(),
      statementCount,
      tables: Object.keys(schema.tables),
      counts,
      summary,
    };
    await writeReport('cloud-verification', report);
    console.log(JSON.stringify(report, null, 2));
  } else throw new Error('Unsupported Cloud mode');
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
