# Schema and memory: design discussion

Discussion date: November 4, 2026.

This note captures the design takeaways and open questions from the discussion
following [the Twenty comparison](twenty-comparison.md). It is not an
implementation specification. Current behavior is documented in
[ARCHITECTURE.md](../ARCHITECTURE.md); proposals below remain exploratory.

## Product goals

- Agents are first-class writers: they discover the user's data, choose a
  suitable schema, and maintain it as the business evolves.
- People consume the resulting CRM through records, views, and potentially
  dashboards. Agent flexibility should produce information people can understand
  and use, without unnecessary schema complexity.
- A workspace should not have to anticipate every future source or workflow at
  setup. The schema should be able to evolve after months of use.

## Current model clarified

- Person, Company, and Task are ordinary configurable object types with
  protected, predefined definitions. They are created in every workspace and
  cannot be deleted; their records use the same machinery as custom objects.
- Retainer has no object inheritance or subtype mechanism today.
- Facts and interactions are separate built-in entities, outside the configurable
  object system. Facts express claims about one record; interactions describe
  events and can link to multiple records across object types.
- Interaction links distinguish participants from records the event was about.
  A meeting can involve a person and concern a company, project, and invoice.
- Open tasks are Task records filtered by status, not a separate memory primitive.
- Field assertions preserve value history and provenance. An interaction is not
  automatically created for every field update. Source interactions are the
  current evidence path for sourced field assertions and facts; arbitrary CRM
  records cannot directly replace those sources today.

## Modeling guidance

These are rules of thumb for agents, not universal server constraints.

- **Use a field for a changing stage of the same entity.** Lead becoming client
  normally changes a stage field, rather than moving a person between object
  types. If the stage varies by engagement, put it on the engagement or deal.
- **Use an object when something needs its own identity, structured information,
  and ongoing lifecycle.** An Invoice record can progress from sent to overdue to
  paid while retaining its relationships and history.
- **Use an interaction to remember an event.** If the only need is remembering
  that an invoice arrived, an interaction may be sufficient. A payment email can
  later be linked to an Invoice record and cited when changing its status.
- **Distinguish state from events and change history.** The invoice holds current
  state, interactions capture relevant events, and assertions record field claims
  and their sources. Separate interactions are not needed merely to duplicate
  every status change.
- **Do not require prominent memory sections everywhere.** Any record can be
  linked to interactions, but an invoice need not present memory in the same way
  as a person or project. Supporting memory links and emphasizing them in the UI
  are separate choices.
- **A new source is not necessarily a new interaction type.** Another email
  account or a recording device may supply existing Email or Meeting kinds.
- **Inheritance should earn its complexity.** Different labels or views alone do
  not justify subtypes. Distinct schemas and rules may; overlapping roles such as
  doctor and patient may instead fit roles or linked profiles.

## Constraints versus agent judgment

The central design direction is to enforce structural guarantees while leaving
business-dependent modeling decisions to the agent exploring the user's data.

Retainer should validate the chosen representation, preserve attribution and
history, and protect existing data during schema changes. It should not encode
an absolute rule that an invoice or form submission must always be an object or
always be an interaction. The right representation depends on how it is used.

## Interaction types: direction explored, not decided

We explored defining interaction types as part of the workspace schema, alongside
CRM object types. Meeting, Email, and Call could each have typed business fields
while sharing a protected interaction core and evidence rules.

This would be a dedicated definition mechanism, not necessarily object
inheritance. Templates could supply initial types, and agents could extend them
later. Retainer currently has five fixed interaction kinds shared by every
workspace, with the same fields for every kind. Workspaces cannot add kinds or
custom interaction fields. No implementation approach was selected.

### Metadata follow-up

Code inspection during the discussion confirmed that `interactions.metadata`
exists as a JSONB column with an empty-object default, but the REST and MCP
interaction-creation inputs do not accept it, and the insert leaves it at that
default. It is not an available custom-fields mechanism. Its intended purpose
has not been established; investigate whether it should hold source details,
be replaced by typed interaction fields, or be removed. No choice was made.

Open questions:

- Are fixed kinds sufficient, or should workspaces define interaction types and
  their fields? Which core information must remain protected?
- Can interaction definitions reuse the existing schema engine and field
  machinery without introducing a second independent schema system?
