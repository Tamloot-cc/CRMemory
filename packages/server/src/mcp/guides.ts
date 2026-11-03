/**
 * Guides: step-by-step instructions for a task an agent does rarely and
 * should do well. Served as the get_guide tool, so any agent can read one on
 * its own, and as an MCP prompt of the same name, so a person can start one.
 * Retainer only serves the text; the agent does the work with its own model
 * and tools (4.3).
 */

const DISCOVER_SCHEMA = `# Discover the schema from the user's data

Goal: look at how your user actually works, propose a Retainer schema that
fits it, and apply it once they agree. You only change the schema here; do
not write records, interactions or facts.

Retainer cannot read the user's email, calendar or files. You explore them
with your own tools; Retainer stores the schema you settle on.

## 1. Read what exists

Call describe_schema and list_templates.
- Every workspace already has person, company and task objects. Read their
  fields in describe_schema before you add your own.
- initialized: false means no template has been chosen. If it is true, you
  are extending a schema someone already uses: propose additions only, and
  never rename or delete what is there unless the user asks.

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

Ask your user only for what you could not find, in one short question, then
carry on: what the business does if nothing says, or where its data lives
if none of your tools reach it.

## 3. Sample the sources

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

- Start from the template closest to the business, or "blank" if none fits.
  Prefer a template's names to your own when they mean the same thing.
- Add a field to an existing object before you add an object. Add an object
  only for something with its own lifecycle that exists several times per
  person or company.
- Meetings, calls, emails and messages are interactions (log_interaction),
  not objects. A scheduled piece of business with its own status and outcome,
  such as an appointment or a viewing, can be an object.
- One-off knowledge ("prefers WhatsApp after 6pm") is a fact (remember), not
  a field. A field is for something you would filter, sort or fill in for
  every record.
- Leave out what the data showed once or twice. A small schema that gets
  filled in beats a large one that stays empty; fields can be added later.
- Types: select for a small closed set, with the options you saw;
  multi_select for tags; money for amounts (with currency); date or
  date_time; emails, phones and links for contact details; relation (many
  to one) to link to another object, with an inverseField name for the other
  side. Avoid json.
- Names are camelCase API names (nameSingular "deal", namePlural "deals";
  field "closeDate"); labels are what people read.
- Set isSearchable on text fields people will look records up by.
- Do not make fields required or unique now: each of those waits for a
  person's approval, and existing data may not satisfy it.

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

export const GUIDES = {
  discover_schema: {
    title: 'Discover the schema',
    description:
      "Explore the user's own data (email, calendar, spreadsheets, an old CRM export), " +
      'propose a Retainer schema that fits it, and apply it once the user agrees.',
    text: DISCOVER_SCHEMA,
  },
} as const;

type GuideName = keyof typeof GUIDES;

export const GUIDE_NAMES = Object.keys(GUIDES) as [GuideName, ...GuideName[]];
