import { SessionVerificationError } from '@storeware/plugin-sdk';
import { ADMIN_URL, storeware } from '@/lib/storeware';
import { Home } from './home';

// Every request carries a new session, so nothing here is cached.
export const dynamic = 'force-dynamic';

interface Product {
  id: string;
  title: string;
}

/**
 * Your home inside the admin. The admin opens it with `?session=`, a token only
 * Storeware can sign; `authenticateAdmin` proves it, and the first time a shop
 * opens it, trades it for that shop's tokens, which is the install.
 */
export default async function AppHome({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;
  try {
    // A page has no Request of its own, so the session is handed over the way
    // your own pages' fetches send it: as a bearer token.
    const { claims, client } = await storeware.authenticateAdmin(
      new Request('http://localhost/app', {
        headers: { authorization: `Bearer ${session ?? ''}` },
      }),
    );
    const { data: products } = await client.get<{ data: Product[] }>(
      `/api/v1/stores/${claims.store_id}/products?limit=5`,
    );
    return <Home adminUrl={ADMIN_URL} products={products} />;
  } catch (error) {
    if (error instanceof SessionVerificationError) {
      return <p>Open this from the Storeware admin.</p>;
    }
    throw error;
  }
}
