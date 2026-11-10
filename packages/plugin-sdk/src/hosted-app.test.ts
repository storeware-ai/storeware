import { describe, expect, it } from 'vitest';
import { NotInstalledError } from './app';
import {
  appData,
  AppDataError,
  createHostedApp,
  type AppDataEntry,
  type HostedEnv,
  type HostedInstallation,
  type StorewareHost,
} from './hosted';
import { SessionVerificationError } from './session';
import { mintSession, signedDelivery, signRequest } from './testing';
import { WebhookVerificationError } from './webhooks';

/**
 * An app Storeware hosts, built on `env.STOREWARE` instead of a client secret
 * and a store of its own, against a fake of what the runtime hands it.
 */

const SLUG = 'sizing';
const HOUR = 3600_000;

function installation(overrides: Partial<HostedInstallation> = {}): HostedInstallation {
  return {
    installationId: 'inst-1',
    storeId: 'store-1',
    status: 'active',
    scopes: ['products:read'],
    webhookSecret: 'webhook-secret-1',
    sessionSecret: 'session-secret-1',
    accessToken: 'swt_access_1',
    accessTokenExpiresAt: Date.now() + HOUR,
    ...overrides,
  };
}

/** What the runtime would answer, with every question it was asked. */
function fakeHost(rows: HostedInstallation[]) {
  const asked: string[] = [];
  const data = new Map<string, AppDataEntry>();
  const host: StorewareHost = {
    async installation(by) {
      if ('installationId' in by) {
        asked.push(`installation:${by.installationId}`);
        return rows.find((row) => row.installationId === by.installationId) ?? null;
      }
      asked.push(`store:${by.storeId}`);
      // The newest for a shop, as the platform would answer after a reinstall.
      return rows.filter((row) => row.storeId === by.storeId).at(-1) ?? null;
    },
    async dataGet(installationId, key) {
      asked.push(`get:${installationId}:${key}`);
      return data.get(`${installationId}:${key}`) ?? null;
    },
    async dataPut(installationId, key, value) {
      asked.push(`put:${installationId}:${key}`);
      const entry = { key, value, updatedAt: '2026-11-09T12:00:00.000Z' };
      data.set(`${installationId}:${key}`, entry);
      return entry;
    },
    async dataDelete(installationId, key) {
      asked.push(`delete:${installationId}:${key}`);
      return data.delete(`${installationId}:${key}`);
    },
    async dataList(installationId, options) {
      asked.push(`list:${installationId}:${options?.prefix ?? ''}`);
      const entries = [...data.entries()]
        .filter(([id]) => id.startsWith(`${installationId}:${options?.prefix ?? ''}`))
        .map(([, entry]) => entry);
      return { entries, cursor: null };
    },
  };
  return { host, asked };
}

function envWith(host: StorewareHost): HostedEnv {
  return {
    STOREWARE: host,
    STOREWARE_API_URL: 'https://api.test',
    STOREWARE_APP: SLUG,
    STOREWARE_APP_ORIGIN: `https://${SLUG}.storewareapps.com`,
  };
}

/** An API that records the token each call came with. */
function api() {
  const tokens: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json({ data: { ok: true } });
  }) as typeof fetch;
  return { fetchImpl, tokens };
}

async function delivery(options: {
  secret: string;
  event: string;
  storeId?: string;
  installationHeader?: string;
  data?: unknown;
}): Promise<Request> {
  const signed = await signedDelivery({
    secret: options.secret,
    event: options.event,
    storeId: options.storeId ?? 'store-1',
    data: options.data ?? {},
  });
  if (!options.installationHeader) return signed;
  const headers = new Headers(signed.headers);
  headers.set('storeware-installation', options.installationHeader);
  return new Request(signed, { headers });
}

