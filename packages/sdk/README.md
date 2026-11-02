# @retainer/sdk

Typed TypeScript client for the [Retainer](https://github.com/Tamloot-cc/Retainer)
REST API: one method per route, typed responses and typed errors.

```ts
import { RetainerClient } from '@retainer/sdk';

const retainer = new RetainerClient({
  baseUrl: 'https://retainer.example',
  apiKey: process.env.RETAINER_API_KEY,
});

const hits = await retainer.search({ query: 'renewal' });
const pack = await retainer.context(hits.records[0].id, { tokenBudget: 1500 });
```

See the [SDK guide](https://github.com/Tamloot-cc/Retainer/blob/main/docs/sdk.md)
and the [REST API reference](https://github.com/Tamloot-cc/Retainer/blob/main/docs/rest-api.md).

MIT licensed.
