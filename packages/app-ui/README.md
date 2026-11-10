# @storeware/app-ui

React components for pages the [Storeware](https://storeware.ai) admin frames, styled only by the
admin's 13 `--sw-*` variables, so your app looks like the admin around it.

```tsx
import { AppUiStyles, Button, Card, Page } from '@storeware/app-ui';

export function Home() {
  return (
    <Page>
      <AppUiStyles />
      <Card title="Settings">
        <Button>Save</Button>
      </Card>
    </Page>
  );
}
```

The variables come from App Bridge: `AppBridgeProvider` in `@storeware/app-bridge-react` applies
them. Docs: [storeware.ai/docs/extensions/app-ui](https://storeware.ai/docs/extensions/app-ui).

MIT licensed.
