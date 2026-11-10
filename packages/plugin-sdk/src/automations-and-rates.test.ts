import { describe, expect, it } from 'vitest';
import { verifyActionRequest } from './actions';
import { deliveryRatesAnswer, verifyRatesRequest } from './rates';
import { signRequest } from './testing';
import { WebhookVerificationError } from './webhooks';

/**
 * The two doors an app opens for automations and checkout: an action a
 * merchant's rule reaches, and the delivery rates a basket asks for. Each
 * verifies only a request signed for it, and the rates answer is held to the
 * shape Storeware reads, so an app can check its own answer before sending it.
 */

const secret = 'whsec_test';

describe('verifying', () => {
  it('accepts an action signed as an action, and refuses one signed as rates', async () => {
    const rawBody = JSON.stringify({ action: 'add_points', fields: { points: 5 } });
    const asAction = await signRequest({ secret, kind: 'action', body: rawBody });
    await expect(
      verifyActionRequest({ secret, rawBody, signatureHeader: asAction }),
    ).resolves.toMatchObject({ action: 'add_points' });

    const asRates = await signRequest({ secret, kind: 'rates', body: rawBody });
    await expect(
      verifyActionRequest({ secret, rawBody, signatureHeader: asRates }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('accepts a rates request signed as rates, and refuses a webhook', async () => {
    const rawBody = JSON.stringify({ currency: 'GBP', lines: [], subtotal: 0 });
    const asRates = await signRequest({ secret, kind: 'rates', body: rawBody });
    await expect(
      verifyRatesRequest({ secret, rawBody, signatureHeader: asRates }),
    ).resolves.toMatchObject({ currency: 'GBP' });

    const asWebhook = await signRequest({ secret, kind: 'webhook', body: rawBody });
    await expect(
      verifyRatesRequest({ secret, rawBody, signatureHeader: asWebhook }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});

describe('a rates answer', () => {
  it('takes whole minor units, zero included', () => {
    expect(
      deliveryRatesAnswer.safeParse({
        rates: [
          { id: 'next_day', name: 'Next day', amount: 695, min_days: 1, max_days: 1 },
          { id: 'free', name: 'Free', amount: 0 },
        ],
      }).success,
    ).toBe(true);
  });

  it('refuses a negative or fractional amount, a bad id, and more than twenty', () => {
    const rate = { id: 'std', name: 'Standard', amount: 100 };
    expect(deliveryRatesAnswer.safeParse({ rates: [{ ...rate, amount: -1 }] }).success).toBe(false);
    expect(deliveryRatesAnswer.safeParse({ rates: [{ ...rate, amount: 1.5 }] }).success).toBe(
      false,
    );
    expect(deliveryRatesAnswer.safeParse({ rates: [{ ...rate, id: 'has space' }] }).success).toBe(
      false,
    );
    expect(
      deliveryRatesAnswer.safeParse({ rates: Array.from({ length: 21 }, () => rate) }).success,
    ).toBe(false);
  });

  it('refuses a soonest day after the latest', () => {
    expect(
      deliveryRatesAnswer.safeParse({
        rates: [{ id: 'x', name: 'X', amount: 1, min_days: 5, max_days: 2 }],
      }).success,
    ).toBe(false);
  });
});
