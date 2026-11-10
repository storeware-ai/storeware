import type { ActionFunctionArgs } from 'react-router';
import { storeware } from '../storeware.server';

// The raw request, untouched: a signature is over the exact bytes sent.
export function action({ request }: ActionFunctionArgs) {
  return storeware.webhooks.handle(request);
}
