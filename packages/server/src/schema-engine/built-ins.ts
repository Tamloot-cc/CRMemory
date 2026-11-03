import type { BuiltInView } from '@retainer/shared';

/**
 * Interactions and facts, as describe_schema lists them beside the
 * workspace's objects (1.3). They are part of every workspace and fixed by
 * Retainer: listed separately from `objects` so no client mistakes them for
 * something upsert_record can write, and so a person reading the schema
 * sees that the workspace keeps them.
 */
export const BUILT_INS: BuiltInView[] = [
  {
    name: 'interaction',
    labelSingular: 'Interaction',
    labelPlural: 'Interactions',
    description:
      'A meeting, call, email thread, message or note, logged by an agent with its own short ' +
      'summary. Participants are who took part; about lists the records it concerns, such ' +
      'as the company or project of a meeting. Field values and facts cite it as their source.',
    fields: [
      { name: 'kind', type: 'select', description: 'meeting, call, email, message or note' },
      { name: 'channel', type: 'text', description: 'Where it happened, e.g. "zoom" or "gmail"' },
      { name: 'externalId', type: 'text', description: "The source's own ID" },
      { name: 'occurredAt', type: 'date_time', description: 'When it happened' },
      { name: 'title', type: 'text', description: 'A short title' },
      { name: 'summary', type: 'text', description: "The agent's own short summary" },
      {
        name: 'participants',
        type: 'participants',
        description: 'Who took part: emails, phones or records, each with a role',
      },
      { name: 'about', type: 'records', description: 'Records the interaction concerns' },
    ],
    writeWith: ['log_interaction', 'POST /v1/interactions'],
    readWith: [
      'query_interactions',
      'search',
      'get_context',
      'POST /v1/interactions/query',
      'GET /v1/interactions/:id',
    ],
  },
  {
    name: 'fact',
    labelSingular: 'Fact',
    labelPlural: 'Facts',
    description:
      'A plain-language claim about one record that does not fit a field, such as "Legal ' +
      'review at Acme usually takes two weeks", with the interaction it came from.',
    fields: [
      { name: 'record', type: 'relation', description: 'The record the fact is about' },
      { name: 'content', type: 'text', description: 'The fact, in plain language' },
      { name: 'validFrom', type: 'date_time', description: 'When it became true at the source' },
      { name: 'sources', type: 'interactions', description: 'The interactions it rests on' },
    ],
    writeWith: ['remember', 'POST /v1/records/:id/facts'],
    readWith: ['get_context', 'search', 'GET /v1/records/:id/facts'],
  },
];
