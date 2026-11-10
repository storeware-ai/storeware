import { base64urlToText } from './crypto';
import { WebhookVerificationError } from './webhooks';

/**
 * Reading Storeware's requests before they are verified, shared by
 * `createStorewareApp` and `createHostedApp`.
 *
 * Nothing read here is trusted. It only says whose secret to verify with, and
 * naming the wrong one picks a secret that fails. Not exported from the
 * package: it is how the two apps agree, not something an app calls.
 */

/** The session token on a request: `?session=` first, then `Authorization: Bearer`. */
export function sessionTokenOf(request: Request): string | null {
  const fromQuery = new URL(request.url).searchParams.get('session');
  if (fromQuery) return fromQuery;
  const header = request.headers.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
}

/** The claims of a session token, unverified: only to find which secret verifies it. */
export function unverifiedClaims(token: string): { storeId: string | null; sid: string | null } {
  try {
    const body = token.split('.')[1];
    if (!body) return { storeId: null, sid: null };
    const claims = JSON.parse(base64urlToText(body)) as { store_id?: unknown; sid?: unknown };
    return {
      storeId: typeof claims.store_id === 'string' ? claims.store_id : null,
      sid: typeof claims.sid === 'string' ? claims.sid : null,
    };
  } catch {
    return { storeId: null, sid: null };
  }
}

/** The shop a signed tool, block or other call names in its body. Throws when it is not JSON. */
export function storeIdNamedIn(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { storeId?: unknown; store_id?: unknown };
    const named = parsed.storeId ?? parsed.store_id;
    return typeof named === 'string' ? named : null;
  } catch {
    throw new WebhookVerificationError('body is not JSON');
  }
}

/** Where to send a merchant to install an app from Storeware. */
export function appInstallUrl(
  clientId: string,
  adminUrl: string,
  choice: { storeId?: string } = {},
): string {
  const url = new URL(`/install/${encodeURIComponent(clientId)}`, adminUrl);
  if (choice.storeId) url.searchParams.set('store', choice.storeId);
  url.searchParams.set('ref', 'developer_link');
  return url.toString();
}
