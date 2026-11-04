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
later. Retainer currently has fixed interaction kinds and free-form metadata,
not schema-defined fields per kind. No implementation approach was selected.

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
