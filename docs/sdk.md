# TypeScript SDK

`@retainer/sdk` is a typed client for the [REST API](rest-api.md), one method
per route. It runs anywhere `fetch` does (Node 22+, browsers, edge runtimes)
and is MIT-licensed. Response and schema types come from `@retainer/shared`.

```sh
npm install @retainer/sdk
```

The package is not on npm until the first release is published; see
[Releasing](releasing.md).

## Create a client

```ts
import { RetainerClient } from '@retainer/sdk';

const retainer = new RetainerClient({
  baseUrl: 'https://retainer.example',
  apiKey: process.env.RETAINER_API_KEY,
});
```

| Option           | Purpose                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `baseUrl`        | The server's origin. Required.                                                               |
| `apiKey`         | Sent as `Authorization: Bearer <key>`.                                                       |
| `fetch`          | A custom `fetch`, e.g. for proxies, retries or tests.                                        |
| `credentials`    | Browser only: `'include'` to authenticate with the web session cookie instead of an API key. |
| `onUnauthorized` | Called on any 401, e.g. to send a browser back to sign-in.                                   |

Like MCP, the key decides the workspace and the actor its writes are
attributed to.

## Write what happened

```ts
const acme = await retainer.createRecord('company', { values: { name: 'Acme' } });
const dana = await retainer.upsertRecord('person', {
  match: { emails: 'dana@acme.com' },
  ifMissing: 'create',
  values: { name: 'Dana Levi', emails: 'dana@acme.com' },
});

const call = await retainer.logEvent({
  type: 'call', // an event type from retainer.schema(): meeting, call, email, ...
  channel: 'zoom',
  externalId: 'zoom-8812-3390',
  occurredAt: '2026-10-29T14:00:00+02:00',
  title: 'Acme renewal call',
  summary: 'Dana wants to move the renewal to Q1.',
  fields: {}, // the event type's other fields, by name
  participants: [{ handle: 'dana@acme.com', role: 'customer' }],
  about: [acme.id], // the records it concerns: a company, project, deal or tasks
});

// Cite the call so the value carries its date and provenance.
const update = await retainer.patchRecord(dana.id, {
  values: { jobTitle: 'VP Operations' },
  source: call.id,
});
if (update.fields.jobTitle === 'pending_review') {
  // A person set this field; the new value waits for their review.
}

await retainer.remember(dana.id, {
  text: 'Legal review at Acme usually takes two weeks.',
  source: call.id,
  quote: 'legal usually needs two weeks with these',
});
```

## Read it back

```ts
const hits = await retainer.search({ query: '"renewal" Acme', limit: 10 });
// { records: [...], events: [...], facts: [...] }, each ranked on its own

const pack = await retainer.context(dana.id, { tokenBudget: 1500 });
// pack.record.fields, pack.openTasks, pack.facts, pack.recentEvents, pack.omitted

// How it got there: events, values asserted for its fields and facts, newest first.
const stageHistory = await retainer.timeline(deal.id, { fields: ['stage'], limit: 20 });
// stageHistory.items[0]: { kind: 'field_change', field, value, status, current, actor, source, at }
// next page: retainer.timeline(deal.id, { fields: ['stage'], cursor: stageHistory.nextCursor })

const page = await retainer.queryRecords('company', {
  filter: { updatedAt: { gte: '2026-10-01T00:00:00Z' } },
  sort: [{ field: 'updatedAt', direction: 'desc' }],
  limit: 50,
});
// page.records, page.nextCursor

// Events are records of event types: query a type, linked to a record.
const calls = await retainer.queryRecords('call', {
  linked: { record: acme.id },
  filter: { occurredAt: { gte: '2026-10-01T00:00:00Z' } },
  sort: [{ field: 'occurredAt', direction: 'desc' }],
});
// calls.records (each with .event: occurredAt, title, summary, participants, about)

// A record's event history, across types, with how each event is attached:
// directly, or rolled up from a record pointing at it (rollUpEvents).
const history = await retainer.recordEvents(acme.id, { limit: 20 });
// history.items[0].via: { kind: 'participant' } | { kind: 'about' } | { kind: 'field', field }
//   | { kind: 'rollup', field, record }
```

