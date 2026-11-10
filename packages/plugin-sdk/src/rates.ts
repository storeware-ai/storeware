import { z } from 'zod';
import { verifySignedRequest, type VerifyWebhookOptions } from './webhooks';

/**
 * What Storeware posts to your `[checkout.delivery_rates] url` for a basket
 * with a delivery address, to ask what you would charge to deliver it.
 *
 * Every amount is in the basket currency's minor unit (cents, pence). Answer
 * within 3 seconds with `{ rates: [...] }` (see `deliveryRatesAnswer`), in at
 * most 32 KB. Your rates are offered beside the shop's own; if you are slow,
 * fail or answer with something that does not parse, the shopper sees the
 * shop's own rates and checkout carries on.
 *
 * An answer is reused for a few minutes while nothing below changes, so a
 * shopper typing in a delivery form does not ask you on every keystroke. The
 * same question can still reach you twice; answer it the same way.
 */
export interface DeliveryRatesRequest {
  storeId: string;
  /** ISO 4217, upper case. Your amounts are read in it. */
  currency: string;
  destination: {
    /** ISO 3166-1 alpha-2. */
    country: string;
    region: string | null;
    postalCode: string | null;
    city: string | null;
  };
  /** Only the lines that are delivered: a download is left out. */
  lines: {
    variantId: string;
    sku: string | null;
    title: string;
    quantity: number;
    /** Per unit. */
    unitPrice: number;
    /** Per unit, or null when the merchant has not weighed it. */
    grams: number | null;
  }[];
  /** The goods, after any discount on them, before delivery and tax. */
  subtotal: number;
}

/**
 * One rate you offer. `id` is yours and stable: a shopper's choice is kept
 * by it while the basket changes, as long as you keep answering with it.
 */
export const deliveryRate = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, _ and -, up to 64'),
    name: z.string().trim().min(1).max(80),
    /** In the basket currency's minor unit. Zero for free delivery. */
    amount: z.number().int().min(0),
    description: z.string().trim().max(200).optional(),
    /** Working days until it arrives, at the soonest and at the latest. */
    min_days: z.number().int().min(0).max(365).optional(),
    max_days: z.number().int().min(0).max(365).optional(),
  })
  .refine(
    (rate) =>
      rate.min_days === undefined || rate.max_days === undefined || rate.min_days <= rate.max_days,
    {
      message: 'min_days is after max_days',
    },
  );

/**
 * The answer Storeware reads: up to 20 rates. An empty list is a fine answer
 * and means you do not deliver this basket.
 */
export const deliveryRatesAnswer = z.object({
  rates: z.array(deliveryRate).max(20),
});

export type DeliveryRate = z.infer<typeof deliveryRate>;
export type DeliveryRatesAnswer = z.infer<typeof deliveryRatesAnswer>;

/**
 * Verifies a delivery-rate request and returns the basket it asks about.
 *
 * Signed with your installation's secret as the kind `rates`, so nothing
 * signed for another endpoint can be replayed here.
 */
export function verifyRatesRequest(options: VerifyWebhookOptions): Promise<DeliveryRatesRequest> {
  return verifySignedRequest<DeliveryRatesRequest>({ ...options, kind: 'rates' });
}
