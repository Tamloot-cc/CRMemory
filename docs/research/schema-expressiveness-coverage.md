# CRM schema expressiveness: coverage and limitations

Assessment date: **2026-11-04**. Implementation baseline:
`a25f3e0c56e62276ba8426a218cc6463e60806f2`.

**Out of date in places.** This assessment predates PR #26 (November 5, 2026),
which added event records, multi-record relations and polymorphic relations.
Where it says those are missing, or describes fixed interactions, it describes
the baseline above. Section 10 of the
[merged spec](../specs/schema-events-and-history.md) records the decision on
each gap. The CRM research itself still stands as of the assessment date.

## Question and conclusion

**Can an agent define another CRM's objects, fields and relationships in
Retainer while preserving that CRM's logical schema structure?**

An agent can define arbitrary business object types such as company, person,
deal, opportunity, product, quote and revenue line item. Retainer does not limit
the business model to its shipped templates. The main coverage limits concern
the shapes of fields and relationships and where field definitions can live.

The researched examples establish these structural gaps:

- A writable relation field can reference one record of one object type.
  Native multi-record relations and polymorphic references are missing.
- Fields belong to object types. There is no separate scope for a particular
  list's entry fields.
- Structured field shapes are fixed. Agents cannot declare a new typed
  composite or nested collection field.
- The model always retains three base object identities, initially person,
  company and task. They can be renamed and reused, but cannot be removed to
  obtain an arbitrary smaller inventory.

**No complete CRM schema has been shown to match exactly.** This research
identifies direct matches and concrete blockers in selected public schema
fragments. It does not support a percentage of total coverage or a claim that
all fields in any product have been examined.

## Limitations and mitigations at a glance

Retainer can define the business entities. The main limitations are relationship
shapes and where fields belong. The mitigations below generally preserve the
information, but they change the source schema's structure.

| Limitation                                                                      | Mitigation today                                                                                                  | Core addition for a direct match                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Many-to-many fields:** one person linked to several companies                 | Introduce a membership/junction object. This adds an object to the exposed schema.                                | Native multi-record relation fields.                                         |
| **Polymorphic references:** one customer field accepts a company or person      | Split it into separate relations. This changes one field into several.                                            | A relation with multiple allowed target types.                               |
| **List-specific fields:** a company has different attributes in different lists | Create a separate entry object type for each list.                                                                | List-scoped entry schemas, as illustrated by Attio and Affinity.             |
| **Custom structured fields:** typed nested values or collections                | Split into ordinary fields or child objects. JSON preserves the payload but does not declare its typed structure. | Configurable composite and collection field definitions.                     |
| **Labeled associations:** labels belong to a relationship                       | Store labels on a junction object.                                                                                | Relation metadata that supports association labels.                          |
| **One-to-one relationships**                                                    | Use many-to-one and have writers check uniqueness; concurrent writes remain a risk.                               | Native one-to-one cardinality enforcement.                                   |
| **Mandatory base object identities**                                            | Rename and reuse the three base types where they fit. They are not automatically extra logical entities.          | An optional empty starting schema for cases where the base types cannot fit. |

The suggested priority is **native multi-record relations, then polymorphic
references**, because both address recurring structural mismatches in the
research. List-scoped fields become a priority if matching Affinity and Attio
is central. This is a prioritization judgment based on the examples, not a
measured coverage ranking or an approved implementation plan.

## Scope and meaning of coverage

This document assesses ten CRMs plus Affinity, the concrete follow-up example.
Public-source evidence comes from the primary sources linked below. Equivalent
information retained through remodeling does not count as direct structural
coverage.

The comparison is of **logical schemas**, not physical SQL tables, vendor API
routes or JSON response envelopes. A many-to-many field may use a SQL join
table internally; that does not make the join table a business object in its
exposed logical schema.

