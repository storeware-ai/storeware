# @storeware/app-bridge-react

React hooks for App Bridge: toasts, the title bar, the save bar, modals, confirm and the resource
picker in the [Storeware](https://storeware.ai) admin.

```tsx
import { AppBridgeProvider, useToast } from '@storeware/app-bridge-react';

export function Home() {
  return (
    <AppBridgeProvider hostOrigin="https://app.storeware.ai">
      <Save />
    </AppBridgeProvider>
  );
}

function Save() {
  const toast = useToast();
  return <button onClick={() => toast('Saved')}>Save</button>;
}
```

Docs: [storeware.ai/docs/extensions/app-bridge-react](https://storeware.ai/docs/extensions/app-bridge-react).

MIT licensed.