describe('webhooks for a hosted app', () => {
  it('verify with the secret of the installation the header names', async () => {
    const { host, asked } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    const seen: string[] = [];
    app.webhooks.on('product.created.v1', (event) => {
      seen.push(event.id);
    });

    const response = await app.webhooks.handle(
      await delivery({
        secret: 'webhook-secret-1',
        event: 'product.created.v1',
        installationHeader: 'inst-1',
      }),
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(asked).toEqual(['installation:inst-1']);
  });

  it('fall back to the shop when no installation is named', async () => {
    const { host, asked } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    const response = await app.webhooks.handle(
      await delivery({ secret: 'webhook-secret-1', event: 'order.paid.v1' }),
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual(['store:store-1']);
  });

  it('finish an install with no grant traded and nothing written', async () => {
    const { host, asked } = fakeHost([installation()]);
    const { fetchImpl, tokens } = api();
    const app = createHostedApp(envWith(host), { fetchImpl });
    const lifecycle: string[] = [];
    app.webhooks.onLifecycle((event) => {
      lifecycle.push(event.event);
    });

    const response = await app.webhooks.handle(
      await delivery({
        secret: 'webhook-secret-1',
        event: 'app.installed.v1',
        data: { installationId: 'inst-1', installGrant: 'grant-1' },
      }),
    );
    expect(response.status).toBe(200);
    expect(lifecycle).toEqual(['app.installed.v1']);
    expect(tokens).toEqual([]);
    expect(asked).toEqual(['installation:inst-1']);
  });

  it('still verify a privacy request after an uninstall', async () => {
    const gone = installation({
      status: 'uninstalled',
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    const { host } = fakeHost([gone]);
    const app = createHostedApp(envWith(host));
    const compliance: string[] = [];
    app.webhooks.onCompliance((event) => {
      compliance.push(event.event);
    });
    const response = await app.webhooks.handle(
      await delivery({
        secret: 'webhook-secret-1',
        event: 'compliance.shop_redact.v1',
        installationHeader: 'inst-1',
      }),
    );
    expect(response.status).toBe(200);
    expect(compliance).toEqual(['compliance.shop_redact.v1']);
  });

  it('refuse a forgery, and a shop the app is not installed on', async () => {
    const { host } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    const forged = await delivery({
      secret: 'not-the-secret',
      event: 'order.paid.v1',
      installationHeader: 'inst-1',
    });
    expect((await app.webhooks.handle(forged)).status).toBe(401);
    const elsewhere = await delivery({
      secret: 'webhook-secret-1',
      event: 'order.paid.v1',
      storeId: 'store-2',
    });
    expect((await app.webhooks.handle(elsewhere)).status).toBe(401);
  });
});

describe('the admin home of a hosted app', () => {
  const session = (claims: Record<string, unknown> = {}, secret = 'session-secret-1') =>
    mintSession({
      secret,
      clientId: SLUG,
      claims: { sid: 'inst-1', store_id: 'store-1', ...claims },
    });

  it('verifies the session with its installation’s secret, and hands a client for the shop', async () => {
    const { host, asked } = fakeHost([installation()]);
    const { fetchImpl, tokens } = api();
    const app = createHostedApp(envWith(host), { fetchImpl });
    const request = new Request(`https://sizing.storewareapps.com/?session=${await session()}`);

    const context = await app.authenticateAdmin(request);
    expect(context.claims.store_id).toBe('store-1');
    expect(context.installation.installationId).toBe('inst-1');
    expect(asked).toEqual(['installation:inst-1']);

    await context.client.settings();
    expect(tokens).toEqual(['Bearer swt_access_1']);
  });

  it('takes the session as a bearer token too', async () => {
    const { host } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    const request = new Request('https://sizing.storewareapps.com/api/x', {
      headers: { authorization: `Bearer ${await session()}` },
    });
    expect((await app.authenticateAdmin(request)).claims.sid).toBe('inst-1');
  });

  it('refuses a session signed with another secret, or for another app', async () => {
    const { host } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    const forged = new Request(
      `https://sizing.storewareapps.com/?session=${await session({}, 'guessed')}`,
    );
    await expect(app.authenticateAdmin(forged)).rejects.toThrow(SessionVerificationError);

    const other = await mintSession({
      secret: 'session-secret-1',
      clientId: 'reviews',
      claims: { sid: 'inst-1', store_id: 'store-1' },
    });
    await expect(
      app.authenticateAdmin(new Request(`https://sizing.storewareapps.com/?session=${other}`)),
    ).rejects.toThrow('token is for another app');
  });

  it('refuses a session that names one shop and is signed for another', async () => {
    const { host } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    const request = new Request(
      `https://sizing.storewareapps.com/?session=${await session({ store_id: 'store-2' })}`,
    );
    await expect(app.authenticateAdmin(request)).rejects.toThrow('token is for another shop');
  });

  it('refuses a shop it is not installed on, and one that uninstalled it', async () => {
    const { host } = fakeHost([
      installation({ status: 'uninstalled', accessToken: null, accessTokenExpiresAt: null }),
    ]);
    const app = createHostedApp(envWith(host));
    const request = new Request(`https://sizing.storewareapps.com/?session=${await session()}`);
    await expect(app.authenticateAdmin(request)).rejects.toThrow(NotInstalledError);
    await expect(
      app.authenticateAdmin(new Request('https://sizing.storewareapps.com/')),
    ).rejects.toThrow('no session token on the request');
  });
});

describe('signed calls to a hosted app', () => {
  const call = async (options: {
    secret: string;
    kind?: 'block' | 'tool';
    header?: string;
    body?: unknown;
  }) => {
    const body = JSON.stringify(options.body ?? { storeId: 'store-1', input: { q: 'x' } });
    return new Request('https://sizing.storewareapps.com/blocks/fit', {
      method: 'POST',
      headers: {
        'storeware-signature': await signRequest({
          secret: options.secret,
          body,
          kind: options.kind ?? 'block',
        }),
        ...(options.header ? { 'storeware-installation': options.header } : {}),
      },
      body,
    });
  };

  it('verify as their kind, preferring the installation header', async () => {
    const { host, asked } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    const { body, installation: found } = await app.verifyRequest<{ input: { q: string } }>(
      await call({ secret: 'webhook-secret-1', header: 'inst-1' }),
      'block',
    );
    expect(body.input.q).toBe('x');
    expect(found.installationId).toBe('inst-1');
    expect(asked).toEqual(['installation:inst-1']);
  });

  it('find the shop in the body when no installation is named', async () => {
    const { host, asked } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    await app.verifyRequest(await call({ secret: 'webhook-secret-1' }), 'block');
    expect(asked).toEqual(['store:store-1']);
  });

  it('refuse a call signed as another kind, or for a shop without the app', async () => {
    const { host } = fakeHost([installation()]);
    const app = createHostedApp(envWith(host));
    await expect(
      app.verifyRequest(await call({ secret: 'webhook-secret-1', kind: 'tool' }), 'block'),
    ).rejects.toThrow(WebhookVerificationError);
    await expect(
      app.verifyRequest(
        await call({ secret: 'webhook-secret-1', body: { storeId: 'store-2' } }),
        'block',
      ),
    ).rejects.toThrow('no installation for that shop');
  });
});

describe('an API client for a hosted app', () => {
  it('uses the installation’s token, never a refresh token', async () => {
    const { host } = fakeHost([installation()]);
    const { fetchImpl, tokens } = api();
    const app = createHostedApp(envWith(host), { fetchImpl });
    const client = await app.clientFor('store-1');
    await client.settings();
    await client.settings();
    expect(tokens).toEqual(['Bearer swt_access_1', 'Bearer swt_access_1']);
  });

  it('asks Storeware again for a token that is about to run out', async () => {
    const rows = [installation({ accessTokenExpiresAt: Date.now() + 30_000 })];
    const { host, asked } = fakeHost(rows);
    const { fetchImpl, tokens } = api();
    const app = createHostedApp(envWith(host), { fetchImpl });
    const client = await app.clientFor('store-1');

    rows[0] = installation({ accessToken: 'swt_access_2' });
    await client.settings();
    await client.settings();
    expect(tokens).toEqual(['Bearer swt_access_2', 'Bearer swt_access_2']);
    expect(asked).toEqual(['store:store-1', 'installation:inst-1']);
  });

  it('refuses a shop the app is not live on', async () => {
    const { host } = fakeHost([
      installation({ status: 'uninstalled', accessToken: null, accessTokenExpiresAt: null }),
    ]);
    const app = createHostedApp(envWith(host));
    await expect(app.clientFor('store-1')).rejects.toThrow(NotInstalledError);
    await expect(app.clientFor('store-9')).rejects.toThrow(NotInstalledError);
  });

  it('stops when the installation is gone by the time a new token is needed', async () => {
    const rows = [installation({ accessTokenExpiresAt: Date.now() + 30_000 })];
    const { host } = fakeHost(rows);
    const { fetchImpl } = api();
    const client = await createHostedApp(envWith(host), { fetchImpl }).clientFor('store-1');
    rows[0] = installation({
      status: 'uninstalled',
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    await expect(client.settings()).rejects.toThrow(NotInstalledError);
  });

  it('calls the API the runtime names', async () => {
    const { host } = fakeHost([installation()]);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return Response.json({ data: {} });
    }) as typeof fetch;
    await (await createHostedApp(envWith(host), { fetchImpl }).clientFor('store-1')).settings();
    expect(urls).toEqual(['https://api.test/api/v1/app/settings']);
  });
});

describe('install links for a hosted app', () => {
  it('name the app by its slug, as for any app', () => {
    const { host } = fakeHost([]);
    expect(createHostedApp(envWith(host)).installUrl({ storeId: 'store-1' })).toBe(
      'https://app.storeware.ai/install/sizing?store=store-1&ref=developer_link',
    );
  });
});

describe('an installation’s data', () => {
  it('reads back what it wrote, typed', async () => {
    const { host, asked } = fakeHost([installation()]);
    const data = appData(envWith(host), 'inst-1');
    await data.put('settings', { size: 'M' });
    const entry = await data.get<{ size: string }>('settings');
    expect(entry?.value.size).toBe('M');
    expect((await data.list({ prefix: 'set' })).entries).toHaveLength(1);
    expect(await data.delete('settings')).toBe(true);
    expect(await data.get('settings')).toBeNull();
    expect(asked).toEqual([
      'put:inst-1:settings',
      'get:inst-1:settings',
      'list:inst-1:set',
      'delete:inst-1:settings',
      'get:inst-1:settings',
    ]);
  });

  it('refuses a key or a value past the limits without asking', async () => {
    const { host, asked } = fakeHost([installation()]);
    const data = appData(envWith(host), 'inst-1');
    await expect(data.put('', 1)).rejects.toThrow(AppDataError);
    await expect(data.get('k'.repeat(201))).rejects.toThrow('at most 200 characters');
    await expect(data.put('big', 'x'.repeat(70 * 1024))).rejects.toThrow('at most 64 KB');
    await expect(data.put('nothing', undefined)).rejects.toThrow('something JSON can hold');
    expect(asked).toEqual([]);
  });
});