| Result              | Meaning                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Direct**          | Retainer can declare the selected source objects, fields, target types and multiplicities without introducing substitute business objects or moving fields to a different owner.     |
| **Remodeled**       | Equivalent information can be retained, but a field becomes a new object, one field becomes several, or fields move to another schema scope. This does not count as direct coverage. |
| **Not established** | Public evidence or the inspection is insufficient to claim a match.                                                                                                                  |

Names and primitive encodings are reported separately. Adapting `Account` to
`account` or a vendor date representation to `date` is different from replacing
one multi-record relationship with several business objects. Literal name and
payload identity is not generally possible either: Retainer requires camelCase
API names, reserves resource names, assigns its own record IDs and has fixed
composite value shapes.

The focus is object inventory, field types and ownership, reference targets,
relationship multiplicity, and explicit relationship objects. Workflow,
permissions, scoring, formulas, default evaluation, synchronization, deletion
behavior and data validation rules are outside this assessment. A declared
one-to-one relation is included because its multiplicity is part of the graph.
Calculated-field _definitions_ are not assessed; storing their output is not
evidence that those definitions are supported.

## What an agent can express today

| Construct                              | Coverage                                    | Implementation boundary                                                                                                                                           |
| -------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New business object types              | Direct                                      | Objects need distinct singular/plural API names and an eligible label field. Deal and opportunity can be separate objects if the source has both.                 |
| Ordinary scalar fields                 | Direct for matching logical types           | Text, number, boolean, date, date-time and select fields are available. No claim of exact vendor precision, length or validation semantics.                       |
| Multi-select choices                   | Direct                                      | A list of configured option values is supported; this is not a list of record references.                                                                         |
| Standard composite values              | Direct when their shape matches             | Money, email/phone/link collections, full name and address have fixed built-in shapes.                                                                            |
| Custom composite or typed array        | Remodeled                                   | Split into scalar fields or child records. JSON retains payloads but cannot declare their nested field schema.                                                    |
| Many-to-one relationship               | Direct                                      | One writable UUID reference to one target object.                                                                                                                 |
| One-to-many relationship               | Direct as a graph                           | An inverse field exposes children; writers change the child's many-to-one reference. Direct collection mutation is not supported.                                 |
| Self-reference or hierarchy            | Direct                                      | A relation may target its own object type.                                                                                                                        |
| Explicit relationship object           | Direct                                      | A source object with two typed endpoint references and its own fields can remain an object.                                                                       |
| Many-to-many relation field            | Remodeled                                   | Requires a new junction object when the source exposes only a relationship field.                                                                                 |
| One-to-one relation                    | Remodeled/partial                           | A many-to-one field does not declare a unique target. `isUnique` is not supported on relations.                                                                   |
| Polymorphic reference                  | Remodeled                                   | One field cannot target a set of object types. Separate target fields or a unified replacement object change the source structure.                                |
| List-specific entry fields             | Remodeled                                   | Dedicated entry object types can hold values, but there is no list-scoped field-definition namespace.                                                             |
| Custom objects representing activities | Direct for otherwise supported fields       | An agent can create `salesActivity`, for example. That object does not become the built-in interaction resource.                                                  |
| Extending built-in interactions/facts  | Unsupported through custom field operations | They have fixed fields and separate APIs, and are not ordinary targetable custom objects.                                                                         |
| Exact workspace object inventory       | Partial                                     | Base object identities cannot be deleted, even with the blank template. Renaming/reusing them is possible, so they do not necessarily add extra logical entities. |

An email collection with per-address labels, for example, is not automatically
covered by the `emails` type: it stores `primary` and `additional` email values,
not arbitrary attributes per address. Separate text fields can preserve a
source's first/last name columns without forcing them into `full_name`.

Implementation evidence:
[field types and shapes](../../packages/shared/src/field-types.ts),
[field/object metadata](../../packages/shared/src/schema.ts),
[accepted schema operations](../../packages/server/src/schema-engine/operations.ts),
[schema application](../../packages/server/src/schema-engine/apply.ts),
[schema validation](../../packages/server/src/schema-engine/validate.ts),
[value normalization](../../packages/shared/src/values.ts),
[base objects](../../packages/server/src/templates/base.ts),
[blank template](../../packages/server/src/templates/blank.ts), and
[fixed built-ins](../../packages/server/src/schema-engine/built-ins.ts).

