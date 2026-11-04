/**
 * Guides: step-by-step instructions for a task an agent does rarely and
 * should do well. Served as the get_guide tool, so any agent can read one on
 * its own, and as an MCP prompt of the same name, so a person can start one.
 * Retainer only serves the text; the agent does the work with its own model
 * and tools (4.3).
 */

import { z } from 'zod';

/**
 * How to shape a schema. Shared by discover_schema, which designs one, and
 * schema_design, which an agent reads before growing or reviewing one.
 */
const DESIGN_RULES = `### Use what Retainer already has

- Meetings, calls, emails, messages and notes are events: describe_schema
  lists their types as objects of class "event", and log_event logs them.
  Never create an entity object for them, nor a join object for who
  attended; participants are part of the event. The company, project, deal
  or tasks a meeting concerns go in its about list, so it shows on those
  records too; never list them as participants.
- Something else that happens at a point in time and that you would log
  from a source (a payment, a shipment, a site visit) can be a new event
  type: create_object with class "event". It gets a title and summary of
  its own; add only the fields that type needs, such as an amount. A
  relation field on an event type (a payment's invoice) also attaches the
  event to that record's history; prefer about for "what this concerns".
  A scheduled piece of business with its own status and outcome, such as
  an appointment or a viewing, can still be an entity object.
- describe_schema lists facts under builtIns. They are part of every
  workspace; don't add fields or objects to copy them.
- To find events by type, channel, date or linked record, use
  query_records on the event type with linked; there is no need for a field
  like "meeting count".
- One-off knowledge ("prefers WhatsApp after 6pm") is a fact: store it with
  remember. A field is for something you would filter, sort or fill in for
  every record.
- Commitments are task records. Recency comes from events, so do not
  add a field like "last contacted" that someone has to keep up by hand.

### Start lean

- Adding is applied at once; renaming and removing wait for a person to
  approve. So a field left out costs little, and a field added by mistake
  costs a review. When in doubt, leave it out.
- Leave out what the data showed once or twice. A small schema that gets
  filled in beats a large one that stays empty.
- Prefer the smallest change that works: an option on an existing select
  before a new field, a field on an existing object before a new object.
- Prefer one multi_select of tags ("customer", "partner", "investor") over
  a separate type field per kind of record, and over separate objects for
  kinds of company or person that share the same fields.
- Add an object only for something with its own lifecycle (a status,
  dates, often an amount) that exists several times per person or company.

### Grow it from use

- A kind of fact you keep remembering on many records, or want to filter
  by, can become a field.
- A field whose value needs its own status, dates and history, several
  times per record, can become an object.
- A field still empty on almost every record after a few weeks is a
  candidate for removal; say so to your user with the count.

### Shape and names

- Types: select for a small closed set, with the options you saw;
  multi_select for tags; money for amounts (with currency); date or
  date_time; emails, phones and links for contact details; relation to
  link to another object, with an inverseField name for the other side.
  A relation is many_to_one (one record: a deal's company) unless a record
  can link to several at once (a deal's contacts, a person's
  organizations): then set relationCardinality "many_to_many" rather than
  creating a join object. A relation that can point at more than one
  object (a deal's customer, a company or a person) takes targetObjects
  instead of targetObject, and has no inverseField. Write a relation on its
  owning side; the inverse (isInverse) is read-only. Avoid json.
- Names are camelCase API names (nameSingular "deal", namePlural "deals";
  field "closeDate"); labels are what people read. Prefer a template's
  names to your own when they mean the same thing.
- Set isSearchable on text fields people will look records up by.
- Do not make fields required or unique at first: each waits for a
  person's approval, and existing data may not satisfy it. Add them once
  the data does.`;

