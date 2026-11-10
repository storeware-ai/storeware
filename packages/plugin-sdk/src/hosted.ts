import { NotInstalledError, type StorewareApp } from './app';
import { appInstallUrl, sessionTokenOf, storeIdNamedIn, unverifiedClaims } from './app-requests';
import { StorewareClient } from './client';
import { DEFAULT_ADMIN_URL, DEFAULT_API_URL } from './oauth';
import { createWebhookRouter } from './router';
import { SessionVerificationError, verifySession } from './session';
import {
  INSTALLATION_HEADER,
  SIGNATURE_HEADER,
  verifySignedRequest,
  WebhookVerificationError,
  type SignedRequestKind,
} from './webhooks';

/**
 * What an app hosted by Storeware is handed, in its `env`.
 *
 * A hosted app keeps no client secret and no database of its own to start
 * with: `env.STOREWARE` looks up its installations (with their signing
 * secrets and a fresh API token) and keeps small data per installation. Every
 * call is checked against the app it came from, so an app can only ever see
 * its own installations.
 */

/** An installation of this app, as Storeware's runtime hands it over. */
export interface HostedInstallation {
  installationId: string;
  storeId: string;
  status: 'active' | 'uninstalled';
  scopes: string[];
  /** Verifies Storeware's signed requests for this installation. */
  webhookSecret: string;
  /** Verifies admin session tokens for this installation. */
  sessionSecret: string;
  /**
   * A short-lived API token for the shop. Null once uninstalled, and for a
   * moment when the installation has asked for too many this minute.
   */
  accessToken: string | null;
  /** Milliseconds since the epoch. Null with no token. */
  accessTokenExpiresAt: number | null;
}

/** One key this app keeps for one installation. */
export interface AppDataEntry<T = unknown> {
  key: string;
  value: T;
  updatedAt: string;
}

/** The largest value kept under one key, as JSON, in bytes. */
export const APP_DATA_MAX_VALUE_BYTES = 64 * 1024;
/** The most keys one installation may keep. */
export const APP_DATA_MAX_KEYS = 1000;
/** The most bytes one installation may keep, across every key. */
export const APP_DATA_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
/** The longest key. */
export const APP_DATA_MAX_KEY_LENGTH = 200;

/** `env.STOREWARE`: the capability Storeware's runtime hands a hosted app. */
export interface StorewareHost {
  /**
   * An installation of this app, by shop or by id. Null when it is not this
   * app's, or when that shop runs a different release of it: code only ever
   * reaches the shops that run it.
   */
  installation(
    by: { storeId: string } | { installationId: string },
  ): Promise<HostedInstallation | null>;
  dataGet(installationId: string, key: string): Promise<AppDataEntry | null>;
  dataPut(installationId: string, key: string, value: unknown): Promise<AppDataEntry>;
  dataDelete(installationId: string, key: string): Promise<boolean>;
  dataList(
    installationId: string,
    options?: { prefix?: string; cursor?: string; limit?: number },
  ): Promise<{ entries: AppDataEntry[]; cursor: string | null }>;
}

/** The whole `env` of a hosted app. Nothing else is in it. */
export interface HostedEnv {
  STOREWARE: StorewareHost;
  /** `https://api.storeware.ai`, the one host the code may always reach. */
  STOREWARE_API_URL: string;
  /** This app's slug. */
  STOREWARE_APP: string;
  /** Where this app is served, `https://<slug>.storewareapps.com`. */
  STOREWARE_APP_ORIGIN: string;
}

