import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database, PostgresReference } from './database.mjs';
import { CRM, seed } from './model.mjs';
import { events, introductions, normalizeEvents, queryFile } from './reads.mjs';
import { quote } from './schema.mjs';

async function fixture(t) {
  const database = new Database();
  await database.initialize();
  t.after(() => database.drop());
  const crm = await seed(database);
  return { database, crm };
}
const payment = (externalId = 'payment-one', overrides = {}) => ({
  channel: 'bank',
  externalId,
  occurredAt: 200,
  fields: { f_name: 'Payment received', f_amount: 12000, r_payment_invoice: 'invoice:one' },
  ...overrides,
});
function barrier(count = 2) {
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++arrived === count) release();
    await ready;
  };
}

test('payment attaches through its field, rolls up once, deduplicates and prefers participant/about/field', async (t) => {
  const { database, crm } = await fixture(t);
  const uid = await crm.logEvent('payment', payment());
  assert.equal((await events(database, 'invoice:one'))[0].via.kind, 'field');
  assert.deepEqual((await events(database, 'company:acme'))[0], {
    uid,
    occurredAt: 200,
    via: { kind: 'rollup', field: 'r_invoice_company', record: 'invoice:one' },
  });
  await crm.logEvent(
    'payment',
    payment('payment-one', {
      links: [
        { targetUid: 'invoice:one', kind: 'about' },
        { targetUid: 'company:acme', kind: 'about' },
        { targetUid: 'company:acme', kind: 'participant' },
      ],
    }),
  );
  assert.equal((await events(database, 'invoice:one'))[0].via.kind, 'about');
  const company = await events(database, 'company:acme');
  assert.equal(company.length, 1);
  assert.equal(company[0].via.kind, 'participant');
});

test('current grouping moves; explicit links stay fixed; rollup toggles change reads', async (t) => {
  const { database, crm } = await fixture(t);
  await crm.logEvent(
    'payment',
    payment('one', { links: [{ targetUid: 'company:acme', kind: 'about' }] }),
  );
  await crm.assert('invoice:one', 'r_invoice_company', 'company:globex');
  assert.equal((await events(database, 'company:acme'))[0].via.kind, 'about');
  assert.equal((await events(database, 'company:globex'))[0].via.kind, 'rollup');
  await crm.setRollup('r_invoice_company', false);
  assert.equal((await events(database, 'company:globex')).length, 0);
  assert.equal((await events(database, 'company:acme')).length, 1);
});

test('source retraction restores prior scalar and whole-set relationship projections', async (t) => {
  const { database, crm } = await fixture(t);
  const sourceUid = await crm.logEvent('payment', payment());
  const agent = new CRM(database, 'agent');
  await agent.assert('invoice:one', 'f_status', 'paid', { sourceUid, observedAt: 200 });
  await agent.assert('deal:one', 'r_deal_contacts', ['person:dana', 'person:sam'], {
    sourceUid,
    observedAt: 200,
  });
  assert.equal((await crm.get('invoice:one')).f_status, 'paid');
  await crm.retract(sourceUid);
  assert.equal((await crm.get('invoice:one')).f_status, 'sent');
  const snapshot = await database.snapshot();
  assert.deepEqual(
    snapshot.tables.r_deal_contacts.map((item) => item.targetUid),
    ['person:alex'],
  );
  assert.equal((await events(database, 'company:acme')).length, 0);
  await assert.rejects(crm.logEvent('payment', payment()), /event_retracted/);
});

test('pending agent collections never become native edges', async (t) => {
  const { database, crm } = await fixture(t);
  await crm.assert('deal:one', 'r_deal_contacts', ['person:dana'], { observedAt: 100 });
  const older = await crm.assert('deal:one', 'r_deal_contacts', ['person:sam'], { observedAt: 50 });
  assert.equal(older.status, 'superseded');
  const result = await new CRM(database, 'agent').assert(
    'deal:one',
    'r_deal_contacts',
    ['person:sam'],
    { observedAt: 200 },
  );
  assert.equal(result.status, 'pending_review');
  assert.deepEqual(
    (await database.snapshot()).tables.r_deal_contacts.map((item) => item.targetUid),
    ['person:dana'],
  );
});

test('concurrent whole-set replacements rank one complete set without implicit union', async (t) => {
  const { database, crm } = await fixture(t);
  const beforeCommit = barrier();
  await Promise.all([
    crm.assert(
      'deal:one',
      'r_deal_contacts',
      ['person:dana', 'person:dana'],
      { observedAt: 100 },
      { beforeCommit },
    ),
    crm.assert(
      'deal:one',
      'r_deal_contacts',
      ['person:sam'],
      { observedAt: 200 },
      { beforeCommit },
    ),
  ]);
  assert.deepEqual(
    (await database.snapshot()).tables.r_deal_contacts.map((item) => item.targetUid),
    ['person:sam'],
  );
  assert.ok(database.retries >= 1, 'both transactions began from the same revision');
});

