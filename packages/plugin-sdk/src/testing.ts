import { hmacSha256Base64url, hmacSha256Hex, textToBase64url } from './crypto';
import type { SignedRequestKind } from './webhooks';
import type { ExtensionSessionClaims } from './session';

/**
 * Signing as Storeware does, for an app's own tests.
 *
 * A test that hand-rolls a signature tends to agree with the code it tests
 * rather than with Storeware. These sign exactly as the platform signs, so a
 * handler that passes here verifies real deliveries.
 */

/** The `storeware-signature` header for a body, as Storeware would send it. */
export async function signRequest(options: {
  secret: string;
  body: string;
  kind?: SignedRequestKind;
  timestampSeconds?: number;
}): Promise<string> {
  const t = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const kind = options.kind ?? 'webhook';
  const v1 = await hmacSha256Hex(options.secret, `${t}.${options.body}`);
  const v2 = await hmacSha256Hex(options.secret, `${t}.${kind}.${options.body}`);
  return `t=${t},v1=${v1},v2=${v2}`;
}

/** A webhook delivery as a `Request`, signed for the shop's secret. */
export async function signedDelivery(options: {
  secret: string;
  event: string;
  data?: unknown;
  storeId?: string;
  url?: string;
}): Promise<Request> {
  const body = JSON.stringify({
    id: String(Date.now()),
    event: options.event,
    storeId: options.storeId ?? 'store-test',
    createdAt: new Date().toISOString(),
    data: options.data ?? {},
  });
  return new Request(options.url ?? 'https://app.test/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'storeware-signature': await signRequest({ secret: options.secret, body }),
      'storeware-kind': 'webhook',
    },
    body,
  });
}

/** A session token like the one the admin frames your home or panel with. */
export async function mintSession(options: {
  secret: string;
  clientId: string;
  claims?: Partial<ExtensionSessionClaims>;
  ttlSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = textToBase64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = textToBase64url(
    JSON.stringify({
      iss: 'https://storeware.ai',
      aud: options.clientId,
      sub: 'staff-test',
      iat: now,
      exp: now + (options.ttlSeconds ?? 300),
      jti: crypto.randomUUID(),
      sid: 'installation-test',
      store_id: 'store-test',
      org_id: 'org-test',
      context: {},
      ...options.claims,
    }),
  );
  return `${header}.${body}.${await hmacSha256Base64url(options.secret, `${header}.${body}`)}`;
}
