// AGPL-3.0-only. Isolated experimental backend, never imported by the application.
// API names may change; these physical identifiers and field keys remain stable.
export const objects = {
  company: { fields: { f_name: 'string' } },
  invoice: { fields: { f_name: 'string', f_amount: 'number', f_status: 'string' } },
  person: { fields: { f_name: 'string', f_email: 'string' } },
  deal: { fields: { f_name: 'string' } },
  stakeholder: { fields: { f_name: 'string', f_role: 'string' } },
  payment: { event: true, fields: { f_name: 'string', f_amount: 'number' } },
  meeting: { event: true, fields: { f_name: 'string' } },
};

export const relations = {
  r_invoice_company: { from: 'invoice', targets: ['company'], many: false, rollUp: true },
  r_payment_invoice: { from: 'payment', targets: ['invoice'], many: false, rollUp: false },
  r_deal_contacts: { from: 'deal', targets: ['person'], many: true, rollUp: false },
  r_deal_customer: { from: 'deal', targets: ['person', 'company'], many: false, rollUp: false },
  r_stakeholder_person: { from: 'stakeholder', targets: ['person'], many: false, rollUp: false },
  r_stakeholder_deal: { from: 'stakeholder', targets: ['deal'], many: false, rollUp: false },
};

export const kindOf = (uid) => uid.split(':')[0];
export function ref(uid) {
  const kind = kindOf(uid);
  if (!objects[kind]) throw new Error(`Unknown object type: ${kind}`);
  return `type::record(${JSON.stringify(`o_${kind}`)}, ${JSON.stringify(uid.slice(kind.length + 1))})`;
}
export const quote = (value) => JSON.stringify(value);
export const tables = [
  ...Object.keys(objects).map((kind) => `o_${kind}`),
  ...Object.keys(relations),
  'event_link',
  'assertion',
  'suppression',
];

export function compileSchema() {
  const statements = [
    'DEFINE TABLE control SCHEMAFULL;',
    'DEFINE FIELD revision ON control TYPE int;',
    'DEFINE FIELD schemaVersion ON control TYPE int;',
    'DEFINE FIELD metadata ON control TYPE object FLEXIBLE;',
  ];
  for (const [kind, definition] of Object.entries(objects)) {
    const table = `o_${kind}`;
    statements.push(
      `DEFINE TABLE ${table} SCHEMAFULL;`,
      `DEFINE FIELD uid ON ${table} TYPE string;`,
      `DEFINE FIELD retracted ON ${table} TYPE bool DEFAULT false;`,
    );
    for (const [key, type] of Object.entries(definition.fields)) {
      statements.push(`DEFINE FIELD ${key} ON ${table} TYPE option<${type}>;`);
    }
    if (definition.event) {
      statements.push(
        `DEFINE FIELD occurredAt ON ${table} TYPE int;`,
        `DEFINE FIELD identityDigest ON ${table} TYPE option<string>;`,
        `DEFINE FIELD initial ON ${table} TYPE object FLEXIBLE;`,
      );
    }
    statements.push(`DEFINE INDEX uid ON ${table} FIELDS uid UNIQUE;`);
    if (definition.event)
      statements.push(`DEFINE INDEX occurrence ON ${table} FIELDS occurredAt, uid;`);
    if (kind === 'invoice')
      statements.push(`DEFINE INDEX amount ON ${table} FIELDS f_amount, uid;`);
  }
  for (const [key, definition] of Object.entries(relations)) {
    statements.push(
      `DEFINE TABLE ${key} TYPE RELATION IN o_${definition.from} OUT ${definition.targets.map((t) => `o_${t}`).join(' | ')} ENFORCED SCHEMAFULL;`,
      `DEFINE FIELD uid ON ${key} TYPE string;`,
      `DEFINE FIELD sourceUid ON ${key} TYPE string;`,
      `DEFINE FIELD targetUid ON ${key} TYPE string;`,
      `DEFINE FIELD assertionId ON ${key} TYPE string;`,
      `DEFINE INDEX membership ON ${key} FIELDS in, out UNIQUE;`,
      `DEFINE INDEX incoming ON ${key} FIELDS out;`,
    );
    if (!definition.many) statements.push(`DEFINE INDEX single_target ON ${key} FIELDS in UNIQUE;`);
  }
  statements.push(
    'DEFINE TABLE event_link TYPE RELATION IN o_payment | o_meeting OUT o_company | o_invoice | o_person | o_deal | o_stakeholder ENFORCED SCHEMAFULL;',
    'DEFINE FIELD uid ON event_link TYPE string;',
    'DEFINE FIELD sourceUid ON event_link TYPE string;',
    'DEFINE FIELD targetUid ON event_link TYPE string;',
    'DEFINE FIELD kind ON event_link TYPE "participant" | "about";',
    'DEFINE INDEX attachment ON event_link FIELDS in, out, kind UNIQUE;',
    'DEFINE INDEX incoming ON event_link FIELDS out, kind;',
    'DEFINE TABLE assertion SCHEMAFULL;',
    'DEFINE FIELD uid ON assertion TYPE string;',
    'DEFINE FIELD subjectUid ON assertion TYPE string;',
    'DEFINE FIELD subject ON assertion TYPE record;',
    'DEFINE FIELD field ON assertion TYPE string;',
    'DEFINE FIELD value ON assertion TYPE any;',
    'DEFINE FIELD actor ON assertion TYPE "user" | "integration" | "agent" | "system";',
    'DEFINE FIELD priority ON assertion TYPE int;',
    'DEFINE FIELD observedAt ON assertion TYPE int;',
    'DEFINE FIELD createdAt ON assertion TYPE int;',
    'DEFINE FIELD status ON assertion TYPE "active" | "superseded" | "pending_review" | "retracted";',
    'DEFINE FIELD sourceUid ON assertion TYPE option<string>;',
    'DEFINE FIELD source ON assertion TYPE option<record<o_payment | o_meeting>>;',
    'DEFINE INDEX claims ON assertion FIELDS subject, field;',
    'DEFINE TABLE suppression SCHEMAFULL;',
    'DEFINE FIELD uid ON suppression TYPE string;',
  );
  return `${statements.join('\n')}\n`;
}
