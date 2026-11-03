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

const call = await retainer.logInteraction({
  kind: 'call',
  channel: 'zoom',
  externalId: 'zoom-8812-3390',
  occurredAt: '2026-10-29T14:00:00+02:00',
  title: 'Acme renewal call',
  summary: 'Dana wants to move the renewal to Q1.',
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
// { records: [...], facts: [...], interactions: [...] }, each ranked on its own

const pack = await retainer.context(dana.id, { tokenBudget: 1500 });
// pack.record.fields, pack.openTasks, pack.facts, pack.recentInteractions, pack.omitted

const page = await retainer.queryRecords('company', {
  filter: { updatedAt: { gte: '2026-10-01T00:00:00Z' } },
  sort: [{ field: 'updatedAt', direction: 'desc' }],
  limit: 50,
});
// page.records, page.nextCursor

const calls = await retainer.queryInteractions({
  filter: { record: acme.id, occurredAt: { gte: '2026-10-01T00:00:00Z' } },
  countBy: 'kind',
});
// calls.items, calls.total, calls.counts ({ call: 4, meeting: 2 }), calls.nextCursor
```

A filter maps field names to a value (equality) or to operators, and nests
with `and`, `or` and `not`: `{ or: [{ stage: 'won' }, { amount: { gte: 10000 } }] }`.
Operators are `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `contains` and
`isNull`, depending on the field type (`FILTER_OPERATORS` in
`@retainer/shared`). Only fields with `isFilterable` in `retainer.schema()` can
be filtered or sorted; the error for any other field lists the allowed ones.

`search` takes Postgres `websearch_to_tsquery` syntax: quoted phrases, `OR`,
and `-word` to exclude.

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

## Idempotency and cancellation

`createRecord`, `remember` and `mergeRecords` take an optional idempotency key
as their last argument. A retry with the same key returns the original result;
reusing a key with a different payload fails. Read methods take an
`AbortSignal`, as their last argument or as `signal` in their options.
