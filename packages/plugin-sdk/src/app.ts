import { appInstallUrl, sessionTokenOf, storeIdNamedIn, unverifiedClaims } from './app-requests';
import { StorewareClient } from './client';
import { installationFrom, type InstallationStore, type StoredInstallation } from './installations';
import {
  DEFAULT_ADMIN_URL,
  DEFAULT_API_URL,
  exchangeInstallGrant,
  exchangeSessionToken,
} from './oauth';
import { createWebhookRouter, type WebhookRouter } from './router';
import { SessionVerificationError, verifySession, type ExtensionSessionClaims } from './session';
import { verifySignedRequest, WebhookVerificationError, type SignedRequestKind } from './webhooks';

/**
 * Everything an app needs from Storeware, wired once.
 *
 * Given its client credentials and somewhere to keep installations, an app
 * gets a webhook endpoint that verifies each shop with its own secret and
 * finishes installs that started in Storeware, a way to authenticate its home
 * in the admin (trading the first session for tokens), verified handlers for
 * tools, knowledge and blocks, and an API client per shop whose tokens rotate
 * into the store by themselves.
 *
 * Every handler takes a fetch `Request` and returns a `Response`, so it drops
 * into Workers, Next route handlers, Hono, Bun and Deno as it is, and into
 * Express or `node:http` through `@storeware/plugin-sdk/node`.
 */

export interface StorewareAppOptions {
  clientId: string;
  clientSecret: string;
  installations: InstallationStore;
  apiUrl?: string;
  adminUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Who is looking at your app's page in the admin. `installation` is the record
 * your store keeps, or for an app Storeware hosts, the `HostedInstallation`
 * the runtime hands over.
 */
export interface AdminContext<Installation = StoredInstallation> {
  claims: ExtensionSessionClaims;
  installation: Installation;
  client: StorewareClient;
}

export class NotInstalledError extends Error {
  constructor(storeId: string) {
    super(`No live installation for store ${storeId}`);
    this.name = 'NotInstalledError';
  }
}

export interface StorewareApp<Installation = StoredInstallation> {
  /** Mount at your manifest's `[webhooks] url` (and `[privacy] url`). */
  webhooks: WebhookRouter;
  /**
   * The person looking at your home or panel in the admin, proved by the
   * session token on the request (`?session=` or `Authorization: Bearer`).
   * The first time a shop opens your home, the session is traded for its
   * tokens and secrets, which is the install.
   */
  authenticateAdmin(request: Request): Promise<AdminContext<Installation>>;
  /**
   * A signed call from Storeware to a tool, knowledge or block endpoint,
   * verified as that kind, with its body parsed. Read the body nowhere else.
   */
  verifyRequest<T = unknown>(
    request: Request,
    kind: Exclude<SignedRequestKind, 'webhook'>,
  ): Promise<{ body: T; installation: Installation }>;
  /** An API client for one shop. Its tokens rotate into the store. */
  clientFor(storeId: string): Promise<StorewareClient>;
  /** Where to send a merchant to install your app from Storeware. */
  installUrl(options?: { storeId?: string }): string;
}

export function createStorewareApp(options: StorewareAppOptions): StorewareApp {
  const store = options.installations;
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
  const adminUrl = options.adminUrl ?? DEFAULT_ADMIN_URL;
  const credentials = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    apiUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  const live = async (storeId: string | null) => {
    if (!storeId) return null;
    const found = await store.get(storeId);
    return found && !found.uninstalledAt ? found : null;
  };

  /** Trades an install grant once, keeping the record it buys. */
  const tradeGrant = async (grant: string) => {
    const tokens = await exchangeInstallGrant({ ...credentials, grant });
    const previous = await store.get(tokens.storeId);
    const installation = { ...installationFrom(tokens, previous), lastGrant: grant };
    await store.save(installation);
    return installation;
  };

  const webhooks = createWebhookRouter({
    // Every secret ever handed over still verifies its shop's deliveries,
    // uninstalled ones included: privacy requests arrive after an uninstall.
    secret: async ({ storeId }) => (storeId ? (await store.get(storeId))?.webhookSecret : null),
    onInstallGrant: async ({ grant }) => (await tradeGrant(grant)).webhookSecret,
    before: async (event) => {
      const data = (event.data ?? {}) as { installGrant?: unknown };
      if (event.event === 'app.installed.v1' && typeof data.installGrant === 'string') {
        // A reinstall arrives for a shop whose old secret still verifies, so
        // the grant was not traded to verify it; the old tokens are dead.
        const held = event.storeId ? await store.get(event.storeId) : null;
        if (held?.lastGrant !== data.installGrant) {
          try {
            await tradeGrant(data.installGrant);
          } catch (error) {
            // A redelivery of an install already finished: its grant is spent
            // and the shop is live, so there is nothing left to do.
            if (!held || held.uninstalledAt) throw error;
          }
        }
      }
      if (event.event === 'app.uninstalled.v1' && event.storeId) {
        const held = await store.get(event.storeId);
        if (held) await store.save({ ...held, uninstalledAt: event.createdAt });
      }
    },
  });

  const clientFor = async (storeId: string) => {
    const installation = await live(storeId);
    if (!installation) throw new NotInstalledError(storeId);
    return new StorewareClient({
      ...credentials,
      accessToken: installation.accessToken,
      accessTokenExpiresAt: installation.accessTokenExpiresAt,
      refreshToken: installation.refreshToken,
      onTokensRefreshed: async (tokens) => {
        const current = (await store.get(storeId)) ?? installation;
        await store.save({ ...current, ...installationFrom(tokens, current) });
      },
    });
  };

  return {
    webhooks,

    async authenticateAdmin(request) {
      const token = sessionTokenOf(request);
      if (!token) throw new SessionVerificationError('no session token on the request');
      const { storeId } = unverifiedClaims(token);
      if (!storeId) throw new SessionVerificationError('malformed token');

      let installation = await live(storeId);
      if (!installation) {
        // Storeware checks the session before it trades it, so tokens coming
        // back is the proof; the local check below then holds for every
        // request after this one.
        const tokens = await exchangeSessionToken({ ...credentials, sessionToken: token });
        installation = installationFrom(tokens, await store.get(tokens.storeId));
        await store.save(installation);
      }

      const claims = await verifySession({
        token,
        secret: installation.sessionSecret,
        clientId: options.clientId,
      });
      return { claims, installation, client: await clientFor(claims.store_id) };
    },

    async verifyRequest<T>(request: Request, kind: Exclude<SignedRequestKind, 'webhook'>) {
      const rawBody = await request.text();
      const installation = await live(storeIdNamedIn(rawBody));
      if (!installation) throw new WebhookVerificationError('no installation for that shop');
      const body = await verifySignedRequest<T>({
        secret: installation.webhookSecret,
        rawBody,
        signatureHeader: request.headers.get('storeware-signature'),
        kind,
      });
      return { body, installation };
    },

    clientFor,

    installUrl(choice = {}) {
      return appInstallUrl(options.clientId, adminUrl, choice);
    },
  };
}
