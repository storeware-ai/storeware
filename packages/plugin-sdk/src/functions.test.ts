import { describe, expect, it } from 'vitest';
import { FUNCTION_SCHEMAS, defineFunctions } from './functions';
import { ManifestError, parseManifest } from './manifest';

/**
 * Checkout functions as an app declares and answers them.
 *
 * The manifest rules keep a function hosted, scoped and reading only its own
 * fields; the output schemas are the line between an app's code and a price.
 */

const HOSTED = `
[app]
slug = "bulk-deals"
name = "Bulk deals"
url = "https://bulk-deals.storewareapps.com/"

[oauth]
scopes = ["products:read", "checkout:read"]

[runtime]

[metafields]
[[metafields.definitions]]
owner_type = "product"
key = "pack_size"
name = "Pack size"
type = "integer"

[[functions]]
kind = "discount"
handle = "volume_discount"
name = "Volume discount"
metafields = ["product.pack_size"]
`;

function problemsOf(source: string): string[] {
  try {
    parseManifest(source);
    return [];
  } catch (error) {
    if (error instanceof ManifestError) return [...error.issues];
    throw error;
  }
}

describe('a checkout function in the manifest', () => {
  it('parses, with its fields', () => {
    expect(parseManifest(HOSTED).functions).toEqual([
      {
        kind: 'discount',
        handle: 'volume_discount',
        name: 'Volume discount',
        metafields: ['product.pack_size'],
      },
    ]);
  });

  it('needs hosting and checkout:read', () => {
    const remote = HOSTED.replace('[runtime]\n', '').replace(
      'https://bulk-deals.storewareapps.com/',
      'https://bulk.example/',
    );
    expect(problemsOf(remote)).toContain(
      'functions: checkout functions run on Storeware, so they need [runtime]',
    );
    expect(problemsOf(HOSTED.replace(', "checkout:read"', ''))).toContain(
      'functions: need checkout:read, which oauth.scopes does not request',
    );
  });

  it('reads only fields this app declares, each once, and a handle once', () => {
    expect(problemsOf(HOSTED.replace('["product.pack_size"]', '["product.colour"]'))).toEqual([
      'functions.volume_discount: product.colour is not a field this app declares',
    ]);
    expect(
      problemsOf(
        HOSTED.replace('["product.pack_size"]', '["product.pack_size", "product.pack_size"]'),
      ),
    ).toEqual(['functions.volume_discount: names a field twice']);
    const twice = `${HOSTED}\n[[functions]]\nkind = "cart_validation"\nhandle = "volume_discount"\nname = "Packs"\n`;
    expect(problemsOf(twice)).toEqual(['functions: two share a handle']);
    expect(problemsOf(HOSTED.replace('["product.pack_size"]', '["order.total"]')).join()).toMatch(
      /functions/,
    );
  });
});

describe('what a function may answer', () => {
  it('keeps a delivery answer to ids, titles and amounts it may change', () => {
    const out = FUNCTION_SCHEMAS.delivery_rates.output;
    expect(out.safeParse({ options: [{ id: 'standard', amount: 0 }] }).success).toBe(true);
    expect(out.safeParse({ options: [{ id: 'standard', carrier: 'X' }] }).success).toBe(false);
    expect(out.safeParse({ options: [{ id: 'standard', amount: -1 }] }).success).toBe(false);
  });

  it('keeps a discount to a title, a target and one value', () => {
    const out = FUNCTION_SCHEMAS.discount.output;
    const discount = { title: 'Bulk order, 10% off', target: 'order', value: { percent: 10 } };
    expect(out.safeParse({ discounts: [discount] }).success).toBe(true);
    expect(out.safeParse({ discounts: [{ ...discount, value: { percent: 101 } }] }).success).toBe(
      false,
    );
    expect(
      out.safeParse({ discounts: [{ ...discount, value: { percent: 5, amount: 5 } }] }).success,
    ).toBe(false);
    expect(out.safeParse({ discounts: Array(6).fill(discount) }).success).toBe(false);
  });

  it('keeps payment methods and refusals to what the platform knows', () => {
    expect(FUNCTION_SCHEMAS.payment_methods.output.safeParse({ methods: ['paypal'] }).success).toBe(
      false,
    );
    expect(
      FUNCTION_SCHEMAS.cart_validation.output.safeParse({ errors: [{ message: '' }] }).success,
    ).toBe(false);
  });

  it('types a handler by its kind and exports the run functions', () => {
    const functions = defineFunctions({
      volume_discount: { kind: 'discount', run: () => ({ discounts: [] }) },
    });
    expect(typeof functions.volume_discount).toBe('function');
  });
});
