import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import {
  createStorewareApp,
  memoryInstallationStore,
  SessionVerificationError,
} from '@storeware/plugin-sdk';

/**
 * Your app's server, on Hono. The SDK does the parts that are easy to get wrong:
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

interface Product {
  id: string;
  title: string;
}

storeware.webhooks
  .on<Product>('product.created.v1', (event) => {
    console.log('product created in', event.storeId, event.data.title);
  })
  .on<Product>('product.updated.v1', (event) => {
    console.log('product updated in', event.storeId, event.data.title);
  })
  .onCompliance((event) => {
    // Find and export, or delete, what you hold about the person or shop named.
    console.log('privacy request', event.event, event.data);
  });

const app = new Hono();

// The raw request, untouched: a signature is over the exact bytes sent.
app.post('/webhooks', (c) => storeware.webhooks.handle(c.req.raw));
app.post('/privacy', (c) => storeware.webhooks.handle(c.req.raw));

async function home(c: Context) {
  try {
    const { claims, client } = await storeware.authenticateAdmin(c.req.raw);
    const { data: products } = await client.get<{ data: Product[] }>(
      `/api/v1/stores/${claims.store_id}/products?limit=5`,
    );
    return c.html(
      `<!doctype html><meta charset="utf-8"><h1>Installed</h1><p>${products.length} product(s) read with this shop's own token.</p>`,
    );
  } catch (error) {
    if (error instanceof SessionVerificationError) {
      return c.text('Open this from the Storeware admin.', 401);
    }
    throw error;
  }
}

app.get('/app', home);
app.get('/app/*', home);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`listening on ${process.env.STOREWARE_APP_URL ?? `http://localhost:${PORT}`}`);
});
