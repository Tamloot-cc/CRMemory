import { createHmac, randomUUID } from 'node:crypto';
import { digest } from './database.mjs';
import { kindOf, objects, relations } from './schema.mjs';

const priorities = { user: 4, integration: 3, agent: 2, system: 1 };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};
const node = (state, uid) => state.tables[`o_${kindOf(uid)}`]?.find((item) => item.uid === uid);
const live = (state, uid) => {
  const value = node(state, uid);
  if (!value || value.retracted) throw new Error(`Missing live target: ${uid}`);
  return value;
};
const rank = (a, b) =>
  b.priority - a.priority ||
  b.observedAt - a.observedAt ||
  b.createdAt - a.createdAt ||
  b.uid.localeCompare(a.uid);

function claim(
  state,
  actor,
  subjectUid,
  field,
  input,
  { sourceUid, observedAt = Date.now(), confidence = 1 } = {},
) {
  live(state, subjectUid);
  if (sourceUid) {
    const source = live(state, sourceUid);
    if (!objects[kindOf(sourceUid)]?.event) throw new Error('Evidence must be an event');
    observedAt = source.occurredAt;
  }
  let value = input;
  const relation = state.control.metadata.relations[field];
  if (relation) {
    if (relation.from !== kindOf(subjectUid)) throw new Error('Wrong relation source type');
    if (relation.many) {
      if (!Array.isArray(value)) throw new Error('Collection requires an array');
      value = [...new Set(value)].sort();
    } else if (value !== null && typeof value !== 'string')
      throw new Error('Single relation requires one record ID');
    for (const target of relation.many ? value : value === null ? [] : [value]) {
      live(state, target);
      if (!relation.targets.includes(kindOf(target))) throw new Error('Wrong relation target type');
    }
  } else {
    const type = state.control.metadata.fields[kindOf(subjectUid)]?.fields[field];
    if (!type) throw new Error(`Unknown field: ${field}`);
    if (
      value !== null &&
      (typeof value !== (type === 'string' ? 'string' : 'number') ||
        (type === 'number' && !Number.isFinite(value)))
    )
      throw new Error('Invalid field value');
  }
  const previous = state.tables.assertion
    .filter(
      (item) =>
        item.subjectUid === subjectUid &&
        item.field === field &&
        ['active', 'superseded'].includes(item.status),
    )
    .sort(rank)[0];
  const pending =
    actor === 'agent' &&
    (confidence < 0.7 ||
      (previous &&
        previous.priority > priorities.agent &&
        observedAt > previous.observedAt &&
        !equal(value, previous.value)));
  const uid = randomUUID();
  state.tables.assertion.push({
    uid,
    subjectUid,
    field,
    value,
    actor,
    priority: priorities[actor],
    observedAt,
    createdAt: Date.now(),
    status: pending ? 'pending_review' : 'active',
    ...(sourceUid ? { sourceUid } : {}),
  });
  return { uid, status: pending ? 'pending_review' : 'active' };
}

function recompute(state) {
  // Accepted values and native edges are projections. Pending/retracted claims never win.
  for (const key of Object.keys(relations)) state.tables[key] = [];
  for (const [kind, definition] of Object.entries(objects)) {
    for (const record of state.tables[`o_${kind}`]) {
      for (const field of Object.keys(definition.fields)) delete record[field];
      if (record.retracted) continue;
      const candidates = state.tables.assertion.filter(
        (item) => item.subjectUid === record.uid && ['active', 'superseded'].includes(item.status),
      );
      for (const field of new Set(candidates.map((item) => item.field))) {
        const values = candidates.filter((item) => item.field === field).sort(rank);
        const winner = values[0];
        for (const item of values) item.status = item === winner ? 'active' : 'superseded';
        const relation = state.control.metadata.relations[field];
        if (!relation) {
          if (winner.value !== null && state.control.metadata.fields[kind].fields[field])
            record[field] = winner.value;
          continue;
        }
        for (const targetUid of relation.many
          ? winner.value
          : winner.value === null
            ? []
            : [winner.value]) {
          if (!node(state, targetUid) || node(state, targetUid).retracted) continue;
          state.tables[field].push({
            uid: digest(JSON.stringify([record.uid, field, targetUid])),
            sourceUid: record.uid,
            targetUid,
            assertionId: winner.uid,
          });
        }
      }
    }
  }
}

