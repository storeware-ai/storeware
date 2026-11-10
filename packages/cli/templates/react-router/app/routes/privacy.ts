import type { ActionFunctionArgs } from 'react-router';
import { storeware } from '../storeware.server';

// Data requests, erasures and a shop's deletion, verified like any webhook.
export function action({ request }: ActionFunctionArgs) {
  return storeware.webhooks.handle(request);
}
