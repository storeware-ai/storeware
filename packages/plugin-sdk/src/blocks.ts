import {
  verifySignedRequest,
  WebhookVerificationError,
  type VerifyWebhookOptions,
} from './webhooks';

/**
 * What Storeware posts to a storefront block endpoint.
 *
 * `context` carries what the shop front knows about the page, such as the
 * product handle on a product page. Everything in it came from a shopper's
 * browser, so treat it as input, not as a fact.
 */
export interface StorefrontBlockRequest {
  block: string;
  storeId: string;
  context: Record<string, string>;
}

/**
 * What Storeware posts for one of your `[[extensions.sections]]`, which a
 * merchant placed on a page in the page editor.
 *
 * Signed exactly like a block, as the kind `block`, so one endpoint can serve
 * both: a section request carries `section` (the handle you declared) and no
 * `block`, and also arrives with the header `x-storeware-section`.
 */
export interface StorefrontSectionRequest {
  section: string;
  storeId: string;
  context: Record<string, string>;
}

/**
 * Verifies a storefront block request and returns what it asked for.
 *
 * The secret is the one your app received when the merchant installed it, the
 * same one webhooks use. A block request is signed as a block, so a webhook
 * replayed at this endpoint fails, and so does a block request replayed at
 * your webhook endpoint.
 */
export function verifyBlockRequest(
  options: VerifyWebhookOptions,
): Promise<StorefrontBlockRequest & { section?: string }> {
  return verifySignedRequest<StorefrontBlockRequest & { section?: string }>({
    ...options,
    kind: 'block',
  });
}

/**
 * Verifies a section request and returns what it asked for.
 *
 * Refuses a block request, so an endpoint meant for sections never draws a
 * block by mistake. To serve both from one URL, call `verifyBlockRequest` and
 * look for `section` in what it returns.
 */
export async function verifySectionRequest(
  options: VerifyWebhookOptions,
): Promise<StorefrontSectionRequest> {
  const request = await verifySignedRequest<Partial<StorefrontSectionRequest>>({
    ...options,
    kind: 'block',
  });
  if (typeof request.section !== 'string') {
    throw new WebhookVerificationError('not a section request');
  }
  return request as StorefrontSectionRequest;
}