test('concurrent writes to different fields both survive a conflict retry', async (t) => {
  const { database } = await fixture(t);
  const crm = new CRM(database, 'agent');
  const beforeCommit = barrier();
  await Promise.all([
    crm.assert('person:alex', 'f_name', 'Alexander Chen', { observedAt: 100 }, { beforeCommit }),
    crm.assert(
      'person:alex',
      'f_email',
      'alexander@example.test',
      { observedAt: 100 },
      { beforeCommit },
    ),
  ]);
  const person = await crm.get('person:alex');
  assert.equal(person.f_name, 'Alexander Chen');
  assert.equal(person.f_email, 'alexander@example.test');
});

test('event retraction racing a citing write cannot leave an eligible claim', async (t) => {
  const { database, crm } = await fixture(t);
  const sourceUid = await crm.logEvent('payment', payment());
  const beforeCommit = barrier();
  const outcomes = await Promise.allSettled([
    crm.assert('invoice:one', 'f_status', 'paid', { sourceUid, observedAt: 200 }, { beforeCommit }),
    crm.retract(sourceUid, { beforeCommit }),
  ]);
  assert.equal(outcomes[1].status, 'fulfilled');
  if (outcomes[0].status === 'rejected')
    assert.match(outcomes[0].reason.message, /Missing live target/);
  assert.equal((await crm.get('invoice:one')).f_status, 'sent');
  assert.equal(
    (await database.snapshot()).tables.assertion.filter(
      (item) => item.sourceUid === sourceUid && ['active', 'superseded'].includes(item.status),
    ).length,
    0,
  );
});

test('schema deprecation racing a write cannot commit a stale-schema projection', async (t) => {
  const { database, crm } = await fixture(t);
  const beforeCommit = barrier();
  const outcomes = await Promise.allSettled([
    crm.assert('invoice:one', 'f_status', 'paid', {}, { beforeCommit }),
    crm.deprecateField('invoice', 'f_status', { beforeCommit }),
  ]);
  assert.equal(outcomes[1].status, 'fulfilled');
  if (outcomes[0].status === 'rejected') assert.match(outcomes[0].reason.message, /Unknown field/);
  assert.equal((await crm.get('invoice:one')).f_status, undefined);
  await assert.rejects(crm.assert('invoice:one', 'f_status', 'paid'), /Unknown field/);
  assert.equal((await database.snapshot()).control.schemaVersion, 2);
});

test('erasure racing a log retry suppresses reingestion and retains no raw event content', async (t) => {
  const { database, crm } = await fixture(t);
  const input = payment('identifying-external-id', {
    channel: 'identifying-channel',
    fields: {
      f_name: 'identifying-secret-text',
      f_amount: 12000,
      r_payment_invoice: 'invoice:one',
    },
  });
  const uid = await crm.logEvent('payment', input);
  const beforeCommit = barrier();
  const outcomes = await Promise.allSettled([
    crm.logEvent('payment', input, { beforeCommit }),
    crm.eraseEvent(uid, { beforeCommit }),
  ]);
  assert.equal(outcomes[1].status, 'fulfilled');
  if (outcomes[0].status === 'rejected')
    assert.match(outcomes[0].reason.message, /event_retracted/);
  await assert.rejects(crm.logEvent('payment', input), /event_retracted/);
  const snapshot = await database.snapshot();
  assert.equal(snapshot.tables.suppression.length, 1);
  for (const secret of [
    'identifying-external-id',
    'identifying-channel',
    'identifying-secret-text',
  ])
    assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.equal(await crm.get(uid), undefined);
});

test('event identity retries compare initial fields after edits and add missing links once', async (t) => {
  const { database, crm } = await fixture(t);
  const uid = await crm.logEvent('payment', payment());
  await crm.assert(uid, 'f_name', 'Corrected title');
  const beforeCommit = barrier();
  await Promise.all([
    crm.logEvent(
      'payment',
      payment('payment-one', { links: [{ targetUid: 'company:acme', kind: 'about' }] }),
      { beforeCommit },
    ),
    crm.logEvent(
      'payment',
      payment('payment-one', { links: [{ targetUid: 'person:dana', kind: 'participant' }] }),
      { beforeCommit },
    ),
  ]);
  assert.equal((await crm.get(uid)).f_name, 'Corrected title');
  assert.equal(
    (await database.snapshot()).tables.event_link.filter((item) => item.sourceUid === uid).length,
    2,
  );
  await assert.rejects(
    crm.logEvent(
      'payment',
      payment('payment-one', { fields: { f_name: 'Different', f_amount: 12000 } }),
    ),
    /event_conflict/,
  );
});