- Should evidence remain interaction-only, or should selected CRM records also
  be usable as sources? If records can be sources, how do citations retain the
  version that supported a claim when the record later changes?
- How can the same event serve a managed business workflow and provide evidence
  without requiring duplicate entries?
- How should typed interaction information support tables, filters, and
  dashboards? Frontend implications were deliberately deferred.

## Evolution and background maintenance

An initially lightweight representation need not be permanent. If invoices were
first logged as interactions, an agent could later create an Invoice object,
build records from the historical events, cite those events, and link them to
the new records. This is enrichment of existing history, not necessarily a
destructive conversion.

The existing operations provide building blocks, but there is no automatic
interaction-to-object conversion feature. Matching old events to invoice
identities can be ambiguous and should not be guessed.

Broader background CRM maintenance was raised as a possible capability:
deduplication, link repair, schema evolution, and historical backfills. This could
reduce pressure to choose a perfect schema on day one. Safe execution would need
to preserve evidence, support retries and resumption, and expose ambiguous cases
for review. Retainer's current consolidator handles limited hygiene work;
broader interpretation would remain agent-driven under the current rule that
Retainer does not call language models.

The scope and execution model of that maintenance remain open. The discussion
ended without authorizing implementation or changing the architecture.

## Second session: interactions and record history

November 4, 2026. The discussion was parked without settling the history model.

### Confirmed behavior

- Every workspace has the same interaction fields and five fixed kinds; there
  are no custom kinds or fields per kind. The metadata follow-up above remains
  open.
- One interaction can link to multiple records across object types, without
  duplicating it. A postponement email can name the patient as a participant and
  the appointment as an `about` record, appearing in both interaction lists.
- An agent can then update the appointment date citing that email. Assertions
  retain field-value history and provenance; a field update does not itself
  create an interaction. Interactions describe events; assertion history records
  field claims and their outcomes, not a complete audit of every operation.
- Linking an appointment record to a patient does not automatically show the
  appointment, or its interactions, in the patient's interaction list.

### Principles carried forward

- Avoid duplicate storage and competing sources of truth. Showing the same item
  in multiple places is not duplication.
- An entity's identity and changing state can justify a record of its own;
  lifecycle is modeling guidance, not an absolute server rule.

### Issues and decisions still open

- **Interaction flexibility:** whether to add workspace-defined kinds and typed
  fields, and how these relate to ordinary objects and the unused metadata column.
- **Complete history:** whether a patient's interaction list should represent
  their event history, or a broader history view should combine interactions,
  related records and selected field changes. A current record value alone does
  not describe the sequence of events.
- **Reliable inclusion:** explicit agent-written links already work, but depend
  on the agent remembering every relevant record. Consider deterministic linking
  or history traversal configured per relationship; inheriting through every
  relation could include unrelated information. No mechanism was selected.
- **Historical links:** if relationships later change, should old events follow
  the new relationship or retain their original associations? Keeping links fixed
  at logging time was suggested, not agreed.
- **Evidence:** whether records themselves should be citable sources remains
  open; combining items in a history view does not resolve this.

No new architecture or implementation was approved. Resume with the distinction
between event history and field-change history before choosing a linking rule.

## Third session: verification and spec

November 4, 2026. Revisited with one premise made explicit: Retainer is in early
exploration, with no users and no data to preserve, so migration cost no longer
constrains the design. Protecting a workspace's data through its own schema
changes remains a product guarantee.

The claims above were checked against the code. Corrections:

- Base objects cannot be deleted, but their fields can, including `task.status`
  and `task.dueDate`, which context packs depend on.
- Facts always cite an interaction: `remember` without a source creates a
  hidden note interaction to cite.
- Keeping explicit links fixed at logging time is already current behavior
  (ARCHITECTURE.md 1.3), not just a suggestion.
- Relations are many-to-one only; interaction links are the only many-to-many
  links.
- Field history is readable over REST but not over MCP.

The open questions were answered in a proposed spec:
[Event types and record history](event-types-and-history-spec.md). In short,
interactions become records of event-class object types in the schema engine;
evidence stays with events, and derived claims cite assertions; related events
roll up through opted-in stable relations; and a record timeline merges events,
field changes and facts at read time. The spec includes an implementation order.
