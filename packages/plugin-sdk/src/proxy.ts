import { timingSafeEqual } from './crypto';
import {
  verifySignedRequest,
  WebhookVerificationError,
  type VerifyWebhookOptions,
} from './webhooks';

/**
 * Pages under a shop's own address: `https://<shop>/apps/<your-slug>/...`.
 *
 * Declare `[app_proxy] url = "https://your-app.example/proxy"` and Storeware
 * forwards each shopper's request there, GET or a form's POST, signed with the
 * installation's secret as the kind `proxy`. It never carries the shopper's
 * cookies or anything that names them.
 *
 * What is signed is the `storeware-proxy` header: the method, the path after
 * `/apps/<slug>`, the query, the shop's hostname, the store and a SHA-256 of
 * the body. `verifyProxyRequest` checks the signature, then the body against
 * that hash, and hands back the signed path and query. Route on those rather
 * than on the URL your server saw.
 */

/** The header that carries what Storeware signed. */
export const PROXY_HEADER = 'storeware-proxy';

/** What a verified proxy request was for. */
export interface ProxyRequest {
  method: 'GET' | 'POST';
  /** After `/apps/<slug>`, starting with `/`. `/` is your app's root page. */
  path: string;
  /** The query, without its `?`. Parse it with `new URLSearchParams(query)`. */
  query: string;
  /** The hostname the shopper used, one of the shop's own. */
  shop: string;
  /** `/apps/<slug>`, for building links and form actions back to yourself. */
  pathPrefix: string;
  storeId: string;
}

interface SignedDescriptor extends ProxyRequest {
  bodySha256: string;
}

export interface VerifyProxyOptions extends Omit<VerifyWebhookOptions, 'rawBody'> {
  /** The `storeware-proxy` header, exactly as received. */
  proxyHeader: string | null | undefined;
  /**
   * The body exactly as received, or empty for a GET. A multipart form may
   * hold bytes that are not text, so pass `await request.arrayBuffer()`.
   */
  rawBody?: string | ArrayBuffer | Uint8Array;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function bytesOf(body: string | ArrayBuffer | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

/**
 * Verifies a request Storeware forwarded from a shop's `/apps/<slug>/` path
 * and returns what it was for.
 *
 * Throws `WebhookVerificationError` for a missing or wrong signature, a stale
 * timestamp, or a body that is not the one that was signed.
 */
export async function verifyProxyRequest(options: VerifyProxyOptions): Promise<ProxyRequest> {
  if (!options.proxyHeader) throw new WebhookVerificationError(`missing ${PROXY_HEADER} header`);

  const signed = await verifySignedRequest<SignedDescriptor>({
    secret: options.secret,
    rawBody: options.proxyHeader,
    signatureHeader: options.signatureHeader,
    kind: 'proxy',
    ...(options.toleranceSeconds === undefined
      ? {}
      : { toleranceSeconds: options.toleranceSeconds }),
    ...(options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds }),
  });

  const hash = await sha256Hex(bytesOf(options.rawBody));
  if (typeof signed.bodySha256 !== 'string' || !timingSafeEqual(hash, signed.bodySha256)) {
    throw new WebhookVerificationError('the body is not the one that was signed');
  }

  return {
    method: signed.method,
    path: signed.path,
    query: signed.query,
    shop: signed.shop,
    pathPrefix: signed.pathPrefix,
    storeId: signed.storeId,
  };
}