test('polymorphic targets validate; invalid collections roll back as a whole', async (t) => {
  const { database, crm } = await fixture(t);
  await crm.assert('deal:one', 'r_deal_customer', 'person:dana');
  assert.equal((await database.snapshot()).tables.r_deal_customer[0].targetUid, 'person:dana');
  await assert.rejects(
    crm.assert('deal:one', 'r_deal_customer', 'invoice:one'),
    /Wrong relation target type/,
  );
  await assert.rejects(
    crm.assert('deal:one', 'r_deal_contacts', ['person:sam', 'person:missing']),
    /Missing live target/,
  );
  assert.deepEqual(
    (await database.snapshot()).tables.r_deal_contacts.map((item) => item.targetUid),
    ['person:alex'],
  );
  await assert.rejects(
    crm.assert('invoice:one', 'f_status', 'paid', { sourceUid: 'company:acme' }),
    /Evidence must be an event/,
  );
});

test('native endpoint types, endpoint existence and single-target index survive bypassing the harness', async (t) => {
  const { database } = await fixture(t);
  const row = quote({
    uid: 'bypass',
    sourceUid: 'invoice:one',
    targetUid: 'company:globex',
    assertionId: 'bypass',
  });
  await assert.rejects(
    database.query(
      `RELATE o_invoice:one->r_invoice_company:bypass->o_company:globex CONTENT ${row};`,
    ),
    /unique|already contains|index/i,
  );
  await assert.rejects(
    database.query(
      `RELATE o_invoice:missing->r_invoice_company:bypass->o_company:globex CONTENT ${row};`,
    ),
    /exist/i,
  );
  await assert.rejects(
    database.query(`RELATE o_invoice:one->r_invoice_company:bypass->o_person:dana CONTENT ${row};`),
    /type|record|field/i,
  );
});

test('equal-time event pagination deduplicates before limiting and preserves tie order', async (t) => {
  const { database, crm } = await fixture(t);
  for (let i = 0; i < 5; i++)
    await crm.logEvent(
      'payment',
      payment(`page-${i}`, { links: [{ targetUid: 'company:acme', kind: 'about' }] }),
    );
  const all = await events(database, 'company:acme');
  const pages = [];
  let cursor = {};
  for (;;) {
    const page = await events(database, 'company:acme', { ...cursor, limit: 2 });
    if (!page.length) break;
    pages.push(...page);
    cursor = { beforeTime: page.at(-1).occurredAt, beforeUid: page.at(-1).uid };
  }
  assert.deepEqual(pages, all);
  assert.equal(new Set(pages.map((item) => item.uid)).size, 5);
});

test('native graph introduction paths agree with PostgreSQL and exclude about-only meetings', async (t) => {
  const { database, crm } = await fixture(t);
  await crm.logEvent('meeting', {
    channel: 'calendar',
    externalId: 'decoy',
    occurredAt: 300,
    fields: { f_name: 'Merely about Dana' },
    links: [
      { targetUid: 'person:dana', kind: 'about' },
      { targetUid: 'person:sam', kind: 'participant' },
    ],
  });
  const reference = new PostgresReference();
  t.after(() => reference.close());
  await reference.load(await database.snapshot());
  const actual = await introductions(database, 'deal:one');
  assert.equal(actual.length, 1);
  assert.equal(actual[0].introducer, 'person:alex');
  assert.deepEqual(actual, Array.from(await reference.query('introductions', ['deal:one', 20])));
});

test('event rollup and ordinary invoice sorting agree with a real PostgreSQL read reference', async (t) => {
  const { database, crm } = await fixture(t);
  await crm.logEvent(
    'payment',
    payment('reference', { links: [{ targetUid: 'company:acme', kind: 'about' }] }),
  );
  await crm.create('invoice:two', {
    f_name: 'INV-002',
    f_amount: 9000,
    f_status: 'sent',
    r_invoice_company: 'company:globex',
  });
  const reference = new PostgresReference();
  t.after(() => reference.close());
  await reference.load(await database.snapshot());
  assert.deepEqual(
    await events(database, 'company:acme'),
    normalizeEvents(
      await reference.query('events', ['company:acme', Number.MAX_SAFE_INTEGER, '~', 20, true]),
    ),
  );
  const actual = await queryFile(database, 'invoices', {
    afterAmount: -1,
    afterUid: '',
    limit: 20,
  });
  const expected = await reference.query('invoices', [-1, '', 20]);
  assert.deepEqual(
    actual,
    expected.map((row) => ({ ...row, amount: Number(row.amount) })),
  );
});

test('separate workspace databases do not share records or suppression tokens (not an auth test)', async (t) => {
  const { database: first, crm: firstCRM } = await fixture(t);
  const { database: second, crm: secondCRM } = await fixture(t);
  await firstCRM.assert('person:alex', 'f_name', 'Only in first workspace');
  assert.equal((await secondCRM.get('person:alex')).f_name, 'Alex Chen');
  const input = payment('same-external-identity');
  const erased = await firstCRM.logEvent('payment', input);
  await firstCRM.eraseEvent(erased);
  await assert.rejects(firstCRM.logEvent('payment', input), /event_retracted/);
  assert.ok(await secondCRM.logEvent('payment', input));
  assert.notEqual(first.name, second.name);
});
