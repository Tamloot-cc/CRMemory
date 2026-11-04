import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { errorBody, toAppError } from '../api/http.js';
import { missingScope } from '../auth/middleware.js';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope } from '../db/schema.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { MAX_PARTICIPANTS, participantInputSchema } from '../memory/event-links.js';
import { logEventInputSchema } from '../memory/events.js';
import { rememberInputSchema } from '../memory/facts.js';
import { logEventFor, remember } from '../memory/service.js';
import { queryInputSchema } from '../records/query.js';
import {
  type Caller,
  createRecord,
  findRecords,
  readRecord,
  upsertInputSchema,
  upsertRecord,
  valuesSchema,
} from '../records/service.js';
import { contextInputSchema } from '../retrieval/context.js';
import { searchInputSchema } from '../retrieval/search.js';
import { contextFor, searchFor } from '../retrieval/service.js';
import {
  describeSchema,
  requestSchemaChange,
  schemaChangeRequestSchema,
} from '../schema-engine/service.js';
import { applyTemplateFor, templatesFor } from '../templates/service.js';
import { VERSION } from '../version.js';
import { GUIDE_NAMES, GUIDES } from './guides.js';

/**
 * The MCP tools (6.2). They are generic, not one per object, and each calls
 * the same service as its REST route, so both interfaces share validation,
 * write rules and error messages; get_guide is the exception, serving static
 * text that only agents need. The workspace and actor come from the API
 * key, so no tool takes either.
 */

const INSTRUCTIONS = `Retainer is the memory of a CRM workspace: people, companies, tasks and
any objects the workspace adds. You are connected to one workspace through one
API key; every call acts on it, and every write is recorded as yours.

Start with describe_schema. If the workspace is not initialized, read
get_guide("discover_schema") and follow it: it walks you through exploring
your user's data, proposing a schema and applying it once they agree. If you
cannot do that now, pick a template with list_templates and apply_template,
or ask your user.

Find records with search (keywords across records, events and facts) or
query_records (exact filters on one object). Events (meetings, calls, emails,
messages, notes and any event types the workspace adds) are records too: list
or filter them with query_records on their type, and pass linked to get the
events attached to one record. Before working on a person or company, read
get_context: their current values, open tasks, facts and recent events in one
call. Write records with upsert_record. Write the values you learned; Retainer
keeps every claim's history and decides which value wins. A value a person set
outranks yours, so your write may come back as pending_review: tell your user
it is waiting for approval rather than saying it is done.

After a meeting, call, email thread or chat, write what you learned in order:
1. log_event: its type (describe_schema lists the event types), channel, when
   it happened, a title, your own short summary, the source's external ID, the
   participants' emails or phones (or record IDs), and in about the IDs of the
   company, project or other records it concerns. Keep the id it returns.
   Unmatched participants come back with a reason; create the people worth
   keeping with upsert_record, or leave them. Retainer never creates records
   on its own.
2. upsert_record with source set to that event id, so the values carry its
   date and an older email cannot overwrite a newer claim.
3. remember, citing the same source (with a short quote if useful), for
   plain-language facts that do not fit a field.
4. upsert_record for tasks someone committed to, as task records.
Each call is its own write, so you can stop and resume; logging the same
externalId again returns the same event, adding any participants and about
records it did not have yet.

When a field you need does not exist, use propose_schema_change. Adding is
applied at once; removing or renaming waits for a person to approve. Read
get_guide("schema_design") once before you first add an object.

Errors are JSON { error: { code, message, details } }. Messages say what was
wrong and what is allowed, so read them and retry.`;