export class CRM {
  constructor(database, actor = 'user') {
    if (!(actor in priorities)) throw new Error('Invalid actor');
    this.database = database;
    // This is the trusted harness identity, never a write-payload field.
    this.actor = actor;
  }
  async create(uid, fields, options) {
    if (!objects[kindOf(uid)] || objects[kindOf(uid)].event)
      throw new Error('Entities only; use logEvent for events');
    return this.database.mutate((state) => {
      if (node(state, uid)) throw new Error('Duplicate entity ID');
      state.tables[`o_${kindOf(uid)}`].push({ uid, retracted: false });
      for (const [field, value] of Object.entries(fields))
        claim(state, this.actor, uid, field, value, options);
      recompute(state);
      return uid;
    });
  }
  async assert(uid, field, value, options = {}, hooks) {
    return this.database.mutate((state) => {
      const result = claim(state, this.actor, uid, field, value, options);
      recompute(state);
      return {
        ...result,
        status: state.tables.assertion.find((item) => item.uid === result.uid).status,
      };
    }, hooks);
  }
  identity(channel, externalId) {
    // Synthetic local fixture key. Real keys must come from the product's key facility.
    return createHmac('sha256', 'local-experiment-suppression-key')
      .update(JSON.stringify(['event-identity-v1', this.database.name, channel, externalId]))
      .digest('hex');
  }
  async logEvent(kind, { channel, externalId, occurredAt, fields, links = [] }, hooks) {
    if (!objects[kind]?.event) throw new Error('Event type required');
    if (
      typeof channel !== 'string' ||
      !channel ||
      typeof externalId !== 'string' ||
      !externalId ||
      !Number.isSafeInteger(occurredAt)
    )
      throw new Error('Fixture events require channel, externalId and integer occurredAt');
    const identityDigest = this.identity(channel, externalId);
    const uid = `${kind}:${identityDigest}`;
    return this.database.mutate((state) => {
      if (state.tables.suppression.some((item) => item.uid === identityDigest))
        throw new Error('event_retracted');
      // Identity is unique across event types within this workspace.
      const existing = Object.keys(objects)
        .filter((key) => objects[key].event)
        .flatMap((key) => state.tables[`o_${key}`])
        .find((item) => item.identityDigest === identityDigest);
      const initial = canonical({ kind, occurredAt, fields });
      if (existing) {
        if (existing.retracted) throw new Error('event_retracted');
        if (!equal(existing.initial, initial)) throw new Error('event_conflict');
      } else {
        state.tables[`o_${kind}`].push({
          uid,
          retracted: false,
          occurredAt,
          identityDigest,
          initial,
        });
        for (const [field, value] of Object.entries(fields))
          claim(state, this.actor, uid, field, value, { observedAt: occurredAt });
      }
      for (const { targetUid, kind: linkKind } of links) {
        live(state, targetUid);
        if (!['participant', 'about'].includes(linkKind))
          throw new Error('Invalid event link kind');
        const linkUid = digest(JSON.stringify([uid, targetUid, linkKind]));
        if (!state.tables.event_link.some((item) => item.uid === linkUid))
          state.tables.event_link.push({ uid: linkUid, sourceUid: uid, targetUid, kind: linkKind });
      }
      recompute(state);
      return uid;
    }, hooks);
  }
  async retract(uid, hooks) {
    if (!objects[kindOf(uid)]?.event) throw new Error('Event required');
    return this.database.mutate((state) => {
      live(state, uid).retracted = true;
      for (const item of state.tables.assertion)
        if (item.sourceUid === uid) item.status = 'retracted';
      recompute(state);
    }, hooks);
  }
  async eraseEvent(uid, hooks) {
    return this.database.mutate((state) => {
      const event = node(state, uid);
      if (!objects[kindOf(uid)]?.event || !event) throw new Error('Event required');
      state.tables.suppression.push({ uid: event.identityDigest });
      state.tables[`o_${kindOf(uid)}`] = state.tables[`o_${kindOf(uid)}`].filter(
        (item) => item.uid !== uid,
      );
      // Erase initial values, source text and citing assertions rather than retaining a raw copy.
      state.tables.assertion = state.tables.assertion.filter(
        (item) => item.subjectUid !== uid && item.sourceUid !== uid,
      );
      state.tables.event_link = state.tables.event_link.filter(
        (item) => item.sourceUid !== uid && item.targetUid !== uid,
      );
      recompute(state);
    }, hooks);
  }
  async deprecateField(kind, field, hooks) {
    return this.database.mutate((state) => {
      if (this.actor !== 'user') throw new Error('Human approval required');
      if (!objects[kind]?.fields[field] || field === 'f_name')
        throw new Error('Unknown or protected field');
      delete state.control.metadata.fields[kind].fields[field];
      state.control.schemaVersion++;
      recompute(state);
    }, hooks);
  }
  async setRollup(field, enabled) {
    return this.database.mutate((state) => {
      state.control.metadata.relations[field].rollUp = enabled;
      state.control.schemaVersion++;
    });
  }
  async get(uid) {
    return node(await this.database.snapshot(), uid);
  }
}

