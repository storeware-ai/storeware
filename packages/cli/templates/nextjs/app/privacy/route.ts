import { storeware } from '@/lib/storeware';

// Data requests, erasures and a shop's deletion, verified like any webhook.
export function POST(request: Request) {
  return storeware.webhooks.handle(request);
}