const DISCOVER_SCHEMA = `# Discover the schema from the user's data

Goal: look at how your user actually works, propose a Retainer schema that
fits it, and apply it once they agree. You only change the schema here; do
not write records, events or facts.

Retainer cannot read the user's email, calendar or files. You explore them
with your own tools; Retainer stores the schema you settle on.

## 1. Read what exists

Call describe_schema and list_templates.
- Every workspace already has person, company and task objects. Read their
  fields in describe_schema before you add your own.
- Read the templates even when the workspace is already initialized: a
  template may already define the object you are about to invent, and a
  workspace can apply a template later. Read them as reference here; choose
  one in step 4, after you have seen the data, so the data shapes the
  choice and not the other way round.
- initialized: false means no template has been chosen. If it is true, you
  are extending a schema someone already uses: propose additions only, and
  never rename or delete what is there unless the user asks. When they ask
  for a redesign, say which changes will wait for approval.

## 2. Find out for yourself

Do not start by asking your user. You probably know the business already,
and your own tools probably reach its data. Work it out first:
- What you already know: your instructions, your memory and earlier
  conversations. What does the business do, who are its customers, what
  does it sell, and how does a customer move from first contact to done?
- What you can reach: go through your own tools and connections. Look for
  a CRM or pipeline tool (HubSpot, Salesforce, Pipedrive, Airtable, Notion
  databases), email, calendar, file storage, spreadsheets, messaging, and
  booking, invoicing or e-commerce systems.
- Where the business already keeps its records: search file storage for
  sheets named like "clients", "leads", "pipeline", "orders" or
  "customers"; look for email sent by a CRM or booking tool; look for
  calendar events whose titles repeat.

A CRM, database or spreadsheet the business already keeps is the best
evidence: its objects, columns, pipelines and stage names are the user's own
schema. Read it first, and read its schema or settings rather than its
records when the tool lets you.

Records already in this Retainer workspace are not that evidence: they show
how someone modelled the business, not how the business works. Read them
too, then look at the sources anyway.

Ask your user only for what you could not find, in one short question, then
carry on: what the business does if nothing says, or where its data lives
if none of your tools reach it.

## 3. Sample the sources

You are reading the sources to learn the shape of the business, not to
decide what to import. Look at a source even if its contents will never be
logged: calendar titles show which meetings recur and with whom, and email
shows the words people use for stages. Which sources flow into Retainer is
a separate question, for after the schema is agreed.

Read a sample of every source you found, not everything: for example the
fields and pipelines of an existing CRM, the header row plus 20 rows of each
spreadsheet, the last 50 to 100 email threads and the last four weeks of
calendar. Note what recurs:
- Things the business tracks one by one, with their own status, dates or
  amount, and several per person or company: deals, projects, orders,
  properties, appointments, applications. These may be objects.
- Details that come up again and again about a person, company or such a
  thing: a budget, a renewal date, a source, a plan. These may be fields.
- Words for stages and states ("sent the proposal", "signed", "on hold").
  These become select options; use the values you actually saw.
- Which thing belongs to which: a deal to a company, a viewing to a
  property. These become relations.
- Spreadsheet columns and CRM export fields already in use: they are the
  user's own schema and the strongest evidence.
Count how often each one appears, so you can say what the evidence is.

Keep personal details out of your notes and your proposal; you need the
shape of the data, not its contents.

## 4. Design

Start from the template closest to the business, or "blank" if none fits.
A template object that is close but not exact is still better than your
own: add the fields it lacks rather than creating a twin.

${DESIGN_RULES}

## 5. Propose and wait

Show the user:
- What you understood the business to be, and the sources you looked at.
- The template you chose and why.
- Each new object and field: name, type, options, what it links to, and the
  evidence ("a stage is mentioned in 31 of 80 threads").
- What you left out and why.
- Anything that will need a person's approval in Retainer.
Then stop and wait for their answer. Revise until they agree. Do not apply
anything they have not approved.

## 6. Apply

1. apply_template with the chosen template, before anything else (template
   names would otherwise collide with your own objects). Skip it if the
   workspace already has that template.
2. propose_schema_change once, with every approved operation and a short
   reason that says the user approved it. Create objects before
   the fields and relations that point to them.
3. Read the response: "applied" is done, "proposed" waits for a person with
   admin access, "failed" carries a message saying what to fix. Fix and
   retry only what failed.
4. Call describe_schema to confirm, then tell the user what was applied and
   what is waiting for approval.

apply_template and propose_schema_change need the schema:write scope. If
the key lacks it, give the user the approved proposal and tell them a key
with schema:write is needed to apply it.

When the schema is in place, you can offer to import the records and
conversations you sampled, as a separate step.`;

const SCHEMA_DESIGN = `# Design and grow the schema

Read this before you add an object, when a field you need is missing, or
when your user asks you to review or clean up the schema. To set up a
workspace from scratch, follow the discover_schema guide instead; it uses
the same rules.

## Before you change anything

1. Call describe_schema, and list_templates: a template may already define
   what you need, and applying it beats building a twin.
2. Check that the change is needed: could an option, an existing field, a
   fact or an event hold it?
3. Make the smallest change that works, with a reason that names the
   evidence ("budget came up in 9 of the 12 deals logged this month").

## Rules

${DESIGN_RULES}

## Reviewing a schema in use

When your user asks whether the schema still fits:
- Count how often each custom field is filled in (query_records), and
  name the ones that are almost always empty.
- Look for custom objects that rebuild what Retainer has: an object for
  meetings, calls or emails; a join object for who attended; a field that
  tracks the last contact by hand. Moving them means logging the records
  as events first, so propose it as a plan, not a single change.
- Look for twins of template objects and for type fields that tags could
  replace.
Propose additions as usual. Renames and removals wait for a person with
admin access, so list them separately and say why each is worth it.`;

export const GUIDES = {
  discover_schema: {
    title: 'Discover the schema',
    description:
      "Explore the user's own data (email, calendar, spreadsheets, an old CRM export), " +
      'propose a Retainer schema that fits it, and apply it once the user agrees.',
    text: DISCOVER_SCHEMA,
    /** What the person says when they start the guide as a prompt. */
    promptIntro: "Set up this Retainer workspace's schema from my data.",
    /** Arguments the person can pass when starting the prompt. */
    promptArgs: z.object({
      sources: z
        .string()
        .optional()
        .describe(
          'Where to start, e.g. "my Gmail and the leads spreadsheet". Without it, the agent ' +
            'looks at everything its tools can reach.',
        ),
    }),
  },
  schema_design: {
    title: 'Design and grow the schema',
    description:
      'Rules for changing a schema in use: start lean, use events, facts and tasks ' +
      'instead of new objects, and grow fields from evidence. Also how to review one.',
    text: SCHEMA_DESIGN,
    promptIntro: "Review this Retainer workspace's schema with me.",
  },
} as const;

type GuideName = keyof typeof GUIDES;

export const GUIDE_NAMES = Object.keys(GUIDES) as [GuideName, ...GuideName[]];
