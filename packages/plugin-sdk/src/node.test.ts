import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebhookRouter } from './router';
import { toNodeListener } from './node';
import { signRequest } from './testing';

const SECRET = 'node-secret';
const seen: string[] = [];
const router = createWebhookRouter({ secret: SECRET }).on('order.paid.v1', (event) => {
  seen.push(event.event);
});
const server = createServer(toNodeListener((request) => router.handle(request)));
let base = '';

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe('the SDK on node:http', () => {
  it('hands the handler the raw bytes, so a signature over them verifies', async () => {
    // Spacing a parser would throw away.
    const body = '{ "id": "1",  "event": "order.paid.v1", "storeId": "s", "data": {} }';
    const response = await fetch(`${base}/webhooks`, {
      method: 'POST',
      headers: { 'storeware-signature': await signRequest({ secret: SECRET, body }) },
      body,
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual(['order.paid.v1']);
  });

  it('answers what the handler answers', async () => {
    const response = await fetch(`${base}/webhooks`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('signature did not verify');
  });
});
