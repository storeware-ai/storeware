import { useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { SessionVerificationError } from '@storeware/plugin-sdk';
import { AppBridgeProvider, useToast } from '@storeware/app-bridge-react';
import { AppUiStyles, Button, Card, Heading, Page, Stack, Text } from '@storeware/app-ui';
import { ADMIN_URL, storeware } from '../storeware.server';

interface Product {
  id: string;
  title: string;
}

/**
 * Your home inside the admin. The admin opens it with `?session=`, a token only
 * Storeware can sign; `authenticateAdmin` proves it, and the first time a shop
 * opens it, trades it for that shop's tokens, which is the install.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { claims, client } = await storeware.authenticateAdmin(request);
    const { data: products } = await client.get<{ data: Product[] }>(
      `/api/v1/stores/${claims.store_id}/products?limit=5`,
    );
    return { products, adminUrl: ADMIN_URL };
  } catch (error) {
    if (error instanceof SessionVerificationError) {
      throw new Response('Open this from the Storeware admin.', { status: 401 });
    }
    throw error;
  }
}

export default function Home() {
  const { products, adminUrl } = useLoaderData<typeof loader>();
  return (
    <AppBridgeProvider hostOrigin={adminUrl}>
      <AppUiStyles />
      <Page>
        <Stack>
          <Heading level={1}>__APP_NAME__</Heading>
          <Card title="Installed">
            <Text>{products.length} product(s) read with this shop&apos;s own token.</Text>
            <ul>
              {products.map((product) => (
                <li key={product.id}>{product.title}</li>
              ))}
            </ul>
          </Card>
          <SayHello />
        </Stack>
      </Page>
    </AppBridgeProvider>
  );
}

/** A toast in the admin, through App Bridge. */
function SayHello() {
  const toast = useToast();
  return <Button onClick={() => toast('Hello from your app')}>Say hello</Button>;
}