## Coverage across the ten researched CRMs

Each row concerns the listed fragments. “Direct” does not certify the product's
complete schema, and the common base-inventory/name limitations still apply.

| CRM                        | Selected source structure                                                                           | Direct coverage                                                                                                             | Structural limitation / required remodeling                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Salesforce Sales Cloud** | Accounts, contacts, opportunities, products, price book entries, opportunity contact roles          | Separate entity objects and the explicit contact-role object, including its two endpoint references and role/primary fields | The explicit role object is **not evidence by itself of a missing many-to-many primitive**. Polymorphic structures elsewhere need individual inspection; complete Salesforce coverage is not established.                                              |
| **HubSpot**                | Contacts, companies, deals, tickets, products, line items; labeled associations                     | Entity objects and ordinary scalar properties                                                                               | An association can connect multiple records and carry directed labels. Turning it into a `companyMembership` object changes an association into a business object. Retainer lacks a native labeled association definition.                             |
| **Dynamics 365 Sales**     | Accounts, contacts, opportunities; customer and owner lookups                                       | Separate entity objects, money/date fields and single-target lookups                                                        | `CustomerId` targets account **or** contact; `OwnerId` targets user **or** team. Retainer cannot declare those single fields with multiple allowed target types. Splitting each field changes the schema.                                              |
| **Zoho CRM**               | Standard/custom modules, lookup fields, multi-select lookups, subforms                              | Ordinary modules and single-target lookup relations; child modules when explicit in the source                              | Multi-select lookups are not a writable relation field in Retainer. A source linking module can remain an object, but that alone does not reproduce the parent lookup field. Subform child rows fit the graph; native subform field metadata does not. |
| **Pipedrive**              | People, organizations, deals, pipelines, stages, products, deal products and participants           | Person→organization and deal→stage/pipeline links; product attachments with their own fields can be represented as objects  | Direct participant collections need junction objects. Representing a product attachment as an object preserves its record-like structure, but exact endpoint field shapes have not been fully matched.                                                 |
| **Freshsales**             | Contacts, accounts, deals and activities; `sales_accounts` entries with account ID and primary flag | Entity objects, stage/pipeline references and ordinary activity fields                                                      | A contact's account collection has structured members. Retainer needs membership records instead of that field. Activity `targetable_id`/`targetable_type` needs a polymorphic relation or split references.                                           |
| **SugarCRM**               | Accounts, opportunities, revenue line items, direct and additional escalation relationships         | Opportunity headers and explicit revenue line item objects; a direct escalation→account relation                            | Many-to-many additional-account associations need junction objects when preserving the exposed association as a field is required. The line-item object itself is already a direct match.                                                              |
| **SuiteCRM**               | Modules and declared one-to-many, many-to-many and one-to-one relationships                         | Modules, ordinary fields and one-to-many graphs                                                                             | A framework-declared many-to-many relationship becomes an extra object in Retainer. An internal SuiteCRM join table does not remove that logical mismatch. One-to-one multiplicity cannot be declared.                                                 |
| **Odoo CRM 19.0**          | Unified `res.partner`; `crm.lead` for both leads/opportunities; stage and partner references        | A custom partner object, self-reference, lead/opportunity discriminator and stage/partner relations                         | Retainer need not split partners into base people and companies. Odoo model inheritance and related-field declarations have no equivalent in Retainer's object metadata; complete inherited structure was not reconstructed.                           |
| **Attio**                  | Objects, records, lists, entries, object attributes and list attributes                             | Ordinary objects and fields whose types match                                                                               | List attributes are scoped to a particular list. A new entry object type per list changes schema ownership. Multi-record reference attributes also need additional relationship objects.                                                               |

### Primary sources for the matrix

