import { storeware } from '@/lib/storeware';

// The raw request, untouched: a signature is over the exact bytes sent.
export function POST(request: Request) {
  return storeware.webhooks.handle(request);
}
