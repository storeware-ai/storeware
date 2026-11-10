import type { StorewareTokens } from './oauth';

/**
 * Where an app keeps what each shop gave it.
 *
 * One record per shop: the tokens, which rotate, and the two secrets, which
 * are handed over once and never again. Lose the secrets and the app cannot
 * verify that shop's webhooks or sessions until it is installed again, so
 * whatever backs this must be durable. Encrypt it at rest if anything else can
 * read it.
 */

export interface StoredInstallation {
  storeId: string;
  installationId: string;
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  accessTokenExpiresAt: number;
  scopes: string[];
  webhookSecret: string;
  sessionSecret: string;
  installedAt: string;
  /** Set when `app.uninstalled.v1` arrives. The secrets stay for later privacy requests. */
  uninstalledAt?: string;
  /** The install grant last traded, so a redelivered `app.installed.v1` is not traded twice. */
  lastGrant?: string;
}

export interface InstallationStore {
  get(storeId: string): Promise<StoredInstallation | null>;
  save(installation: StoredInstallation): Promise<void>;
  delete(storeId: string): Promise<void>;
}

/** A store's record from a fresh token response, keeping secrets it already held. */
export function installationFrom(
  tokens: StorewareTokens,
  previous: StoredInstallation | null,
  now = Date.now(),
): StoredInstallation {
  const webhookSecret = tokens.webhookSecret ?? previous?.webhookSecret;
  const sessionSecret = tokens.sessionSecret ?? previous?.sessionSecret;
  if (!webhookSecret || !sessionSecret) {
    throw new Error('A token response for a new installation carried no secrets');
  }
  return {
    storeId: tokens.storeId,
    installationId: tokens.installationId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: now + tokens.expiresIn * 1000,
    scopes: tokens.scopes,
    webhookSecret,
    sessionSecret,
    installedAt:
      previous && !previous.uninstalledAt ? previous.installedAt : new Date(now).toISOString(),
  };
}

/** In memory, for tests and for trying things out. Gone when the process ends. */
export function memoryInstallationStore(): InstallationStore & { all(): StoredInstallation[] } {
  const rows = new Map<string, StoredInstallation>();
  return {
    async get(storeId) {
      return rows.get(storeId) ?? null;
    },
    async save(installation) {
      rows.set(installation.storeId, { ...installation });
    },
    async delete(storeId) {
      rows.delete(storeId);
    },
    all() {
      return [...rows.values()];
    },
  };
}

/** The part of a key-value store this needs. Cloudflare KV fits as it is. */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One key per shop in a key-value store, such as Cloudflare KV. */
export function kvInstallationStore(
  kv: KeyValue,
  prefix = 'storeware:installation:',
): InstallationStore {
  return {
    async get(storeId) {
      const raw = await kv.get(`${prefix}${storeId}`);
      return raw ? (JSON.parse(raw) as StoredInstallation) : null;
    },
    async save(installation) {
      await kv.put(`${prefix}${installation.storeId}`, JSON.stringify(installation));
    },
    async delete(storeId) {
      await kv.delete(`${prefix}${storeId}`);
    },
  };
}
