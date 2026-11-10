import { TEST_PAYMENT_OUTCOMES, type TestOrder, type TestPaymentOutcome } from './api';

/**
 * `storeware store test-order`, apart from the request: reading `--pay` and
 * saying what came of it, so both are held by tests with no network.
 */

/** `--pay`'s value, or undefined when it was not passed. Throws on anything else. */
export function payFlag(
  value: string | undefined,
  passed: boolean,
): TestPaymentOutcome | undefined {
  if (!passed) return undefined;
  if (value && (TEST_PAYMENT_OUTCOMES as readonly string[]).includes(value)) {
    return value as TestPaymentOutcome;
  }
  throw new Error(`Usage: storeware store test-order --pay ${TEST_PAYMENT_OUTCOMES.join('|')}`);
}

/** What to print once a test order is placed. */
export function describeTestOrder(handle: string, order: TestOrder): string[] {
  const placed = `Placed order ${order.orderNumber} on ${handle}`;
  if (order.payment === undefined) return [`${placed}${order.paid ? ', paid' : ''}.`];
  switch (order.payment) {
    case 'succeeded':
      return [`${placed}, paid by a test payment. No money moved.`];
    case 'declined':
      return [`${placed}. Its test payment was declined, so it waits unpaid.`];
    case 'failed':
      return [`${placed}. Its test payment failed at the provider, so it waits unpaid.`];
    case 'waiting_for_bank':
      return [
        `${placed}. Its test payment is waiting for the shopper's bank.`,
        ...(order.authenticationUrl
          ? [
              'Approve or fail it on the test bank page, in a browser previewing the store:',
              `  ${order.authenticationUrl}`,
            ]
          : []),
      ];
  }
}
