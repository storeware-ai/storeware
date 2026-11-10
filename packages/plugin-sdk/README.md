# @storeware/plugin-sdk

Build apps for [Storeware](https://storeware.ai) shops. Verify webhooks, call the API, stay in scope.

```ts
import { createStorewareApp, memoryInstallationStore } from '@storeware/plugin-sdk';

const storeware = createStorewareApp({
  clientId: process.env.STOREWARE_CLIENT_ID!,
  clientSecret: process.env.STOREWARE_CLIENT_SECRET!,
  installations: memoryInstallationStore(),
});

storeware.webhooks.on('order.paid.v1', (event) => console.log(event.storeId, event.data));

// Any fetch-style server: Workers, Next route handlers, Hono, Bun, Deno.
export default { fetch: (request: Request) => storeware.webhooks.handle(request) };
```

It verifies every signed request against the raw body, finishes installs that start in Storeware,
proves each page in the admin by its session token, and keeps each shop's tokens rotating.
`@storeware/plugin-sdk/api` is a typed client for every call in the public API.

Docs: [storeware.ai/docs/sdk](https://storeware.ai/docs/sdk). The quickest start is
`npx @storeware/cli init`.

MIT licensed.