A filter maps field names to a value (equality) or to operators, and nests
with `and`, `or` and `not`: `{ or: [{ stage: 'won' }, { amount: { gte: 10000 } }] }`.
Operators are `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `contains` and
`isNull`, depending on the field type, and `containsAny`, `containsAll` and
`isEmpty` for a many-to-many relation (`filterOperatorsFor` in
`@retainer/shared`). Only fields with `isFilterable` in `retainer.schema()` can
be filtered or sorted; the error for any other field lists the allowed ones.

`search` takes keywords, all required, with quoted phrases, `OR` between two
terms, and `-word` to exclude. Each word also matches longer words that
start with it ("Dan" finds "Dana"), exact matches rank first, and accents
are ignored.

```ts
// Who connects a deal's decision-maker to people we have met?
const walk = await retainer.traverseRecords({
  starts: [deal.id],
  path: [
    { field: 'decisionMaker' },
    { link: 'participant', direction: 'in' }, // the events they took part in
    { link: 'participant', direction: 'out' }, // the others in those events
  ],
});
// walk.paths[0].records: [deal, person, event, person], each { id, type, label }
// walk.paths[0].steps: the assertion or event link behind each hop
// walk.truncated: null, 'edge_budget' or 'path_limit'
```

`traverseRecords` takes up to 20 start records and 3 steps, reads at most
500 edges and returns at most 50 paths. A step is a relation field
(`{ field, direction }`, `out` by default) or an event link
(`{ link: 'participant' | 'about', direction }`). Pick the start records
with `queryRecords`.

## Review, merge and forget

These need a key with a `user` actor.

```ts
const inbox = await retainer.review({ limit: 20 });
await retainer.decideAssertion(inbox.pendingAssertions[0].id, 'accept');

const [a, b] = inbox.mergeSuggestions[0].recordIds;
await retainer.mergeRecords(a, { recordId: b }, 'merge-' + b); // b now reads as a
await retainer.dismissMergeSuggestion(inbox.mergeSuggestions[1].id);

// Privacy request: irreversible, needs the admin scope.
const { counts, reviewCandidates } = await retainer.forget(personId);
```

## Errors

A failed request throws `RetainerApiError` with the HTTP `status`, a stable
`code` and optional `details`:

```ts
import { RetainerApiError } from '@retainer/sdk';

try {
  await retainer.patchRecord(id, { values, expectedUpdatedAt });
} catch (error) {
  if (error instanceof RetainerApiError && error.code === 'stale_write') {
    // Someone changed the record since you read it: re-read and retry.
  }
  throw error;
}
```

## Idempotency, unknown outcomes and cancellation

`createRecord`, `remember` and `mergeRecords` take an optional idempotency key
as their last argument. A retry with the same key within 24 hours returns the
original result; reusing a key with a different payload fails. The key is
scoped to the workspace and the kind of write (`create_record`, `remember`,
`merge`). The SDK does not retry on its own, so keep the key until you know
the outcome.

A write whose response is lost may still have been applied. The server
answers a commit it could not confirm with `unknown_outcome` and the
operation ID in `details`; ask `getOperation` before retrying:

```ts
const key = `call-${call.id}-legal`;
try {
  await retainer.remember(dana.id, { text, source: call.id }, key);
} catch (error) {
  if (!(error instanceof RetainerApiError && error.code === 'unknown_outcome')) throw error;
  const op = await retainer.getOperation({ kind: 'remember', idempotencyKey: key });
  // op.status: 'completed' (op.result is the original response), 'erased'
  //   (a privacy request erased it) or 'not_observed'
  if (op.status === 'not_observed') {
    await retainer.remember(dana.id, { text, source: call.id }, key); // same key: safe
  }
}
```

`not_observed` is not a rollback: the original may still commit, which is
why the retry reuses the key. `getOperation({ operationId })` looks a write
up by the ID from an `unknown_outcome` error or the `Retainer-Operation-Id`
response header. Errors with `details.retryable: true`, such as
`workspace_busy` or `write_conflict`, are safe to retry as they are.

Read methods take an `AbortSignal`, as their last argument or as `signal` in
their options.
