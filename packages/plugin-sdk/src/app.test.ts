import { describe, expect, it } from 'vitest';
import { createStorewareApp, NotInstalledError } from './app';
import { memoryInstallationStore } from './installations';
import { mintSession, signedDelivery, signRequest } from './testing';

const CLIENT_ID = 'hello-app';
const WEBHOOK_SECRET = 'webhook-secret-for-store-1';
const SESSION_SECRET = 'session-secret-for-store-1';

/** A token endpoint that answers every grant with store-1's tokens, and counts. */
function tokenEndpoint(options: { refuse?: boolean } = {}) {
  const grants: string[] = [];
  let issued = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body));
    grants.push(params.get('grant_type') ?? '');
    if (options.refuse) {
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'no' }), {
        status: 400,
      });
    }
    issued += 1;
    return new Response(
      JSON.stringify({
        access_token: `swt_access_${issued}`,
        refresh_token: `swt_refresh_${issued}`,
        expires_in: 3600,
        scope: 'products:read',
        store_id: 'store-1',
        installation_id: 'inst-1',
        ...(params.get('grant_type') === 'refresh_token'
          ? {}
          : { webhook_secret: WEBHOOK_SECRET, session_secret: SESSION_SECRET }),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetchImpl, grants };
}

function app(fetchImpl: typeof fetch) {
  const installations = memoryInstallationStore();
  return {
    installations,
    app: createStorewareApp({
      clientId: CLIENT_ID,
      clientSecret: 'swcs_test',
      installations,
      apiUrl: 'https://api.test',
      fetchImpl,
    }),
  };
}

const installed = (grant = 'grant-1') =>
  signedDelivery({
    secret: WEBHOOK_SECRET,
    event: 'app.installed.v1',
    storeId: 'store-1',
    data: { installationId: 'inst-1', installGrant: grant },
  });

describe('an install that started in Storeware', () => {
  it('trades the grant, keeps the shop, and verifies with the secret it bought', async () => {
    const { fetchImpl, grants } = tokenEndpoint();
    const { app: storeware, installations } = app(fetchImpl);
    const seen: string[] = [];
    storeware.webhooks.onLifecycle((event) => {
      seen.push(event.event);
    });

    expect((await storeware.webhooks.handle(await installed())).status).toBe(200);
    expect(grants).toEqual(['urn:storeware:grant-type:install']);
    expect(seen).toEqual(['app.installed.v1']);
    expect(await installations.get('store-1')).toMatchObject({
      accessToken: 'swt_access_1',
      webhookSecret: WEBHOOK_SECRET,
      sessionSecret: SESSION_SECRET,
    });

    // Redelivered: the grant is not traded twice.
    expect((await storeware.webhooks.handle(await installed())).status).toBe(200);
    expect(grants).toHaveLength(1);
  });

  it('verifies later deliveries with that shop’s secret, and refuses a shop it never met', async () => {
    const { fetchImpl } = tokenEndpoint();
    const { app: storeware } = app(fetchImpl);
    await storeware.webhooks.handle(await installed());
    let paid = 0;
    storeware.webhooks.on('order.paid.v1', () => {
      paid += 1;
    });

    const ours = await signedDelivery({
      secret: WEBHOOK_SECRET,
      event: 'order.paid.v1',
      storeId: 'store-1',
    });
    expect((await storeware.webhooks.handle(ours)).status).toBe(200);
    const stranger = await signedDelivery({
      secret: 'some-other-secret',
      event: 'order.paid.v1',
      storeId: 'store-2',
    });
    expect((await storeware.webhooks.handle(stranger)).status).toBe(401);
    expect(paid).toBe(1);
  });

  it('refuses an install whose grant does not trade', async () => {
    const { fetchImpl } = tokenEndpoint({ refuse: true });
    const { app: storeware, installations } = app(fetchImpl);
    expect((await storeware.webhooks.handle(await installed())).status).toBe(401);
    expect(await installations.get('store-1')).toBeNull();
  });
});

describe('uninstalling and installing again', () => {
  it('stops the client, still verifies privacy requests, and trades the new grant', async () => {
    const { fetchImpl, grants } = tokenEndpoint();
    const { app: storeware, installations } = app(fetchImpl);
    await storeware.webhooks.handle(await installed());

    const gone = await signedDelivery({
      secret: WEBHOOK_SECRET,
      event: 'app.uninstalled.v1',
      storeId: 'store-1',
      data: { installationId: 'inst-1' },
    });
    expect((await storeware.webhooks.handle(gone)).status).toBe(200);
    expect((await installations.get('store-1'))?.uninstalledAt).toBeTruthy();
    await expect(storeware.clientFor('store-1')).rejects.toBeInstanceOf(NotInstalledError);

    const redact = await signedDelivery({
      secret: WEBHOOK_SECRET,
      event: 'compliance.store_redacted.v1',
      storeId: 'store-1',
    });
    expect((await storeware.webhooks.handle(redact)).status).toBe(200);

    expect((await storeware.webhooks.handle(await installed('grant-2'))).status).toBe(200);
    expect(grants).toHaveLength(2);
    expect((await installations.get('store-1'))?.uninstalledAt).toBeUndefined();
  });
});

describe('authenticating the admin', () => {
  it('trades the first session for the install, and verifies locally after that', async () => {
    const { fetchImpl, grants } = tokenEndpoint();
    const { app: storeware } = app(fetchImpl);
    const token = await mintSession({
      secret: SESSION_SECRET,
      clientId: CLIENT_ID,
      claims: { store_id: 'store-1', sid: 'inst-1' },
    });

    const first = await storeware.authenticateAdmin(
      new Request(`https://app.test/home?session=${token}`),
    );
    expect(first.claims.store_id).toBe('store-1');
    expect(grants).toEqual(['urn:ietf:params:oauth:grant-type:token-exchange']);

    const second = await storeware.authenticateAdmin(
      new Request('https://app.test/api/things', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(second.installation.installationId).toBe('inst-1');
    expect(grants).toHaveLength(1);
  });

  it('refuses a session signed with another secret', async () => {
    const { fetchImpl } = tokenEndpoint();
    const { app: storeware } = app(fetchImpl);
    await storeware.webhooks.handle(await installed());
    const forged = await mintSession({
      secret: 'not-the-session-secret',
      clientId: CLIENT_ID,
      claims: { store_id: 'store-1' },
    });
    await expect(
      storeware.authenticateAdmin(new Request(`https://app.test/?session=${forged}`)),
    ).rejects.toThrow(/signature mismatch/);
  });

  it('refuses a request with no session at all', async () => {
    const { fetchImpl } = tokenEndpoint();
    const { app: storeware } = app(fetchImpl);
    await expect(storeware.authenticateAdmin(new Request('https://app.test/'))).rejects.toThrow(
      /no session token/,
    );
  });
});

describe('signed calls to tools, knowledge and blocks', () => {
  it('verifies each as its own kind, for the shop it names', async () => {
    const { fetchImpl } = tokenEndpoint();
    const { app: storeware } = app(fetchImpl);
    await storeware.webhooks.handle(await installed());

    const body = JSON.stringify({ block: 'storefront.cart.summary', storeId: 'store-1' });
    const asBlock = new Request('https://app.test/blocks', {
      method: 'POST',
      headers: {
        'storeware-signature': await signRequest({ secret: WEBHOOK_SECRET, body, kind: 'block' }),
      },
      body,
    });
    const verified = await storeware.verifyRequest<{ block: string }>(asBlock, 'block');
    expect(verified.body.block).toBe('storefront.cart.summary');

    const asWebhook = new Request('https://app.test/blocks', {
      method: 'POST',
      headers: { 'storeware-signature': await signRequest({ secret: WEBHOOK_SECRET, body }) },
      body,
    });
    await expect(storeware.verifyRequest(asWebhook, 'block')).rejects.toThrow(/signature mismatch/);
  });
});

describe('an API client per shop', () => {
  it('rotates its tokens into the store', async () => {
    const { fetchImpl, grants } = tokenEndpoint();
    const { app: storeware, installations } = app(fetchImpl);
    await storeware.webhooks.handle(await installed());
    const held = (await installations.get('store-1'))!;
    // An hour gone: the next call refreshes first.
    await installations.save({ ...held, accessTokenExpiresAt: Date.now() - 1 });

    const client = await storeware.clientFor('store-1');
    await client.get('/api/v1/anything').catch(() => undefined);
    expect(grants).toContain('refresh_token');
    const after = (await installations.get('store-1'))!;
    expect(after.refreshToken).toBe('swt_refresh_2');
    expect(after.webhookSecret).toBe(WEBHOOK_SECRET);
    expect(after.lastGrant).toBe('grant-1');
  });
});

describe('the install link', () => {
  it('points at Storeware’s own consent page', () => {
    const { fetchImpl } = tokenEndpoint();
    const { app: storeware } = app(fetchImpl);
    expect(storeware.installUrl()).toBe(
      'https://app.storeware.ai/install/hello-app?ref=developer_link',
    );
  });
});
