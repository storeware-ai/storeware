import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizationUrl,
  createPkcePair,
  createState,
  exchangeCode,
  refreshTokens,
  StorewareOAuthError,
} from './oauth';
import { StorewareApiError, StorewareClient } from './client';

const TOKEN_BODY = {
  access_token: 'swt_abc',
  refresh_token: 'swr_abc',
  expires_in: 86400,
  scope: 'products:read products:write',
  store_id: 'store-1',
  installation_id: 'inst-1',
  webhook_secret: 'whsec',
};

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('PKCE helpers', () => {
  it('produces a challenge that is the hash of its verifier', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('stays inside the RFC 7636 length bounds', async () => {
    const { verifier } = await createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('never repeats', async () => {
    const pairs = await Promise.all(Array.from({ length: 50 }, () => createPkcePair()));
    const seen = new Set(pairs.map((pair) => pair.verifier));
    expect(seen.size).toBe(50);
    expect(new Set(Array.from({ length: 50 }, createState)).size).toBe(50);
  });
});

describe('authorizationUrl', () => {
  it('carries everything the consent screen needs', () => {
    const url = new URL(
      authorizationUrl({
        clientId: 'my-app',
        redirectUri: 'https://plugin.test/cb',
        scopes: ['products:read', 'orders:read'],
        codeChallenge: 'challenge',
        state: 'state-1',
        storeId: 'store-1',
      }),
    );

    expect(url.origin).toBe('https://app.storeware.ai');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('my-app');
    expect(url.searchParams.get('scope')).toBe('products:read orders:read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('omits store_id when the plugin does not know it yet', () => {
    const url = new URL(
      authorizationUrl({
        clientId: 'my-app',
        redirectUri: 'https://plugin.test/cb',
        scopes: ['products:read'],
        codeChallenge: 'challenge',
        state: 'state-1',
      }),
    );
    expect(url.searchParams.has('store_id')).toBe(false);
  });
});

describe('token requests', () => {
  it('posts form encoded credentials and maps the response', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify(TOKEN_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    const tokens = await exchangeCode({
      clientId: 'my-app',
      clientSecret: 'secret',
      code: 'code-1',
      redirectUri: 'https://plugin.test/cb',
      codeVerifier: 'verifier',
      apiUrl: 'https://api.test',
      fetchImpl,
    });

    expect(calls[0]!.url).toBe('https://api.test/api/oauth/token');
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_secret')).toBe('secret');

    expect(tokens.scopes).toEqual(['products:read', 'products:write']);
    expect(tokens.webhookSecret).toBe('whsec');
  });

  it('omits the webhook secret when a refresh does not return one', async () => {
    const { webhook_secret: _omitted, ...withoutSecret } = TOKEN_BODY;

    const tokens = await refreshTokens({
      clientId: 'my-app',
      clientSecret: 'secret',
      refreshToken: 'swr_abc',
      fetchImpl: jsonFetch(withoutSecret),
    });

    expect(tokens.webhookSecret).toBeUndefined();
  });

  it('turns an RFC error body into a typed error', async () => {
    await expect(
      exchangeCode({
        clientId: 'my-app',
        clientSecret: 'secret',
        code: 'bad',
        redirectUri: 'https://plugin.test/cb',
        codeVerifier: 'verifier',
        fetchImpl: jsonFetch(
          { error: 'invalid_grant', error_description: 'That code is not valid' },
          400,
        ),
      }),
    ).rejects.toBeInstanceOf(StorewareOAuthError);
  });
});

describe('StorewareClient', () => {
  it('sends the bearer token', async () => {
    const headers: Headers[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new StorewareClient({ accessToken: 'swt_abc', fetchImpl });
    await client.get('/api/v1/stores/store-1/products');

    expect(headers[0]!.get('authorization')).toBe('Bearer swt_abc');
  });

  it('refreshes once on 401 and hands back the rotated tokens', async () => {
    const onTokensRefreshed = vi.fn();
    let call = 0;

    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/api/oauth/token')) {
        return new Response(JSON.stringify({ ...TOKEN_BODY, access_token: 'swt_new' }), {
          status: 200,
        });
      }
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ error: { type: 'unauthorized' } }), { status: 401 })
        : new Response(JSON.stringify({ data: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new StorewareClient({
      accessToken: 'swt_old',
      refreshToken: 'swr_old',
      clientId: 'my-app',
      clientSecret: 'secret',
      onTokensRefreshed,
      fetchImpl,
    });

    await expect(client.get('/api/v1/stores/store-1/products')).resolves.toEqual({ data: 'ok' });

    // The old pair is dead the moment this fires, so an author who ignores it
    // has nothing that works on the next process start.
    expect(onTokensRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'swt_new' }),
    );
  });

  it('does not loop when the refresh also fails to help', async () => {
    let apiCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/api/oauth/token')) {
        return new Response(JSON.stringify(TOKEN_BODY), { status: 200 });
      }
      apiCalls += 1;
      return new Response(JSON.stringify({ error: { type: 'unauthorized' } }), { status: 401 });
    }) as unknown as typeof fetch;

    const client = new StorewareClient({
      accessToken: 'swt_old',
      refreshToken: 'swr_old',
      clientId: 'my-app',
      clientSecret: 'secret',
      onTokensRefreshed: () => {},
      fetchImpl,
    });

    await expect(client.get('/api/v1/x')).rejects.toBeInstanceOf(StorewareApiError);
    expect(apiCalls).toBe(2);
  });

  it('surfaces the scopes a forbidden call needed', async () => {
    const client = new StorewareClient({
      accessToken: 'swt_abc',
      fetchImpl: jsonFetch(
        {
          error: {
            type: 'forbidden',
            message: 'Missing required scope: products:write',
            requiredScopes: ['products:write'],
          },
        },
        403,
      ),
    });

    await expect(client.post('/api/v1/stores/store-1/products', {})).rejects.toMatchObject({
      status: 403,
      requiredScopes: ['products:write'],
    });
  });
});
