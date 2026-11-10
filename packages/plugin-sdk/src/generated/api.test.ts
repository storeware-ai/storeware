import { describe, expect, it } from 'vitest';
import { StorewareClient } from '../client';
import { createApiClient, operations } from './index';

interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A Storeware that writes down every request and answers each with `{ data: { ok: true } }`. */
function recording() {
  const seen: Seen[] = [];
  const client = new StorewareClient({
    accessToken: 'swt_typed',
    apiUrl: 'https://api.test',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({
        method: init?.method ?? 'GET',
        url: `${url.pathname}${url.search}`,
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ data: { ok: true } });
    }) as typeof fetch,
  });
  return { seen, api: createApiClient(client) };
}

describe('createApiClient', () => {
  it('fills the path with each parameter encoded, through the SDK client and its token', async () => {
    const { seen, api } = recording();

    const answer = await api.getProduct({ storeId: 'store 1', productId: 'a/b?c' });

    expect(answer).toEqual({ data: { ok: true } });
    expect(seen).toEqual([
      {
        method: 'GET',
        url: '/api/v1/stores/store%201/products/a%2Fb%3Fc',
        authorization: 'Bearer swt_typed',
        body: null,
      },
    ]);
  });

  it('writes the query string, leaving out what was not given', async () => {
    const { seen, api } = recording();

    await api.listProducts({ storeId: 's1', query: { status: 'active', limit: 10 } });
    await api.listProducts({ storeId: 's1' });

    expect(seen.map((request) => request.url)).toEqual([
      '/api/v1/stores/s1/products?status=active&limit=10',
      '/api/v1/stores/s1/products',
    ]);
  });

  it('sends each method with its body', async () => {
    const { seen, api } = recording();

    await api.createProduct({ storeId: 's1', body: { title: 'Mug' } });
    await api.updateProduct({ storeId: 's1', productId: 'p1', body: { title: 'Cup' } });
    await api.setProductMetafields({
      storeId: 's1',
      productId: 'p1',
      body: { metafields: [{ key: 'glaze', value: 'celadon' }] },
    });
    await api.cancelOrder({ storeId: 's1', orderId: 'o1', body: { reason: 'Asked to' } });
    await api.archiveProduct({ storeId: 's1', productId: 'p1' });
    await api.getAppBilling();

    expect(seen.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: '/api/v1/stores/s1/products', body: { title: 'Mug' } },
      { method: 'PATCH', url: '/api/v1/stores/s1/products/p1', body: { title: 'Cup' } },
      {
        method: 'PUT',
        url: '/api/v1/stores/s1/products/p1/metafields',
        body: { metafields: [{ key: 'glaze', value: 'celadon' }] },
      },
      { method: 'DELETE', url: '/api/v1/stores/s1/orders/o1', body: { reason: 'Asked to' } },
      { method: 'DELETE', url: '/api/v1/stores/s1/products/p1', body: null },
      { method: 'GET', url: '/api/v1/app-billing', body: null },
    ]);
  });

  it('names each operation’s method, path and scopes', () => {
    expect(operations.listProducts).toEqual({
      method: 'GET',
      path: '/api/v1/stores/{storeId}/products',
      scopes: ['products:read'],
    });
  });

  it('refuses to send a path with a parameter missing', async () => {
    const { seen, api } = recording();
    const untyped = api.getProduct as (input: object) => Promise<unknown>;

    await expect(untyped({ storeId: 's1' })).rejects.toThrow(/needs productId/);
    expect(seen).toEqual([]);
  });
});
