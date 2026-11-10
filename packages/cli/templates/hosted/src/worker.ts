import { createHostedApp, type HostedEnv } from '@storeware/plugin-sdk/hosted';
import { SessionVerificationError } from '@storeware/plugin-sdk/session';

/**
 * Your app, run by Storeware at the address in storeware.app.toml. There is
 * no server to keep up and no secret to keep: `env` is how Storeware hands
 * the code each shop's installation, and the SDK does the parts that are easy
 * to get wrong.
 *
 *   It verifies every webhook against the raw body with the secret of the
 *   shop it names, before your handler sees it.
 *   It proves every page in the admin by its session token.
 *   It hands you an API client for the shop, with a fresh token.
 *
 * `npm run deploy` bundles this file and sends it as a new release. What it
 * logs is in `npx @storeware/cli app logs --console`.
 */

interface Product {
  id: string;
  title: string;
}

function storewareFor(env: HostedEnv) {
  const storeware = createHostedApp(env);
  storeware.webhooks
    .on<Product>('product.created.v1', (event) => {
      console.log('product created in', event.storeId, event.data.title);
    })
    .on<Product>('product.updated.v1', (event) => {
      console.log('product updated in', event.storeId, event.data.title);
    })
    .onCompliance((event) => {
      // Find and export, or delete, what you hold about the person or shop named.
      console.log('privacy request', event.event);
    });
  return storeware;
}

async function home(storeware: ReturnType<typeof createHostedApp>, request: Request) {
  try {
    const { claims, client } = await storeware.authenticateAdmin(request);
    const { data: products } = await client.get<{ data: Product[] }>(
      `/api/v1/stores/${claims.store_id}/products?limit=5`,
    );
    return new Response(
      `<!doctype html><meta charset="utf-8"><h1>__APP_NAME__</h1><p>${products.length} product(s) read with this shop's own token.</p>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  } catch (error) {
    if (error instanceof SessionVerificationError) {
      return new Response('Open this from the Storeware admin.', { status: 401 });
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    const storeware = storewareFor(env);
    const { pathname } = new URL(request.url);

    // The raw request, untouched: a signature is over the exact bytes sent.
    if (request.method === 'POST' && (pathname === '/webhooks' || pathname === '/privacy')) {
      return storeware.webhooks.handle(request);
    }
    if (request.method === 'GET' && pathname === '/') return home(storeware, request);
    return new Response('Not found', { status: 404 });
  },
};
