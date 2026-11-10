import { describe, expect, it } from 'vitest';
import { StorewareClient } from './client';
import type { StorewareTokens } from './oauth';

/**
 * A token endpoint that behaves like the real one: every refresh spends the
 * token it was given, and presenting a spent token is reported back as theft.
 */
function fakeStoreware(options: { expiresIn?: number } = {}) {
  let generation = 0;
  let access = 'swt_0';
  let refresh = 'swr_0';
  const spent = new Set<string>();
  const state = { refreshes: 0, replays: 0 };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.pathname === '/api/oauth/token') {
      const form = new URLSearchParams(String(init?.body));
      const presented = form.get('refresh_token') ?? '';
      if (spent.has(presented) || presented !== refresh) {
        state.replays += 1;
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      // Slow enough that concurrent callers overlap with it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      spent.add(presented);
      generation += 1;
      state.refreshes += 1;
      access = `swt_${generation}`;
      refresh = `swr_${generation}`;
      return Response.json({
        access_token: access,
        refresh_token: refresh,
        expires_in: options.expiresIn ?? 86_400,
        scope: 'products:read',
        store_id: 'store-1',
        installation_id: 'inst-1',
      });
    }

    const bearer = new Headers(init?.headers).get('authorization');
    if (bearer !== `Bearer ${access}`) {
      return Response.json({ error: { type: 'unauthorized' } }, { status: 401 });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  return {
    state,
    fetchImpl,
    /** Expire the access token the client holds, as a day passing would. */
    expire() {
      access = `swt_expired_${generation}`;
    },
  };
}

function clientFor(fake: ReturnType<typeof fakeStoreware>, saved: StorewareTokens[]) {
  return new StorewareClient({
    accessToken: 'swt_0',
    refreshToken: 'swr_0',
    clientId: 'hello',
    clientSecret: 'swcs_secret',
    apiUrl: 'https://api.test',
    fetchImpl: fake.fetchImpl,
    onTokensRefreshed: (tokens) => {
      saved.push(tokens);
    },
  });
}

describe('StorewareClient token rotation', () => {
  it('presents the rotated refresh token on the second refresh, not the spent one', async () => {
    const fake = fakeStoreware();
    const saved: StorewareTokens[] = [];
    const client = clientFor(fake, saved);

    fake.expire();
    await client.get('/api/v1/stores/store-1/products');
    fake.expire();
    await client.get('/api/v1/stores/store-1/products');

    expect(fake.state.refreshes).toBe(2);
    expect(fake.state.replays).toBe(0);
    expect(saved.map((tokens) => tokens.refreshToken)).toEqual(['swr_1', 'swr_2']);
  });

  it('rotates once when ten requests hit a 401 together', async () => {
    const fake = fakeStoreware();
    const saved: StorewareTokens[] = [];
    const client = clientFor(fake, saved);

    fake.expire();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.get<{ ok: boolean }>('/api/v1/stores/store-1')),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fake.state.refreshes).toBe(1);
    expect(fake.state.replays).toBe(0);
    expect(saved).toHaveLength(1);
  });

  it('rotates ahead of expiry when it knows when the token runs out', async () => {
    const fake = fakeStoreware();
    const saved: StorewareTokens[] = [];
    const client = new StorewareClient({
      accessToken: 'swt_0',
      accessTokenExpiresAt: Date.now() + 30_000,
      refreshToken: 'swr_0',
      clientId: 'hello',
      clientSecret: 'swcs_secret',
      apiUrl: 'https://api.test',
      fetchImpl: fake.fetchImpl,
      onTokensRefreshed: (tokens) => {
        saved.push(tokens);
      },
    });

    await client.get('/api/v1/stores/store-1');

    // Rotated before the request rather than after a 401 on it.
    expect(fake.state.refreshes).toBe(1);
    expect(saved[0]?.accessToken).toBe('swt_1');
  });
});

describe('client.billing', () => {
  it('asks for a plan with the app’s token and hands back what the API answered', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const client = new StorewareClient({
      accessToken: 'swt_billing',
      apiUrl: 'https://api.test',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json(
          { data: { id: 'sub-1', status: 'pending', confirmationUrl: 'https://app.test/x' } },
          { status: 201 },
        );
      }) as typeof fetch,
    });

    const asked = await client.billing.requestSubscription({
      plan: 'pro',
      returnUrl: 'https://yourapp.test/done',
    });
    expect(asked).toMatchObject({ id: 'sub-1', confirmationUrl: 'https://app.test/x' });
    await client.billing.cancelSubscription('sub 1');
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/api/v1/app-billing/subscriptions',
        body: { plan: 'pro', returnUrl: 'https://yourapp.test/done' },
      },
      { method: 'POST', path: '/api/v1/app-billing/subscriptions/sub%201/cancel', body: null },
    ]);
  });
});

describe('client.settings and client.uploadAsset', () => {
  function recording(answer: unknown, status = 200) {
    const seen: { method: string; path: string; auth: string | null; body: unknown }[] = [];
    const client = new StorewareClient({
      accessToken: 'swt_app',
      apiUrl: 'https://api.test',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          auth: new Headers(init?.headers).get('authorization'),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({ data: answer }, { status });
      }) as typeof fetch,
    });
    return { client, seen };
  }

  it('reads the app’s own settings with its token', async () => {
    const { client, seen } = recording({
      values: { greeting: 'Hello', api_key: 'sk_test_1' },
      updatedAt: null,
    });
    expect(await client.settings()).toEqual({
      values: { greeting: 'Hello', api_key: 'sk_test_1' },
      updatedAt: null,
    });
    expect(seen).toEqual([
      { method: 'GET', path: '/api/v1/app/settings', auth: 'Bearer swt_app', body: null },
    ]);
  });

  it('sends a picture’s bytes as base64, or a base64 string as it is', async () => {
    const answer = {
      url: 'https://cdn.mystoreware.com/apps/p/s/abc.png',
      contentType: 'image/png',
      sizeBytes: 4,
      sha256: 'abc',
    };
    const { client, seen } = recording(answer, 201);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    expect(await client.uploadAsset({ data: png, contentType: 'image/png' })).toEqual(answer);
    await client.uploadAsset({ data: png.buffer, contentType: 'image/png' });
    await client.uploadAsset({ data: 'iVBORw==', contentType: 'image/png' });

    expect(seen.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', '/api/v1/app/assets', { data: 'iVBORw==', contentType: 'image/png' }],
      ['POST', '/api/v1/app/assets', { data: 'iVBORw==', contentType: 'image/png' }],
      ['POST', '/api/v1/app/assets', { data: 'iVBORw==', contentType: 'image/png' }],
    ]);
  });
});
