'use client';

import { AppBridgeProvider, useToast } from '@storeware/app-bridge-react';
import { AppUiStyles, Button, Card, Heading, Page, Stack, Text } from '@storeware/app-ui';

export function Home({
  adminUrl,
  products,
}: {
  adminUrl: string;
  products: { id: string; title: string }[];
}) {
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
