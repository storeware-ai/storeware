import { hmacSha256Hex, timingSafeEqual } from './crypto';

/**
 * Webhook verification for plugin authors.
 *
 * This ships in the SDK because the failure mode of hand-rolling it is
 * invisible: a plugin that verifies incorrectly still works perfectly in
 * development and testing, and only turns out to have been accepting forged
 * events once somebody sends one.
 *
 * Three mistakes this exists to prevent:
 *
 *   Verifying a re-serialised body. Parsing JSON and stringifying it again
 *   changes whitespace and key order, so the signature never matches. Authors
 *   then "fix" it by skipping verification.
 *
 *   Ignoring the timestamp. Without a freshness window, one captured delivery
 *   can be replayed forever.
 *
 *   Comparing with `===`. String comparison returns early on the first
 *   differing byte, which leaks how much of a guess was right.
 */

export const SIGNATURE_HEADER = 'storeware-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export class WebhookVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`Webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

export interface StorewareEvent<T = unknown> {
  id: string;
  /** Versioned, for example `product.created.v1`. */
  event: string;
  storeId: string | null;
  createdAt: string;
  data: T;
}

export interface VerifyWebhookOptions {
  /** The secret handed to your plugin when a merchant installed it. */
  secret: string;
  /**
   * The raw request body, exactly as received.
   *
   * Read this before any JSON parsing. In Next.js that is `await
   * request.text()`, in Express it needs `express.raw()`. A parsed object
   * will not verify.
   */
  rawBody: string;
  signatureHeader: string | null | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/**
 * What a signed request from Storeware is for. Matches the platform's list.
 *
 * One secret signs every call Storeware makes to your app, so the kind is part
 * of what is signed: a webhook captured on its way to you cannot be replayed at
 * your block or tool endpoint, because it was signed as a webhook.
 */
export type SignedRequestKind =
  'webhook' | 'tool' | 'knowledge' | 'block' | 'proxy' | 'action' | 'lifecycle' | 'rates';

export const KIND_HEADER = 'storeware-kind';

/**
 * The installation a signed request is for, so an app knows whose secret to
 * verify it with before reading the body. Not signed: naming the wrong one
 * only picks a secret that fails.
 */
export const INSTALLATION_HEADER = 'storeware-installation';

export interface VerifySignedRequestOptions extends VerifyWebhookOptions {
  /** The kind this endpoint serves. A request signed as anything else fails. */
  kind: SignedRequestKind;
}

/**
 * Verifies any signed request from Storeware and returns its parsed body.
 *
 * Requires the `v2` signature, which covers the timestamp, the kind and the
 * raw body. The older `v1` signature covers no kind and is still sent for
 * apps built before this existed, but it is not accepted here: accepting it
 * would let anyone who strips `v2` from a header replay a request across
 * endpoints, which is the exact thing `v2` exists to stop.
 */
export async function verifySignedRequest<T = unknown>(
  options: VerifySignedRequestOptions,
): Promise<T> {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!options.signatureHeader) throw new WebhookVerificationError('missing signature header');

  const parts = new Map(
    options.signatureHeader
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([k, v]) => [k, v]),
  );

  const timestampRaw = parts.get('t');
  const provided = parts.get('v2');
  if (!timestampRaw || !provided) throw new WebhookVerificationError('malformed signature header');

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) throw new WebhookVerificationError('malformed timestamp');

  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError('timestamp outside the tolerance window');
  }

  const expected = await hmacSha256Hex(
    options.secret,
    `${timestamp}.${options.kind}.${options.rawBody}`,
  );
  if (!timingSafeEqual(expected, provided)) {
    throw new WebhookVerificationError('signature mismatch');
  }

  return JSON.parse(options.rawBody) as T;
}

/**
 * Verifies a webhook delivery and returns the parsed event.
 *
 * Throws rather than returning a boolean, so an author who forgets to check
 * the result gets a failure instead of silently trusting a forged payload.
 */
export function verifyWebhook<T = unknown>(
  options: VerifyWebhookOptions,
): Promise<StorewareEvent<T>> {
  return verifySignedRequest<StorewareEvent<T>>({ ...options, kind: 'webhook' });
}
