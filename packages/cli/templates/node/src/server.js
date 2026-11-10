import { createServer } from 'node:http';
import {
  createStorewareApp,
  memoryInstallationStore,
  SessionVerificationError,
} from '@storeware/plugin-sdk';
import { toNodeListener } from '@storeware/plugin-sdk/node';

/**
 * Your app's server. The SDK does the parts that are easy to get wrong:
 *
 *   It verifies every webhook against the raw body with the secret of the
 *   shop it names, before your handler sees it.
 *   It finishes installs that start in Storeware, by trading the grant in
 *   app.installed.v1 or the session your home is first opened with.
 *   It proves every page in the admin by its session token.
 *   It keeps each shop's tokens rotating.
 *
 * `storeware app dev` sets the environment below for you.
 */

const PORT = Number(process.env.PORT ?? 4000);

const storeware = createStorewareApp({
  clientId: process.env.STOREWARE_CLIENT_ID ?? '',
  clientSecret: process.env.STOREWARE_CLIENT_SECRET ?? '',
  // In memory, so installs are forgotten on restart. Replace it with
  // kvInstallationStore(env.KV) or your own store over a database: the
  // secrets in it are handed over once and never again.
  installations: memoryInstallationStore(),
  ...(process.env.STOREWARE_API_URL ? { apiUrl: process.env.STOREWARE_API_URL } : {}),
  ...(process.env.STOREWARE_ADMIN_URL ? { adminUrl: process.env.STOREWARE_ADMIN_URL } : {}),
});

storeware.webhooks
  .on('product.created.v1', (event) => {
    console.log('product created in', event.storeId, event.data);
  })
  .on('product.updated.v1', (event) => {
    console.log('product updated in', event.storeId, event.data);
  })
  .onCompliance((event) => {
    // Find and export, or delete, what you hold about the person or shop named.
    console.log('privacy request', event.event, event.data);
  });

async function handle(request) {
  const url = new URL(request.url);

  if (request.method === 'POST' && (url.pathname === '/webhooks' || url.pathname === '/privacy')) {
    return storeware.webhooks.handle(request);
  }

  if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
    try {
      const { claims, client } = await storeware.authenticateAdmin(request);
      const { data: products } = await client.get(
        `/api/v1/stores/${claims.store_id}/products?limit=5`,
      );
      return new Response(
        `<!doctype html><meta charset="utf-8"><h1>Installed</h1><p>${products.length} product(s) read with this shop's own token.</p>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    } catch (error) {
      if (error instanceof SessionVerificationError) {
        return new Response('Open this from the Storeware admin.', { status: 401 });
      }
      throw error;
    }
  }

  return new Response('Not found', { status: 404 });
}

createServer(toNodeListener(handle)).listen(PORT, () => {
  console.log(`listening on ${process.env.STOREWARE_APP_URL ?? `http://localhost:${PORT}`}`);
});