/** Where a hosted app's API calls and install links point, when not Storeware's own. */
export interface HostedAppOptions {
  /** Storeware's API. `env.STOREWARE_API_URL` when not given. */
  apiUrl?: string;
  /** Where install links point. Storeware's admin when not given. */
  adminUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Ask for a new token this long before the one held runs out. */
const TOKEN_AHEAD_MS = 60_000;

/**
 * The same `StorewareApp` as `createStorewareApp`, for an app Storeware hosts.
 *
 * `createStorewareApp` needs a client secret and somewhere to keep each shop's
 * tokens and secrets, because an app on its own server learns them once, at
 * install, and must keep them. A hosted app keeps nothing: Storeware already
 * holds every installation, and `env.STOREWARE` hands over the one a request
 * is for, with its secrets and a fresh token. So an install needs no grant
 * traded, an uninstall needs nothing written, and a token is never refreshed,
 * only asked for again.
 *
 * Moving an app between hosted and your own server is swapping this call for
 * `createStorewareApp` (and back): the handlers you mount are the same.
 */
export function createHostedApp(
  env: HostedEnv,
  options: HostedAppOptions = {},
): StorewareApp<HostedInstallation> {
  const host = env.STOREWARE;
  // A session token's audience is the app's client id, which is its slug.
  const clientId = env.STOREWARE_APP;
  const apiUrl = options.apiUrl ?? env.STOREWARE_API_URL ?? DEFAULT_API_URL;
  const adminUrl = options.adminUrl ?? DEFAULT_ADMIN_URL;

  /** By installation when one is named, which is exact; by shop otherwise. */
  const find = async (by: {
    installationId?: string | null;
    storeId?: string | null;
  }): Promise<HostedInstallation | null> => {
    if (by.installationId) {
      const found = await host.installation({ installationId: by.installationId });
      if (found) return found;
    }
    return by.storeId ? host.installation({ storeId: by.storeId }) : null;
  };

  const live = (installation: HostedInstallation | null) =>
    installation && installation.status === 'active' ? installation : null;

  const clientWith = (first: HostedInstallation): StorewareClient => {
    if (!first.accessToken) throw new NotInstalledError(first.storeId);
    let held = first;
    const base = options.fetchImpl ?? fetch;
    /*
     * The client's own rotation needs a refresh token, which a hosted app is
     * never given. Storeware hands out a live access token instead, so each
     * request goes through a fetch that sets whichever token is live, asking
     * `env.STOREWARE` again only when the one held is about to run out. A
     * client kept across requests therefore never sends a dead token.
     */
    const token = async (): Promise<string> => {
      const until = held.accessTokenExpiresAt ?? 0;
      if (held.accessToken && until - TOKEN_AHEAD_MS > Date.now()) return held.accessToken;
      const again = live(await host.installation({ installationId: held.installationId }));
      if (!again?.accessToken) throw new NotInstalledError(held.storeId);
      held = again;
      return again.accessToken;
    };
    const fetchWithToken = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${await token()}`);
      return base(input, { ...init, headers });
    }) as typeof fetch;
    return new StorewareClient({
      accessToken: first.accessToken,
      apiUrl,
      fetchImpl: fetchWithToken,
    });
  };

  // Every installation's secret still verifies its deliveries, uninstalled
  // ones included: privacy requests arrive after an uninstall. And nothing to
  // do on `app.installed.v1` or `app.uninstalled.v1`: Storeware already knows.
  const webhooks = createWebhookRouter({
    secret: async (address) =>
      (
        await find({
          installationId: address.namedInstallationId ?? address.installationId,
          storeId: address.storeId,
        })
      )?.webhookSecret,
  });

  const clientFor = async (storeId: string) => {
    const installation = live(await host.installation({ storeId }));
    if (!installation) throw new NotInstalledError(storeId);
    return clientWith(installation);
  };

  return {
    webhooks,

    async authenticateAdmin(request) {
      const token = sessionTokenOf(request);
      if (!token) throw new SessionVerificationError('no session token on the request');
      const named = unverifiedClaims(token);
      if (!named.storeId && !named.sid) throw new SessionVerificationError('malformed token');

      const installation = live(await find({ installationId: named.sid, storeId: named.storeId }));
      if (!installation) throw new NotInstalledError(named.storeId ?? 'unknown');

      const claims = await verifySession({
        token,
        secret: installation.sessionSecret,
        clientId,
      });
      // Signed with this installation's secret, so this holds already; said
      // again because the mistake it would catch is one shop's data shown
      // under another's session.
      if (claims.store_id !== installation.storeId) {
        throw new SessionVerificationError('token is for another shop');
      }
      return { claims, installation, client: clientWith(installation) };
    },

    async verifyRequest<T>(request: Request, kind: Exclude<SignedRequestKind, 'webhook'>) {
      const rawBody = await request.text();
      const installation = live(
        await find({
          installationId: request.headers.get(INSTALLATION_HEADER),
          storeId: storeIdNamedIn(rawBody),
        }),
      );
      if (!installation) throw new WebhookVerificationError('no installation for that shop');
      const body = await verifySignedRequest<T>({
        secret: installation.webhookSecret,
        rawBody,
        signatureHeader: request.headers.get(SIGNATURE_HEADER),
        kind,
      });
      return { body, installation };
    },

    clientFor,

    installUrl(choice = {}) {
      return appInstallUrl(clientId, adminUrl, choice);
    },
  };
}

/** Something an app asked of its data that would break a limit, found before asking. */
export class AppDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppDataError';
  }
}

/** One installation's data, typed. */
export interface AppData {
  get<T = unknown>(key: string): Promise<AppDataEntry<T> | null>;
  put<T = unknown>(key: string, value: T): Promise<AppDataEntry<T>>;
  delete(key: string): Promise<boolean>;
  /** A page of keys in order, from `cursor` when given. At most 100 a page. */
  list<T = unknown>(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ entries: AppDataEntry<T>[]; cursor: string | null }>;
}

function checkKey(key: string, what = 'A key'): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AppDataError(`${what} must be a string of at least one character.`);
  }
  if (key.length > APP_DATA_MAX_KEY_LENGTH) {
    throw new AppDataError(`${what} may be at most ${APP_DATA_MAX_KEY_LENGTH} characters.`);
  }
}

/**
 * The small store Storeware keeps for one installation of a hosted app:
 * settings, a cursor, what a shop chose. Kept as JSON, so what reads back is
 * what `JSON.stringify` made of what was written.
 *
 * Limits: a key up to 200 characters, a value up to 64 KB as JSON, 1,000
 * keys and 5 MB in all per installation. Storeware checks every one; the key
 * and the size of a value are checked here first too, so a mistake fails
 * without a trip.
 */
export function appData(env: HostedEnv, installationId: string): AppData {
  const host = env.STOREWARE;
  return {
    async get<T>(key: string) {
      checkKey(key);
      return (await host.dataGet(installationId, key)) as AppDataEntry<T> | null;
    },
    async put<T>(key: string, value: T) {
      checkKey(key);
      const json = JSON.stringify(value);
      if (json === undefined) throw new AppDataError('A value must be something JSON can hold.');
      const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > APP_DATA_MAX_VALUE_BYTES) {
        throw new AppDataError(
          `A value may be at most ${APP_DATA_MAX_VALUE_BYTES / 1024} KB as JSON. This one is ${Math.ceil(bytes / 1024)} KB.`,
        );
      }
      return (await host.dataPut(installationId, key, value)) as AppDataEntry<T>;
    },
    async delete(key: string) {
      checkKey(key);
      return host.dataDelete(installationId, key);
    },
    async list<T>(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
      if (options.prefix) checkKey(options.prefix, 'A prefix');
      return (await host.dataList(installationId, options)) as {
        entries: AppDataEntry<T>[];
        cursor: string | null;
      };
    },
  };
}
