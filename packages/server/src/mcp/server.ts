import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { errorBody, toAppError } from '../api/http.js';
import { missingScope } from '../auth/middleware.js';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope } from '../db/schema.js';
import { AppError } from '../errors.js';
import { rememberInputSchema } from '../memory/facts.js';
import {
  logInteractionInputSchema,
  MAX_PARTICIPANTS,
  participantInputSchema,
} from '../memory/interactions.js';
import { logInteractionFor, remember } from '../memory/service.js';
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
import {
  describeSchema,
  requestSchemaChange,
  schemaChangeRequestSchema,
} from '../schema-engine/service.js';
import { applyTemplateFor, templatesFor } from '../templates/service.js';
import { VERSION } from '../version.js';

/**
 * The MCP tools (6.2). They are generic, not one per object, and each calls
 * the same service as its REST route, so both interfaces share validation,
 * write rules and error messages. The workspace and actor come from the API
 * key, so no tool takes either.
 */

const INSTRUCTIONS = `Retainer is the memory of a CRM workspace: people, companies, tasks and
any objects the workspace adds. You are connected to one workspace through one
API key; every call acts on it, and every write is recorded as yours.

Start with describe_schema. If the workspace is not initialized, pick a
template with list_templates and apply_template, or ask your user.

Find records with query_records, read them with get_record, and write them
with upsert_record. Write the values you learned; Retainer keeps every claim's
history and decides which value wins. A value a person set outranks yours, so
your write may come back as pending_review: tell your user it is waiting for
approval rather than saying it is done.

After a meeting, call, email thread or chat, write what you learned in order:
1. log_interaction: kind, channel, when it happened, a title, your own short
   summary, the source's external ID, and the participants' emails or phones
   (or record IDs). Keep the id it returns. Unmatched participants come back
   with a reason; create the people worth keeping with upsert_record, or leave
   them. Retainer never creates records on its own.
2. upsert_record with source set to that interaction id, so the values carry
   its date and an older email cannot overwrite a newer claim.
3. remember, citing the same source (with a short quote if useful), for
   plain-language facts that do not fit a field.
4. upsert_record for tasks someone committed to, as task records.
Each call is its own write, so you can stop and resume; logging the same
externalId again returns the same interaction.

When a field you need does not exist, use propose_schema_change. Adding is
applied at once; removing or renaming waits for a person to approve.

Errors are JSON { error: { code, message, details } }. Messages say what was
wrong and what is allowed, so read them and retry.`;

/** A successful result: the JSON as text, and as structured content. */
function ok(result: object): CallToolResult {
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
  fn: () => Promise<object>,
  isFailure: (result: object) => boolean = () => false,
): Promise<CallToolResult> {
  const missing = missingScope(caller.scopes, scope);
  if (missing) return failure(missing);
  try {
    const result = await fn();
    return isFailure(result) ? { ...ok(result), isError: true } : ok(result);
  } catch (error) {
    const known = toAppError(error);
    if (known) return failure(known);
    console.error(error);
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
      'e.g. { "status": "todo", "dueDate": { "lte": "2026-11-30" } }. Only filterable fields.',
  ),
  cursor: queryInputSchema.shape.cursor.describe('nextCursor from the previous page.'),
});

