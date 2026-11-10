import { describe, expect, it } from 'vitest';
import { verifyBlockRequest, verifySectionRequest } from './blocks';
import { verifyProxyRequest } from './proxy';
import { signRequest } from './testing';
import { WebhookVerificationError } from './webhooks';

/**
 * Verifying what Storeware forwards from a shop's `/apps/<slug>/` pages, and
 * the sections a merchant places in the page editor.
 */

const NOW = 1_785_160_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function proxied(body: string, overrides: Record<string, unknown> = {}) {
  const proxyHeader = JSON.stringify({
    method: 'POST',
    path: '/saved',
    query: 'page=2',
    shop: 'shop.example',
    pathPrefix: '/apps/wishlist',
    storeId: 'store-1',
    bodySha256: await sha256Hex(body),
    ...overrides,
  });
  const signatureHeader = await signRequest({
    secret: 'secret',
    body: proxyHeader,
    kind: 'proxy',
    timestampSeconds: NOW,
  });
  return { proxyHeader, signatureHeader };
}

describe('a proxy request', () => {
  it('is verified, and hands back the signed path, query and shop', async () => {
    const body = 'email=a%40b.test';
    const signed = await proxied(body);

    expect(
      await verifyProxyRequest({ secret: 'secret', ...signed, rawBody: body, nowSeconds: NOW }),
    ).toEqual({
      method: 'POST',
      path: '/saved',
      query: 'page=2',
      shop: 'shop.example',
      pathPrefix: '/apps/wishlist',
      storeId: 'store-1',
    });
  });

  it('checks a form held as bytes as well as text', async () => {
    const signed = await proxied('a=1');
    const bytes = new TextEncoder().encode('a=1');

    await expect(
      verifyProxyRequest({ secret: 'secret', ...signed, rawBody: bytes.buffer, nowSeconds: NOW }),
    ).resolves.toMatchObject({ path: '/saved' });
  });

  it('refuses a body that is not the one that was signed', async () => {
    const signed = await proxied('a=1');

    await expect(
      verifyProxyRequest({ secret: 'secret', ...signed, rawBody: 'a=2', nowSeconds: NOW }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it('refuses a header changed after signing, and one signed as another kind', async () => {
    const signed = await proxied('');
    const moved = signed.proxyHeader.replace('/saved', '/admin');
    const asBlock = await signRequest({
      secret: 'secret',
      body: signed.proxyHeader,
      kind: 'block',
      timestampSeconds: NOW,
    });

    await expect(
      verifyProxyRequest({
        secret: 'secret',
        proxyHeader: moved,
        signatureHeader: signed.signatureHeader,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow('signature mismatch');
    await expect(
      verifyProxyRequest({
        secret: 'secret',
        proxyHeader: signed.proxyHeader,
        signatureHeader: asBlock,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow('signature mismatch');
  });

  it('refuses a request with no proxy header', async () => {
    await expect(
      verifyProxyRequest({ secret: 'secret', proxyHeader: null, signatureHeader: 'x' }),
    ).rejects.toThrow('missing storeware-proxy header');
  });
});

describe('a section request', () => {
  const sectionBody = JSON.stringify({ section: 'chart', storeId: 'store-1', context: {} });
  const blockBody = JSON.stringify({
    block: 'storefront.cart.summary',
    storeId: 'store-1',
    context: {},
  });

  it('is verified as a section, and its handle is handed back', async () => {
    const signatureHeader = await signRequest({
      secret: 'secret',
      body: sectionBody,
      kind: 'block',
      timestampSeconds: NOW,
    });

    expect(
      await verifySectionRequest({
        secret: 'secret',
        rawBody: sectionBody,
        signatureHeader,
        nowSeconds: NOW,
      }),
    ).toEqual({ section: 'chart', storeId: 'store-1', context: {} });
    // The same request reads through `verifyBlockRequest`, for one endpoint serving both.
    expect(
      (
        await verifyBlockRequest({
          secret: 'secret',
          rawBody: sectionBody,
          signatureHeader,
          nowSeconds: NOW,
        })
      ).section,
    ).toBe('chart');
  });

  it('refuses a block request at a section endpoint', async () => {
    const signatureHeader = await signRequest({
      secret: 'secret',
      body: blockBody,
      kind: 'block',
      timestampSeconds: NOW,
    });

    await expect(
      verifySectionRequest({
        secret: 'secret',
        rawBody: blockBody,
        signatureHeader,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow('not a section request');
  });
});
