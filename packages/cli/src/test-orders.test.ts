import { describe, expect, it } from 'vitest';
import { parseArgs } from './args';
import { describeTestOrder, payFlag } from './test-orders';

describe('storeware store test-order --pay', () => {
  it('takes how the test payment ends as the next word', () => {
    const args = parseArgs(['store', 'test-order', '--pay', 'needs_action', '--store', 'dev']);
    expect(payFlag(args.flag('pay'), args.has('pay'))).toBe('needs_action');
    expect(args.flag('store')).toBe('dev');
  });

  it('is on account, as before, when it is not passed', () => {
    const args = parseArgs(['store', 'test-order', '--paid']);
    expect(payFlag(args.flag('pay'), args.has('pay'))).toBeUndefined();
  });

  it('refuses an ending it does not know, or none, before anything is placed', () => {
    expect(() => payFlag('succeed', true)).toThrow(/approve\|decline\|needs_action\|error/);
    const bare = parseArgs(['store', 'test-order', '--pay']);
    expect(() => payFlag(bare.flag('pay'), bare.has('pay'))).toThrow(/Usage/);
  });
});

describe('what a test order says once it is placed', () => {
  const order = { orderId: 'o', orderNumber: '1001', paid: false };

  it('says an order on account as it always did', () => {
    expect(describeTestOrder('dev', order)).toEqual(['Placed order 1001 on dev.']);
    expect(describeTestOrder('dev', { ...order, paid: true })).toEqual([
      'Placed order 1001 on dev, paid.',
    ]);
  });

  it('says how a test payment ended, and that no money moved', () => {
    expect(describeTestOrder('dev', { ...order, paid: true, payment: 'succeeded' })[0]).toMatch(
      /paid by a test payment\. No money moved\./,
    );
    expect(describeTestOrder('dev', { ...order, payment: 'declined' })[0]).toMatch(/declined/);
    expect(describeTestOrder('dev', { ...order, payment: 'failed' })[0]).toMatch(/failed/);
  });

  it('hands over the bank page for a payment waiting for it', () => {
    const said = describeTestOrder('dev', {
      ...order,
      payment: 'waiting_for_bank',
      authenticationUrl: 'https://dev.storeware.shop/checkout/authenticate/abc',
    });
    expect(said[0]).toMatch(/waiting for the shopper's bank/);
    expect(said.at(-1)).toBe('  https://dev.storeware.shop/checkout/authenticate/abc');
  });

  it('uses no dash to join words', () => {
    for (const payment of ['succeeded', 'declined', 'failed', 'waiting_for_bank'] as const) {
      for (const line of describeTestOrder('dev', { ...order, payment, authenticationUrl: 'x' })) {
        expect(line).not.toMatch(/ [-–—] /);
      }
    }
  });
});
