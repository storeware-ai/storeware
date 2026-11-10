import { z } from 'zod';

/**
 * Checkout functions: small pure pieces of an app's code that Storeware runs
 * at the moment a basket is priced, for web checkout and for AI agents alike.
 *
 * A function is named in `[[functions]]` in `storeware.app.toml` and exported
 * from the app's hosted bundle as `export const functions = { [handle]: fn }`.
 * Storeware calls it with a JSON input and reads a JSON output, in an isolate
 * with no network, no `env` and a few milliseconds of CPU. If it throws, runs
 * too long or answers something these schemas refuse, checkout carries on as
 * if it were not there: no discount, the options unchanged, every payment
 * method offered, nothing refused.
 *
 * Its answer is kept for the exact input it was given, so a function must be
 * pure: the same input always gives the same output.
 */

export const FUNCTION_KINDS = [
  'discount',
  'delivery_rates',
  'payment_methods',
  'cart_validation',
] as const;
export type FunctionKind = (typeof FUNCTION_KINDS)[number];

/**
 * The payment methods a function can hide or reorder. Platform level on
 * purpose: `card` is every card and wallet Stripe offers, `on_account` is
 * paying later on a business's terms, `crypto` is stablecoin payment.
 */
export const PAYMENT_METHODS = ['card', 'on_account', 'crypto'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** CPU time one call may use, in milliseconds. */
export const FUNCTION_CPU_MS = 25;
/** Wall time one call may take, in milliseconds, waiting included. */
export const FUNCTION_WALL_MS = 250;
/** The largest answer a function may give, as JSON, in bytes. */
export const MAX_FUNCTION_OUTPUT_BYTES = 16 * 1024;

const minor = z.number().int().min(0);
const id = z.string().min(1).max(200);

/** One line of the basket, as every kind sees it. */
export const functionLine = z.object({
  id,
  productId: id,
  variantId: id,
  sku: z.string().nullable(),
  title: z.string(),
  variantTitle: z.string().nullable(),
  quantity: z.number().int().min(1),
  /** Per unit, in minor units, before any discount. */
  unitPrice: minor,
  grams: z.number().int().min(0).nullable(),
  requiresShipping: z.boolean(),
  /**
   * The fields this app keeps on the product and variant, for the keys the
   * function declared in `metafields`. `product.<key>` and `variant.<key>`.
   */
  metafields: z.record(z.string(), z.unknown()),
});
export type FunctionLine = z.infer<typeof functionLine>;

/** What every kind is given: the basket, who is buying, and where it goes. */
export const basketInput = z.object({
  storeId: id,
  /** ISO 4217, upper case. */
  currency: z.string().length(3),
  lines: z.array(functionLine),
  /** The lines' total before any discount, in minor units. */
  subtotal: minor,
  buyer: z.object({
    customerId: z.string().nullable(),
    /** Set when a business is buying, on its own prices and terms. */
    companyId: z.string().nullable(),
    email: z.string().nullable(),
    /** The customer's own fields this app keeps, `customer.<key>`. */
    metafields: z.record(z.string(), z.unknown()),
  }),
  destination: z
    .object({
      country: z.string(),
      region: z.string().nullable(),
      postalCode: z.string().nullable(),
      city: z.string().nullable(),
    })
    .nullable(),
  /** The code the shopper typed, if any. */
  discountCode: z.string().nullable(),
  /** The delivery option chosen so far, after any delivery function ran. */
  delivery: z.object({ id, type: z.string(), title: z.string(), amount: minor }).nullable(),
  /** `web` for the shop's own checkout, `agent` for an AI agent's. */
  channel: z.enum(['web', 'agent']),
});
export type BasketInput = z.infer<typeof basketInput>;

// ---------------------------------------------------------------------------
// delivery_rates: hide, rename, reorder or reprice what the basket offers
// ---------------------------------------------------------------------------

export const deliveryOption = z.object({
  id,
  type: z.string(),
  title: z.string(),
  description: z.string().optional(),
  carrier: z.string().optional(),
  amount: minor,
});
export type DeliveryOption = z.infer<typeof deliveryOption>;

export const deliveryRatesInput = basketInput.extend({ options: z.array(deliveryOption) });
export type DeliveryRatesInput = z.infer<typeof deliveryRatesInput>;

/**
 * The options to offer, in order. An option left out is hidden. Only options
 * the input named may appear, each once, so an id never changes and nothing
 * is invented; offering new rates is `[checkout.delivery_rates]`'s job.
 */
export const deliveryRatesOutput = z.object({
  options: z
    .array(
      z
        .object({
          id,
          title: z.string().trim().min(1).max(80).optional(),
          amount: minor.optional(),
        })
        .strict(),
    )
    .max(50),
});
export type DeliveryRatesOutput = z.infer<typeof deliveryRatesOutput>;

// ---------------------------------------------------------------------------
// discount: amounts off lines, the order or delivery
// ---------------------------------------------------------------------------

export const discountInput = basketInput;
export type DiscountInput = z.infer<typeof discountInput>;

const discountValue = z.union([
  /** Percent off, 0 to 100, to two decimal places. */
  z.object({ percent: z.number().min(0).max(100) }).strict(),
  /** A fixed amount off, in minor units of the basket's currency. */
  z.object({ amount: minor }).strict(),
]);

export const discountOutput = z.object({
  discounts: z
    .array(
      z
        .object({
          /** What the shopper and the agent are shown, such as "Bulk order, 10% off". */
          title: z.string().trim().min(1).max(60),
          target: z.union([
            z.literal('order'),
            z.literal('delivery'),
            z.object({ lines: z.array(id).min(1).max(100) }).strict(),
          ]),
          value: discountValue,
        })
        .strict(),
    )
    .max(5),
});
export type DiscountOutput = z.infer<typeof discountOutput>;

// ---------------------------------------------------------------------------
// payment_methods: hide or reorder
// ---------------------------------------------------------------------------

export const paymentMethodsInput = basketInput.extend({
  methods: z.array(z.enum(PAYMENT_METHODS)),
});
export type PaymentMethodsInput = z.infer<typeof paymentMethodsInput>;

/** The methods to offer, in order. A method left out is not offered, and refused if tried. */
export const paymentMethodsOutput = z.object({
  methods: z.array(z.enum(PAYMENT_METHODS)).max(PAYMENT_METHODS.length),
});
export type PaymentMethodsOutput = z.infer<typeof paymentMethodsOutput>;

// ---------------------------------------------------------------------------
// cart_validation: refuse a basket, with a reason the shopper can act on
// ---------------------------------------------------------------------------

export const cartValidationInput = basketInput;
export type CartValidationInput = z.infer<typeof cartValidationInput>;

export const cartValidationOutput = z.object({
  errors: z
    .array(
      z
        .object({
          /** Plain words the shopper is shown, such as "Sold in packs of 6". */
          message: z.string().trim().min(1).max(200),
          lineId: id.optional(),
        })
        .strict(),
    )
    .max(5),
});
export type CartValidationOutput = z.infer<typeof cartValidationOutput>;

/** Each kind's input and output schema, by kind. */
export const FUNCTION_SCHEMAS = {
  discount: { input: discountInput, output: discountOutput },
  delivery_rates: { input: deliveryRatesInput, output: deliveryRatesOutput },
  payment_methods: { input: paymentMethodsInput, output: paymentMethodsOutput },
  cart_validation: { input: cartValidationInput, output: cartValidationOutput },
} as const satisfies Record<FunctionKind, { input: z.ZodTypeAny; output: z.ZodTypeAny }>;

export interface FunctionTypes {
  discount: (input: DiscountInput) => DiscountOutput | Promise<DiscountOutput>;
  delivery_rates: (input: DeliveryRatesInput) => DeliveryRatesOutput | Promise<DeliveryRatesOutput>;
  payment_methods: (
    input: PaymentMethodsInput,
  ) => PaymentMethodsOutput | Promise<PaymentMethodsOutput>;
  cart_validation: (
    input: CartValidationInput,
  ) => CartValidationOutput | Promise<CartValidationOutput>;
}

/**
 * Types an app's `functions` export, so each handler is checked against its kind.
 *
 *   export const functions = defineFunctions({
 *     volume_discount: { kind: 'discount', run: (input) => ({ discounts: [] }) },
 *   });
 */
export function defineFunctions<
  T extends {
    [handle: string]: { [K in FunctionKind]: { kind: K; run: FunctionTypes[K] } }[FunctionKind];
  },
>(functions: T): { [H in keyof T]: T[H]['run'] } {
  return Object.fromEntries(
    Object.entries(functions).map(([handle, entry]) => [handle, entry.run]),
  ) as { [H in keyof T]: T[H]['run'] };
}
