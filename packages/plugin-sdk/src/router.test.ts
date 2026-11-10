import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWebhookRouter } from './router';

const SECRET = 'installation-secret';
const hmac = (value: string) => createHmac('sha256', SECRET).update(value).digest('hex');

function delivery(event: string, data: unknown = {}, kind = 'webhook', storeId = 's') {
  const body = JSON.stringify({ id: '1', event, storeId, createdAt: 'now', data });
  const t = Math.floor(Date.now() / 1000);
  return new Request('https://app.test/webhooks', {
    method: 'POST',
    body,
    headers: {
      'storeware-signature': `t=${t},v1=${hmac(`${t}.${body}`)},v2=${hmac(`${t}.${kind}.${body}`)}`,
    },
  });
}

describe('createWebhookRouter', () => {
  it('dispatches a verified delivery to the handler for its topic', async () => {
    const seen: string[] = [];
    const router = createWebhookRouter({ secret: SECRET }).on('order.paid.v1', (event) => {
      seen.push(event.event);
    });

    const response = await router.handle(delivery('order.paid.v1'));
    expect(response.status).toBe(200);
    expect(seen).toEqual(['order.paid.v1']);
  });

  it('sends what a shop pays to the billing handler, and nothing else there', async () => {
    const seen: string[] = [];
    const router = createWebhookRouter({ secret: SECRET })
      .onBilling((event) => {
        seen.push(`billing:${event.event}`);
      })
      .onLifecycle((event) => {
        seen.push(`lifecycle:${event.event}`);
      });

    await router.handle(delivery('app_subscription.updated.v1'));
    await router.handle(delivery('app_purchase.accepted.v1'));
    await router.handle(delivery('app_usage.cap_reached.v1'));
    await router.handle(delivery('app.installed.v1'));
    expect(seen).toEqual([
      'billing:app_subscription.updated.v1',
      'billing:app_purchase.accepted.v1',
      'billing:app_usage.cap_reached.v1',
      'lifecycle:app.installed.v1',
    ]);
  });

  it('answers 401 and calls nothing for a signature that does not verify', async () => {
    let called = false;
    const router = createWebhookRouter({ secret: 'not-the-secret' }).on('order.paid.v1', () => {
      called = true;
    });

    expect((await router.handle(delivery('order.paid.v1'))).status).toBe(401);
    expect(called).toBe(false);
  });

  it('sends events about the app to the lifecycle handler, and privacy requests to compliance', async () => {
    const seen: string[] = [];
    const router = createWebhookRouter({ secret: SECRET })
      .onLifecycle((event) => {
        seen.push(`lifecycle:${event.event}`);
      })
      .onCompliance((event) => {
        seen.push(`compliance:${event.event}`);
      });

    await router.handle(delivery('app.uninstalled.v1'));
    await router.handle(delivery('compliance.customer_redacted.v1'));
    expect(seen).toEqual([
      'lifecycle:app.uninstalled.v1',
      'compliance:compliance.customer_redacted.v1',
    ]);
  });

  it('answers 200 for a topic nobody handles, and 500 for a handler that throws', async () => {
    const router = createWebhookRouter({ secret: SECRET }).on('order.paid.v1', () => {
      throw new Error('boom');
    });
    expect((await router.handle(delivery('product.created.v1'))).status).toBe(200);
    expect((await router.handle(delivery('order.paid.v1'))).status).toBe(500);
  });

  it('looks the secret up by shop, since every installation has its own', async () => {
    const asked: (string | null)[] = [];
    const router = createWebhookRouter({
      secret: ({ storeId }) => {
        asked.push(storeId);
        return storeId === 's' ? SECRET : null;
      },
    }).on('order.paid.v1', () => undefined);

    expect((await router.handle(delivery('order.paid.v1'))).status).toBe(200);
    expect((await router.handle(delivery('order.paid.v1', {}, 'webhook', 'other'))).status).toBe(
      401,
    );
    expect(asked).toEqual(['s', 'other']);
  });

  it('hands the lookup the installation the header names, on any event', async () => {
    const asked: unknown[] = [];
    const router = createWebhookRouter({
      secret: (address) => {
        asked.push(address);
        return SECRET;
      },
    });
    const named = delivery('order.paid.v1');
    named.headers.set('storeware-installation', 'inst-1');
    await router.handle(named);
    await router.handle(delivery('order.paid.v1'));
    expect(asked).toEqual([
      { storeId: 's', installationId: null, namedInstallationId: 'inst-1' },
      { storeId: 's', installationId: null, namedInstallationId: null },
    ]);
  });

  it('trades the grant on an install it holds no secret for, then verifies with what came back', async () => {
    const traded: string[] = [];
    let installed = false;
    const router = createWebhookRouter({
      secret: () => null,
      onInstallGrant: async ({ grant, installationId }) => {
        traded.push(`${grant}:${installationId}`);
        return SECRET;
      },
    }).onLifecycle(() => {
      installed = true;
    });

    const response = await router.handle(
      delivery('app.installed.v1', { installationId: 'inst-1', installGrant: 'grant-1' }),
    );
    expect(response.status).toBe(200);
    expect(traded).toEqual(['grant-1:inst-1']);
    expect(installed).toBe(true);
  });

  it('refuses an install whose grant does not trade, or that did not come from Storeware', async () => {
    const refusing = createWebhookRouter({
      secret: () => null,
      onInstallGrant: async () => {
        throw new Error('invalid_grant');
      },
    });
    expect(
      (await refusing.handle(delivery('app.installed.v1', { installGrant: 'forged' }))).status,
    ).toBe(401);

    // The grant traded, but the delivery was not signed with the secret it bought.
    const mismatched = createWebhookRouter({
      secret: () => null,
      onInstallGrant: async () => 'a-different-secret',
    });
    expect(
      (await mismatched.handle(delivery('app.installed.v1', { installGrant: 'g' }))).status,
    ).toBe(401);
  });

  it('never trades a grant for any event but an install', async () => {
    let traded = false;
    const router = createWebhookRouter({
      secret: () => null,
      onInstallGrant: async () => {
        traded = true;
        return SECRET;
      },
    });
    expect((await router.handle(delivery('order.paid.v1', { installGrant: 'g' }))).status).toBe(
      401,
    );
    expect(traded).toBe(false);
  });
});
