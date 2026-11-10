import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignedRequest, verifyWebhook, WebhookVerificationError } from './webhooks';
import { verifyBlockRequest } from './blocks';

const SECRET = 'installation-secret';
const NOW = 1_785_160_000;
const BODY = JSON.stringify({
  id: '42',
  event: 'product.created.v1',
  storeId: 'store_1',
  createdAt: '2026-07-27T00:00:00.000Z',
  data: { productId: 'prod_1' },
});

const hmac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('hex');

/** What the platform sends: the original v1 beside v2, which also signs the kind. */
const sign = (body: string, ts: number, secret = SECRET, kind = 'webhook') =>
  `t=${ts},v1=${hmac(secret, `${ts}.${body}`)},v2=${hmac(secret, `${ts}.${kind}.${body}`)}`;

describe('verifyWebhook', () => {
  it('returns the parsed event for a genuine delivery', async () => {
    const event = await verifyWebhook<{ productId: string }>({
      secret: SECRET,
      rawBody: BODY,
      signatureHeader: sign(BODY, NOW),
      nowSeconds: NOW,
    });

    expect(event.event).toBe('product.created.v1');
    expect(event.data.productId).toBe('prod_1');
  });

  it('throws rather than returning false, so a forgotten check cannot pass', async () => {
    await expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sign(BODY, NOW, 'wrong-secret'),
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it('rejects a replayed delivery', async () => {
    await expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sign(BODY, NOW - 3600),
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(/tolerance window/);
  });

  it('rejects a tampered body', async () => {
    const header = sign(BODY, NOW);
    await expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: BODY.replace('prod_1', 'prod_2'),
        signatureHeader: header,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(/signature mismatch/);
  });

  it('fails on a re-serialised body, which is the classic author mistake', async () => {
    const header = sign(BODY, NOW);
    const reparsed = JSON.stringify(JSON.parse(BODY));
    // Identical here only because key order happens to survive. Pretty
    // printing does not, and that is what catches people out.
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);

    await expect(
      verifyWebhook({ secret: SECRET, rawBody: pretty, signatureHeader: header, nowSeconds: NOW }),
    ).rejects.toThrow(/signature mismatch/);
    await expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: reparsed,
        signatureHeader: header,
        nowSeconds: NOW,
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['no signature part', `t=${NOW}`],
    ['garbage', 'nonsense'],
  ])('rejects a %s header', async (_label, header) => {
    await expect(
      verifyWebhook({ secret: SECRET, rawBody: BODY, signatureHeader: header, nowSeconds: NOW }),
    ).rejects.toThrow(WebhookVerificationError);
  });
});

describe('the kind a request was signed for', () => {
  it('refuses a header carrying only v1, which signs no kind', async () => {
    // Stripping v2 is the whole of a cross-endpoint replay, so v1 alone is
    // never enough for this SDK, however valid it is.
    const v1Only = `t=${NOW},v1=${hmac(SECRET, `${NOW}.${BODY}`)}`;
    await expect(
      verifyWebhook({ secret: SECRET, rawBody: BODY, signatureHeader: v1Only, nowSeconds: NOW }),
    ).rejects.toThrow('malformed signature header');
  });

  it('refuses a block request replayed at a webhook endpoint', async () => {
    await expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sign(BODY, NOW, SECRET, 'block'),
        nowSeconds: NOW,
      }),
    ).rejects.toThrow('signature mismatch');
  });

  it('verifies a block request as a block, and refuses a webhook replayed there', async () => {
    const body = JSON.stringify({
      block: 'storefront.cart.summary',
      storeId: 'store_1',
      context: { cart: 'yes' },
    });

    const request = await verifyBlockRequest({
      secret: SECRET,
      rawBody: body,
      signatureHeader: sign(body, NOW, SECRET, 'block'),
      nowSeconds: NOW,
    });
    expect(request.block).toBe('storefront.cart.summary');

    await expect(
      verifyBlockRequest({
        secret: SECRET,
        rawBody: body,
        signatureHeader: sign(body, NOW, SECRET, 'webhook'),
        nowSeconds: NOW,
      }),
    ).rejects.toThrow('signature mismatch');
  });

  it('verifies any kind the endpoint names', async () => {
    const body = JSON.stringify({ tool: 'describe_product' });
    const request = await verifySignedRequest<{ tool: string }>({
      secret: SECRET,
      rawBody: body,
      signatureHeader: sign(body, NOW, SECRET, 'tool'),
      nowSeconds: NOW,
      kind: 'tool',
    });
    expect(request.tool).toBe('describe_product');
  });
});