const upsertRecordInput = z.strictObject({
  object: objectName,
  ...upsertInputSchema.shape,
  id: upsertInputSchema.shape.id.describe('Update this record.'),
  match: upsertInputSchema.shape.match.describe(
    'Find the record by one unique field and its value, e.g. { "emails": "dana@acme.com" }. ' +
      'Names and phones are not unique: find those records with query_records first.',
  ),
  values: valuesSchema
    .default({})
    .describe(
      'Field name to value. Composite fields (emails, phones, links, money, full_name, ' +
        'address) are replaced whole, so include the values to keep. null clears a field.',
    ),
  ifMissing: upsertInputSchema.shape.ifMissing.describe(
    'When id or match finds nothing: "fail" (default) or "create". Use "create" only ' +
      'when you mean to add a new record.',
  ),
  expectedUpdatedAt: upsertInputSchema.shape.expectedUpdatedAt.describe(
    'Reject the write if the record changed since this updatedAt.',
  ),
  source: upsertInputSchema.shape.source.describe(
    'The interaction id (from log_interaction) these values come from. Values then carry ' +
      "the interaction's date, so an older email cannot overwrite a newer claim. Omit only " +
      'for values that come from no conversation.',
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

const logInteractionInput = z.strictObject({
  ...logInteractionInputSchema.shape,
  kind: logInteractionInputSchema.shape.kind.describe('meeting, call, email, message or note.'),
  channel: logInteractionInputSchema.shape.channel.describe(
    'Where it happened, e.g. "gmail", "zoom", "whatsapp". Use a distinct channel per source ' +
      'account when their external IDs could overlap.',
  ),
  externalId: logInteractionInputSchema.shape.externalId.describe(
    "The source's own ID (message, thread, meeting or call ID). Logging it again with the " +
      'same input returns the same interaction; without it, retries log duplicates.',
  ),
  occurredAt: logInteractionInputSchema.shape.occurredAt.describe(
    'When it happened, ISO 8601 with a UTC offset, e.g. "2026-10-29T14:00:00+02:00".',
  ),
  title: logInteractionInputSchema.shape.title.describe('A short title.'),
  summary: logInteractionInputSchema.shape.summary.describe(
    'Your own short summary. Not a transcript or message body: store only what the ' +
      'workspace should keep.',
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
    .describe('Who took part; each needs a handle, a recordId, or both.'),
});

const rememberInput = z.strictObject({
  record: z.uuid().describe('The record the fact is about.'),
  ...rememberInputSchema.shape,
  text: rememberInputSchema.shape.text.describe(
    'One plain-language fact, e.g. "Legal review at Acme usually takes two weeks."',
  ),
  source: rememberInputSchema.shape.source.describe(
    'The interaction id (from log_interaction) the fact comes from; the fact is valid from ' +
      "that interaction's date. Without it, a note interaction is created for the fact.",
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

const applyTemplateInput = z.strictObject({
  name: z.string().min(1).describe('Template name from list_templates, e.g. "sales" or "blank".'),
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
        'required. Call it first, and again after a schema change. If initialized is false, ' +
        'no template has been chosen yet: see list_templates.',
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
        'Pick the one closest to the business; if unsure, ask your user rather than guess.',
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
    'query_records',
    {
      title: 'Query records',
      description:
        'Lists records of one object, filtered and sorted by its fields, 50 per page by ' +
        'default (at most 200). Use it to find the record to update when you know a name, ' +
        'phone or company rather than a unique email. Text filters match exactly; pass ' +
        'nextCursor back as cursor for the next page.',
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
    'upsert_record',
    {
      title: 'Create or update a record',
      description:
        'Writes field values to one record. Find it by id, or by match on one unique field ' +
        '(e.g. emails). With neither, a new record is created. If id or match finds nothing ' +
        'the call fails, unless ifMissing is "create"; so "update Dana\'s address" can never ' +
        'create a second Dana by mistake.\n\n' +
        'Values learned from a conversation should cite it: log it with log_interaction ' +
        'first and pass its id as source.\n\n' +
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
    'log_interaction',
    {
      title: 'Log an interaction',
      description:
        'Logs a meeting, call, email, message or note: when it happened, a title, your own ' +
        'short summary and who took part. Do this first after a conversation, then pass the ' +
        'returned id as source to upsert_record and remember.\n\n' +
        'Participants are matched by email to existing records. The response lists matched ' +
        'participants with their recordId, and unmatched ones with a reason: "no_match" (no ' +
        'record has this email; create the person with upsert_record if worth keeping), ' +
        '"phone_only" (phones never match on their own; pass recordId if you know it), ' +
        '"deleted_record" (the email belongs to a deleted record; a person will review it) or ' +
        '"ambiguous" (several records claim it; candidates lists them). Retainer never ' +
        'creates records for you.\n\n' +
        'Logging the same channel and externalId again with the same input returns the same ' +
        'interaction with created: false; different input is a conflict.',
      inputSchema: logInteractionInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => run(caller, 'write', () => logInteractionFor(sql, caller, input)),
  );

  server.registerTool(
    'remember',
    {
      title: 'Remember a fact',
      description:
        'Stores one plain-language fact about a record that does not fit a field, e.g. ' +
        '"Legal review at Acme usually takes two weeks." Cite the interaction it came from ' +
        'as source (from log_interaction), with an optional short quote; the fact is then ' +
        "valid from that interaction's date. Without source, a note interaction is created " +
        'for it and returned as noteInteraction. One fact per call; field values belong in ' +
        'upsert_record.',
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
        'create a new field instead. Give a short reason. Needs the schema:write scope.',
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