/** A successful result: the JSON as text, and as structured content; a string as plain text. */
function ok(result: object | string): CallToolResult {
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

/** A tool error carrying the same body REST returns. */
function failure(error: AppError): CallToolResult {
  const body = errorBody(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

/** Checks the key's scope, runs the call and maps errors like REST does. */
async function run(
  caller: Caller,
  scope: ApiKeyScope,
  fn: () => Promise<object | string>,
  isFailure: (result: object | string) => boolean = () => false,
): Promise<CallToolResult> {
  const missing = missingScope(caller.scopes, scope);
  if (missing) return failure(missing);
  try {
    const result = await fn();
    return isFailure(result) ? { ...ok(result), isError: true } : ok(result);
  } catch (error) {
    const known = toAppError(error);
    if (known) return failure(known);
    log.error(error);
    return failure(new AppError(500, 'internal', 'internal server error'));
  }
}

const objectName = z
  .string()
  .min(1)
  .describe('Singular API name of the object, e.g. "person", as describe_schema lists it.');

const getRecordInput = z.strictObject({
  id: z.uuid().describe('The record ID. An ID merged into another record returns the survivor.'),
});

const queryRecordsInput = z.strictObject({
  object: objectName,
  ...queryInputSchema.shape,
  filter: queryInputSchema.shape.filter.describe(
    'Field name to a value (equality) or to operators: eq, neq, in, gt, gte, lt, lte, ' +
      'e.g. { "status": "todo", "dueDate": { "lte": "2026-11-30" } }. Only filterable fields. ' +
      'Event types also filter and sort by occurredAt, channel and externalId. A ' +
      'many_to_many relation takes containsAny or containsAll (lists of record IDs) and ' +
      'isEmpty (true or false), e.g. { "contacts": { "containsAny": ["<person id>"] } }.',
  ),
  cursor: queryInputSchema.shape.cursor.describe('nextCursor from the previous page.'),
});

const upsertRecordInput = z.strictObject({
  object: objectName,
  ...upsertInputSchema.shape,
  id: upsertInputSchema.shape.id.describe('Update this record.'),
  match: upsertInputSchema.shape.match.describe(
    'Find the record by one unique field and its value, e.g. { "emails": "dana@acme.com" }. ' +
      'Names and phones are not unique: find those records with search or query_records first.',
  ),
  values: valuesSchema
    .default({})
    .describe(
      'Field name to value. Composite fields (emails, phones, links, money, full_name, ' +
        'address) are replaced whole, so include the values to keep. null clears a field. ' +
        'A many_to_many relation takes the whole list of record IDs ([] clears it): read ' +
        'the record first and send every member to keep. Fields marked readOnly (isInverse) ' +
        'are written from the other side.',
    ),
  ifMissing: upsertInputSchema.shape.ifMissing.describe(
    'When id or match finds nothing: "fail" (default) or "create". Use "create" only ' +
      'when you mean to add a new record.',
  ),
  expectedUpdatedAt: upsertInputSchema.shape.expectedUpdatedAt.describe(
    'Reject the write if the record changed since this updatedAt.',
  ),
  source: upsertInputSchema.shape.source.describe(
    'The event id (from log_event) these values come from. Values then carry the ' +
      "event's date, so an older email cannot overwrite a newer claim. Omit only for " +
      'values that come from no conversation.',
  ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Only for creates without id or match: retrying with the same key returns the first ' +
        'result instead of creating a second record.',
    ),
});

const logEventInput = z.strictObject({
  ...logEventInputSchema.shape,
  type: logEventInputSchema.shape.type.describe(
    'The event type\'s API name, e.g. "meeting", "call", "email", "message" or "note", or ' +
      'one the workspace added. describe_schema lists them as objects of class "event".',
  ),
  channel: logEventInputSchema.shape.channel.describe(
    'Where it happened, e.g. "gmail", "zoom", "whatsapp". Use a distinct channel per source ' +
      'account when their external IDs could overlap.',
  ),
  externalId: logEventInputSchema.shape.externalId.describe(
    "The source's own ID (message, thread, meeting or call ID). Logging it again with the " +
      'same input returns the same event; without it, retries log duplicates.',
  ),
  occurredAt: logEventInputSchema.shape.occurredAt.describe(
    'When it happened, ISO 8601 with a UTC offset, e.g. "2026-10-29T14:00:00+02:00".',
  ),
  title: logEventInputSchema.shape.title.describe('A short title.'),
  summary: logEventInputSchema.shape.summary.describe(
    'Your own short summary. Not a transcript or message body: store only what the ' +
      'workspace should keep.',
  ),
  fields: logEventInputSchema.shape.fields.describe(
    'The event type\'s other fields by name, e.g. { "deal": "<record id>" } for a call ' +
      'type with a deal relation. Title and summary go at the top level, not here.',
  ),
  participants: z
    .array(
      z.strictObject({
        handle: participantInputSchema.shape.handle.describe('An email address or phone number.'),
        recordId: participantInputSchema.shape.recordId.describe(
          'The record of this participant, when you know it. Needed to link a participant ' +
            'known only by phone.',
        ),
        role: participantInputSchema.shape.role.describe(
          'The part they played, in your words, e.g. "customer", "from", "attendee".',
        ),
      }),
    )
    .max(MAX_PARTICIPANTS)
    .default([])
    .describe(
      'Who took part (people only); each needs a handle, a recordId, or both. Records the ' +
        'event concerns, such as a company or project, go in about.',
    ),
  about: logEventInputSchema.shape.about.describe(
    'IDs of records the event is about, of any object: the company, project, deal or ' +
      "tasks it concerns. It then shows in those records' get_context and query_records " +
      'with linked. Unknown or deleted IDs fail the call.',
  ),
});

const rememberInput = z.strictObject({
  record: z.uuid().describe('The record the fact is about.'),
  ...rememberInputSchema.shape,
  text: rememberInputSchema.shape.text.describe(
    'One plain-language fact, e.g. "Legal review at Acme usually takes two weeks."',
  ),
  source: rememberInputSchema.shape.source.describe(
    'The event id (from log_event) the fact comes from; the fact is valid from that ' +
      "event's date. Without it, the fact rests on an internal note Retainer keeps for it.",
  ),
  quote: rememberInputSchema.shape.quote.describe(
    'Optional short quote from the source that supports the fact. Needs source.',
  ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Retrying with the same key returns the first result instead of a second fact.'),
});

const searchInput = z.strictObject({
  query: searchInputSchema.shape.query.describe(
    'Keywords. Each word also matches longer words it starts ("meet" finds "meetings", ' +
      '"Dan" finds "Dana"); exact matches rank first. Accents are ignored. Other forms of a ' +
      'word need OR, e.g. "ran OR run". Use "quotes" for a phrase and -word to exclude a word.',
  ),
  limit: searchInputSchema.shape.limit.describe('Hits per type, 10 by default (at most 50).'),
});

const getContextInput = z.strictObject({
  record: z
    .uuid()
    .describe('The record ID. An ID merged into another record returns the survivor.'),
  tokenBudget: contextInputSchema.shape.tokenBudget.describe(
    "Approximate size of the pack in tokens, 2000 by default (at most 16000). The record's " +
      'values are always included; tasks, facts and events fill the rest.',
  ),
});

const applyTemplateInput = z.strictObject({
  name: z.string().min(1).describe('Template name from list_templates, e.g. "sales" or "blank".'),
});

const GUIDE_LIST = GUIDE_NAMES.map((name) => `"${name}": ${GUIDES[name].description}`).join(' ');

const getGuideInput = z.strictObject({
  name: z.enum(GUIDE_NAMES).describe('The guide to read, e.g. "discover_schema".'),
});

const noInput = z.strictObject({});

/** Builds the MCP server for one authenticated caller. */
export function createMcpServer(sql: Sql, caller: Caller): McpServer {
  const server = new McpServer(
    { name: 'retainer', title: 'Retainer', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'describe_schema',
    {
      title: 'Describe the workspace schema',
      description:
        'Returns the workspace (id, name, applied templates, initialized, schemaVersion) and ' +
        'every object with its fields: type, options, and whether it is unique, filterable or ' +
        'required. Objects of class "event" are event types (meeting, call, email, ...): ' +
        'log them with log_event, never create them with upsert_record. builtIns lists facts, ' +
        'written with remember. Call it first, ' +
        'and again after a schema change. If initialized is false, ' +
        'the schema has not been set up yet: follow get_guide("discover_schema"), or see ' +
        'list_templates.',
      inputSchema: noInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(caller, 'read', () => describeSchema(sql, caller)),
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        'Lists the templates a workspace can apply (sales, services, clinic, real_estate, ' +
        'recruiting, blank), what objects and fields each adds, and which are applied. ' +
        'Pick the one closest to the business; if unsure, ask your user rather than guess. ' +
        'Check it before creating an object, even in an initialized workspace: a template ' +
        'may already define it.',
      inputSchema: noInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(caller, 'read', () => templatesFor(sql, caller)),
  );

  server.registerTool(
    'apply_template',
    {
      title: 'Apply a template',
      description:
        "Adds a template's objects and fields to the workspace and marks it initialized. " +
        'Templates only add, so this applies at once. Applying one twice does nothing; ' +
        '"blank" adds nothing and only marks the workspace initialized. Needs the ' +
        'schema:write scope.',
      inputSchema: applyTemplateInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ name }) => run(caller, 'schema:write', () => applyTemplateFor(sql, caller, name)),
  );

  server.registerTool(
    'get_guide',
    {
      title: 'Read a guide',
      description:
        `Returns step-by-step instructions, as markdown, for a task you do rarely. ${GUIDE_LIST} ` +
        'Read "discover_schema" when describe_schema says initialized: false, or when your ' +
        'user asks you to set up or redesign the workspace.',
      inputSchema: getGuideInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) => run(caller, 'read', async () => GUIDES[name].text),
  );

  for (const name of GUIDE_NAMES) {
    const guide = GUIDES[name];
    const args = 'promptArgs' in guide ? { argsSchema: guide.promptArgs } : {};
    server.registerPrompt(
      name,
      { title: guide.title, description: guide.description, ...args },
      ({ sources }: { sources?: string }) => ({
        description: guide.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `${guide.promptIntro} Follow this guide.\n\n${guide.text}` +
                (sources ? `\n\nStart with these sources: ${sources}` : ''),
            },
          },
        ],
      }),
    );
  }

  server.registerTool(
    'query_records',
    {
      title: 'Query records',
      description:
        'Lists records of one object, filtered and sorted by its fields, 50 per page by ' +
        'default (at most 200). Use it to find the record to update when you know a name, ' +
        'phone or company rather than a unique email. Text filters match exactly; pass ' +
        'nextCursor back as cursor for the next page.\n\n' +
        'For an event type, linked: { record } lists the events attached to that record: ' +
        "as a participant, about it, or through one of the event's own relation fields " +
        '(narrow with link). Sort by occurredAt, e.g. the last calls with a company.',
      inputSchema: queryRecordsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ object, ...input }) => run(caller, 'read', () => findRecords(sql, caller, object, input)),
  );

  server.registerTool(
    'get_record',
    {
      title: 'Get a record',
      description:
        'Returns one record: its object, label, field values, relations (as record IDs) and ' +
        'who created and last updated it.',
      inputSchema: getRecordInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => run(caller, 'read', () => readRecord(sql, caller, id)),
  );

  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Keyword search across records, events and current facts, grouped by type and ' +
        'ranked within each. Every hit carries the record IDs it belongs to. Use it to find a ' +
        'record by name or by anything said about it. When no record matches word for word, ' +
        'records with a similar label come back with match "similar_label" (a misspelled ' +
        'name), so check them before using one. Words match as typed or as the start of a ' +
        'longer word, without stemming; email and website domains are searchable ("acme").',
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(caller, 'read', () => searchFor(sql, caller, input)),
  );

  server.registerTool(
    'get_context',
    {
      title: 'Get context for a record',
      description:
        'Returns what Retainer knows about one record, fitted to a token budget: its current ' +
        'field values (each with who wrote it and when it was observed), then open tasks ' +
        '(earliest due first), current facts and recent events (newest first), each event ' +
        'saying how it is attached (via). Field ' +
        'values are what the CRM holds; facts are plain-language claims with their sources. ' +
        'omitted counts what did not fit; read more with search or a larger tokenBudget.',
      inputSchema: getContextInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ record, ...input }) => run(caller, 'read', () => contextFor(sql, caller, record, input)),
  );

  server.registerTool(
    'upsert_record',
    {
      title: 'Create or update a record',
      description:
        'Writes field values to one record. Find it by id, or by match on one unique field ' +
        '(e.g. emails). With neither, a new record is created. If id or match finds nothing ' +
        'the call fails, unless ifMissing is "create"; so "update Dana\'s address" can never ' +
        'create a second Dana by mistake.\n\n' +
        'Values learned from a conversation should cite it: log it with log_event first ' +
        'and pass its id as source. Events are created only with log_event; an existing ' +
        "event's fields can be corrected here.\n\n" +
        'The response reports each field: "applied" (it is now the value), "pending_review" ' +
        '(a person set a different value; yours waits for their approval, so say so) or ' +
        '"superseded" (kept in history; a newer or higher-precedence value stands). ' +
        'Validation errors name the field and the allowed values.',
      inputSchema: upsertRecordInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ object, idempotencyKey, ...input }) =>
      run(caller, 'write', () => {
        if (!input.id && !input.match) {
          return createRecord(sql, caller, object, input.values, {
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            ...(input.source !== undefined ? { source: input.source } : {}),
          });
        }
        if (idempotencyKey !== undefined) {
          throw new AppError(
            400,
            'invalid_request',
            'idempotencyKey applies only to creates without id or match; ' +
              'a write by id or match is already safe to retry',
          );
        }
        return upsertRecord(sql, caller, object, input);
      }),
  );

  server.registerTool(
    'log_event',
    {
      title: 'Log an event',
      description:
        'Logs something that happened, as a record of an event type (meeting, call, email, ' +
        'message, note, or one the workspace added): when it happened, a title, your own ' +
        'short summary, its other fields, who took part (participants) and the records it ' +
        'concerns (about: e.g. the company and project of a meeting with Dana about the Acme ' +
        'pilot). Do this first after a conversation, then pass the returned id as source to ' +
        'upsert_record and remember.\n\n' +
        'Participants are matched by email to existing records. The response lists matched ' +
        'participants with their recordId, and unmatched ones with a reason: "no_match" (no ' +
        'record has this email; create the person with upsert_record if worth keeping), ' +
        '"phone_only" (phones never match on their own; pass recordId if you know it), ' +
        '"deleted_record" (the email belongs to a deleted record; a person will review it), ' +
        '"ambiguous" (several records claim it; candidates lists them) or "suppressed" (the ' +
        'person asked to be forgotten; the handle is not stored, and do not create a record ' +
        'for it). Retainer never creates records for you.\n\n' +
        'Logging the same channel and externalId again returns the same event with ' +
        'created: false, after adding the participants and about records it did not have ' +
        '(listed in added); nothing is removed. A different type, occurredAt, title, summary ' +
        'or field value is a conflict (event_conflict): an edited source needs a new ' +
        'externalId. event_retracted means that source was deleted or erased: do not log it ' +
        'again.',
      inputSchema: logEventInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => run(caller, 'write', () => logEventFor(sql, caller, input)),
  );

  server.registerTool(
    'remember',
    {
      title: 'Remember a fact',
      description:
        'Stores one plain-language fact about a record that does not fit a field, e.g. ' +
        '"Legal review at Acme usually takes two weeks." Cite the event it came from as ' +
        'source (from log_event), with an optional short quote; the fact is then valid from ' +
        "that event's date. Without source, Retainer keeps an internal note for it, shown " +
        'as an internal source. One fact per call; field values belong in upsert_record.',
      inputSchema: rememberInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ record, idempotencyKey, ...input }) =>
      run(caller, 'write', () => remember(sql, caller, record, input, idempotencyKey)),
  );

  server.registerTool(
    'propose_schema_change',
    {
      title: 'Change the schema',
      description:
        'Requests schema operations: create_object, create_field, add_option and label or ' +
        'description changes are applied at once. Renames, deletions, removing options and ' +
        'making a field required or unique are only proposed: a person with admin access ' +
        'approves them, and the response says "proposed". Field types cannot be changed; ' +
        'create a new field instead. Fields are not searchable unless you set isSearchable: ' +
        'set it on text fields people will look records up by (the label field is always ' +
        'searchable). Give a short reason. Needs the schema:write scope.\n\n' +
        'Make the smallest change that works: an option before a field, a field before an ' +
        'object. Meetings, calls, emails and messages are events (log_event): add a field ' +
        'to an event type, or create one with class "event", rather than an entity object ' +
        'for them. One-off knowledge is a fact (remember), never an object or field. If you have not ' +
        'yet, read get_guide("schema_design") before creating an object.',
      inputSchema: schemaChangeRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (body) =>
      run(
        caller,
        'schema:write',
        () => requestSchemaChange(sql, caller, body),
        (result) => (result as { status: string }).status === 'failed',
      ),
  );

  return server;
}