- **Salesforce:** [Sales Overview](https://developer.salesforce.com/docs/platform/data-models/guide/sales-cloud-overview.html), [Opportunity Contact Role fields](https://developer.salesforce.com/docs/data/data-cloud-dmo-mapping/guide/c360dm-crm-opportunity-contact-role.html). The latter is a connector field mapping, not a full object specification.
- **HubSpot:** [CRM model](https://developers.hubspot.com/docs/api-reference/latest/crm/understanding-the-crm), [associations and labels](https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide).
- **Dynamics:** [Opportunity reference](https://learn.microsoft.com/en-us/dynamics365/developer/reference/entities/opportunity), [ActivityPointer reference](https://learn.microsoft.com/en-us/dynamics365/developer/reference/entities/activitypointer).
- **Zoho:** [Standard fields](https://www.zoho.com/developer/help/build-vertical-crm/customization/standard-fields.html), [field metadata](https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html), [subforms](https://www.zoho.com/crm/developer/docs/api/v8/subforms.html).
- **Pipedrive:** [Data organization](https://support.pipedrive.com/en/article/how-is-pipedrive-data-organized), [Deals API](https://developers.pipedrive.com/docs/api/v1/Deals).
- **Freshsales:** [CRM API](https://developers.freshworks.com/crm/api/), particularly contact account collections and sales activity target fields. The page contains deprecated examples alongside newer structures.
- **SugarCRM:** [Opportunity models, version 26.1](https://support.sugarcrm.com/documentation/sugar_versions/26.1/ent/administration_guide/opportunities/), [account relationships, version 26.2](https://support.sugarcrm.com/documentation/sugar_versions/26.2/sell/application_guide/accounts/).
- **SuiteCRM:** [Relationship types](https://docs.suitecrm.com/developer/core-framework/relationships/), [vardefs](https://docs.suitecrm.com/developer/core-framework/vardefs/).
- **Odoo:** [CRM lead model, 19.0](https://github.com/odoo/odoo/blob/19.0/addons/crm/models/crm_lead.py), [partner model, 19.0](https://github.com/odoo/odoo/blob/19.0/odoo/addons/base/models/res_partner.py).
- **Attio:** [Objects and lists](https://docs.attio.com/docs/objects-and-lists), [attribute metadata](https://docs.attio.com/docs/attribute-types).

## Affinity: the follow-up case

Affinity's public V1 model defines **Persons, Organizations and Opportunities**
as its three top-level entity types. An opportunity represents a potential sale
or deal; this source does not establish a separate fixed Deal entity. Lists
contain entries for one entity type. Fields may be global, list-specific or
smart fields. Persons can reference multiple organizations; opportunities can
reference multiple persons and organizations.
Source: [Affinity V1 data model and resources](https://api-docs.affinity.co/).

| Affinity fragment                                | Retainer result                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person, Organization, Opportunity                | Direct object definitions, with naming adaptation as needed. An opportunity object is not restricted to the shipped `deal` template.                                              |
| Person's first/last name and ordinary fields     | Separate typed scalar fields are expressible.                                                                                                                                     |
| Person's organization references                 | Remodeled: Retainer cannot define that writable multi-record field; it needs a membership object.                                                                                 |
| Opportunity's person and organization references | Remodeled: two multi-record fields become separate relationship object types.                                                                                                     |
| Global fields on an entity                       | Direct when the field types match.                                                                                                                                                |
| List-specific fields on list entries             | Remodeled: separate custom entry object types can hold values, but there is no native field-definition scope for a particular list.                                               |
| Affinity's three top-level business entity types | Three base types could be renamed/reused for these entities. Their existence alone does not establish extra logical entities; the complete field definitions still need matching. |

Thus an agent can define the three main entity types and many of their fields,
but cannot reproduce this selected Affinity schema one-for-one today. The
blockers are specific field and schema-scope constructs, not the names or number
of business entities.

## Structural changes illustrated

The notation below describes source logical shapes; it is not proposed Retainer
syntax.

### A collection reference becomes an object

Source: `person.organizations: Organization[]`.

Retainer: `personOrganization.person → person` and
`personOrganization.organization → organization`.

Both retain which people relate to which organizations, but agents now discover,
create and query an additional object type. A read-only inverse is not a
substitute: its children each still have only one target through that relation.

By contrast, source `OpportunityContactRole(opportunity, contact, role)` is
already an object. Defining that object with two relations is a direct match.
These two cases must not be counted as the same limitation.

### A polymorphic reference becomes several fields

Source: `opportunity.customer: Account | Contact`.

Retainer: `opportunity.customerAccount → account` and
`opportunity.customerContact → contact`.

The replacement exposes two fields rather than one. Creating a new unified
customer object also changes the source object graph. Built-in interaction
participants can reference different record types, but that capability cannot
be declared on an arbitrary custom field.

### A field namespace becomes an object type

Source: one company's entries in fundraising and partner lists have different
list-specific fields.

Retainer: `fundraisingEntry → company` with fundraising fields, and
`partnerEntry → company` with partner fields.

The information survives, but the source has two list schemas while the
replacement has two object schemas. A saved filtered view or a JSON dictionary
does not reproduce that distinction in Retainer's typed schema.

## Evidence-backed implications for the core

These are candidate additions that would close the identified structural gaps,
not implementation decisions or a general CRM feature roadmap.

| Candidate capability                           | Evidence and breadth                                                                                                                                                     | What it would allow                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native multi-record relations                  | Multiple examples: HubSpot associations, Zoho multi-select lookups, Pipedrive participants, SuiteCRM many-to-many declarations, Attio references and Affinity references | Preserve a collection relationship without requiring an agent-visible junction object. Existing explicit relationship objects should remain available. |
| Multi-target reference fields                  | Explicit in Dynamics customer/owner lookups and Freshsales activity targets                                                                                              | Preserve one field whose allowed targets span several object types.                                                                                    |
| List-scoped entry field definitions            | Explicit in Attio and Affinity; **not established across all ten**                                                                                                       | Define attributes on a list's entries without generating a new object type for each list.                                                              |
| Configurable typed composite/collection fields | Freshsales account collection members; Zoho subform fields                                                                                                               | Preserve nested member structure. Further inspection must determine which cases need this in addition to native relations/child-object metadata.       |
| One-to-one relation metadata                   | SuiteCRM's documented relationship types                                                                                                                                 | Preserve declared graph multiplicity.                                                                                                                  |
| Optional base inventory                        | A Retainer implementation limitation exposed by arbitrary-inventory requirements; **not a recurring vendor feature finding or a demonstrated Affinity blocker**          | Allow removal of unused base identities. Renaming/reusing them can already cover some target inventories; it cannot reduce the minimum of three.       |
| Association metadata                           | HubSpot's directed labels                                                                                                                                                | Preserve labels on associations without replacing them with standalone business objects. A plain array of target IDs would not cover this.             |

The original research does not justify treating every many-to-many example as
evidence for the same change. Salesforce contact roles and Sugar revenue line
items already have meaningful object identity and fields; their existence
supports Retainer's custom-object model.

## Agent boundary and confidence

Agents can request schema changes through the existing tools. Whether a shape
is expressible is separate from whether an agent can apply it without review:
renames and required/unique field additions may require human approval. No
permission change can enable an unsupported field shape.

This assessment checks the current schema contracts and in-memory application
rules against the public fragments above. Local probes cover direct object and
hierarchy definitions, explicit relationship objects, rejected multi-record and
multi-target declarations, and rejection of base-object deletion. They do not
instantiate complete vendor schemas or verify imports against Postgres.

A full exact-match claim for any CRM would require a versioned field inventory
and a mapping for every object, field type, owner scope and reference
multiplicity, with every structural substitution reported. Public examples
alone are insufficient for that claim. Unknowns remain unknown; no aggregate
coverage score is assigned here.