export async function seed(database) {
  const crm = new CRM(database, 'system');
  for (const [uid, fields] of [
    ['company:acme', { f_name: 'Acme' }],
    ['company:globex', { f_name: 'Globex' }],
    [
      'invoice:one',
      { f_name: 'INV-001', f_amount: 12000, f_status: 'sent', r_invoice_company: 'company:acme' },
    ],
    ['person:alex', { f_name: 'Alex Chen', f_email: 'alex@example.test' }],
    ['person:dana', { f_name: 'Dana Cohen', f_email: 'dana@example.test' }],
    ['person:sam', { f_name: 'Sam Levi', f_email: 'sam@example.test' }],
    [
      'deal:one',
      { f_name: 'Acme renewal', r_deal_contacts: ['person:alex'], r_deal_customer: 'company:acme' },
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
  ])
    await crm.create(uid, fields, { observedAt: 1 });
  await crm.logEvent('meeting', {
    channel: 'calendar',
    externalId: 'intro-meeting',
    occurredAt: 100,
    fields: { f_name: 'Alex introduced Dana' },
    links: [
      { targetUid: 'person:alex', kind: 'participant' },
      { targetUid: 'person:dana', kind: 'participant' },
    ],
  });
  return new CRM(database);
}

// Batched synthetic fixture creation, through the same claim validation and derivation.
// Not an additional public write API.
export async function seedFanout(database, count) {
  const crm = new CRM(database, 'system');
  for (let start = 0; start < count; start += 25) {
    await database.mutate((state) => {
      for (let i = start; i < Math.min(count, start + 25); i++) {
        const invoice = `invoice:fanout_${String(i).padStart(6, '0')}`;
        state.tables.o_invoice.push({ uid: invoice, retracted: false });
        for (const [key, value] of Object.entries({
          f_name: `Invoice ${i}`,
          f_amount: 1000 + i,
          f_status: 'sent',
          r_invoice_company: 'company:acme',
        }))
          claim(state, 'system', invoice, key, value, { observedAt: 1 });
        const identityDigest = crm.identity('synthetic', `fanout-${i}`);
        const uid = `payment:${identityDigest}`;
        const fields = { f_name: `Payment ${i}`, f_amount: 1000 + i, r_payment_invoice: invoice };
        state.tables.o_payment.push({
          uid,
          retracted: false,
          occurredAt: 1000 + i,
          identityDigest,
          initial: canonical({ kind: 'payment', occurredAt: 1000 + i, fields }),
        });
        for (const [key, value] of Object.entries(fields))
          claim(state, 'system', uid, key, value, { observedAt: 1000 + i });
        if (i % 5 === 0)
          state.tables.event_link.push({
            uid: digest(`${uid}:direct`),
            sourceUid: uid,
            targetUid: 'company:acme',
            kind: 'about',
          });
      }
      recompute(state);
    });
  }
}
