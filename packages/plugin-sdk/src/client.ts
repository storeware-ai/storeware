import { DEFAULT_API_URL, refreshTokens, type StorewareTokens } from './oauth';

/**
 * A thin client for the Storeware public API.
 *
 * Thin on purpose. This is the same `/api/v1` surface the first-party admin
 * calls, so there is no plugin-specific API to wrap and nothing here that a
 * merchant's own dashboard does not also go through.
 *
 * The one piece of real machinery is token rotation. Refreshing revokes the
 * old pair, so an author who refreshes without persisting the result locks
 * their own integration out. The options type makes that impossible to forget:
 * you cannot supply a refresh token without also supplying somewhere to put
 * the new one.
 */

export class StorewareApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    /** Present on 403. The scopes this call needed. */
    readonly requiredScopes?: string[],
  ) {
    super(message);
    this.name = 'StorewareApiError';
  }
}

interface BaseOptions {
  accessToken: string;
  /**
   * When the access token expires, in milliseconds since the epoch.
   *
   * Optional. With it, a client holding a refresh token rotates a minute
   * before expiry instead of spending a request on a 401 first.
   */
  accessTokenExpiresAt?: number;
  /** Override for local development. */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export type StorewareClientOptions =
  | (BaseOptions & {
      refreshToken?: undefined;
    })
  | (BaseOptions & {
      refreshToken: string;
      clientId: string;
      clientSecret: string;
      /**
       * Called whenever tokens rotate. Persist them here.
       *
       * Required alongside a refresh token because the previous pair is dead
       * by the time this fires. Dropping the new one on the floor means the
       * next process start has nothing that works.
       */
      onTokensRefreshed: (tokens: StorewareTokens) => void | Promise<void>;
    });

interface ApiErrorBody {
  error?: { type?: string; message?: string; requiredScopes?: string[] };
}

/** Rotate this long before the access token runs out. */
const REFRESH_AHEAD_MS = 60_000;

/** Prices in every currency Storeware quotes, in minor units. Nothing is converted. */
export interface QuotedPrices {
  usd: number;
  gbp: number;
  eur: number;
  inr: number;
}

export interface AppSubscription {
  id: string;
  plan: string;
  name: string;
  status:
    | 'pending'
    | 'active'
    | 'past_due'
    | 'frozen'
    | 'scheduled'
    | 'canceled'
    | 'declined'
    | 'expired';
  amountMinor: number;
  currency: 'usd' | 'gbp' | 'eur' | 'inr';
  interval: 'month' | 'year';
  test: boolean;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  /** Where to send the merchant while it waits for their answer. */
  confirmationUrl: string | null;
  /** The most a period's usage may come to, for a plan that charges by use. */
  usageCapMinor: number | null;
  usageTerms: string | null;
}

/** A period's usage on the plan in force. */
export interface AppUsage {
  capMinor: number;
  usedMinor: number;
  terms: string | null;
}

export interface AppPurchase {
  id: string;
  name: string;
  amountMinor: number;
  currency: 'usd' | 'gbp' | 'eur' | 'inr';
  test: boolean;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  createdAt: string;
  confirmationUrl: string | null;
}

export interface AppBillingState {
  currency: 'usd' | 'gbp' | 'eur' | 'inr';
  subscription: AppSubscription | null;
  usage: AppUsage | null;
  scheduled: AppSubscription | null;
  pending: { subscriptions: AppSubscription[]; purchases: AppPurchase[] };
  purchases: AppPurchase[];
  plans: {
    key: string;
    name: string;
    interval: 'month' | 'year';
    amountMinor: number;
    trialDays: number;
  }[];
}

export interface AppBilling {
  state(): Promise<AppBillingState>;
  requestSubscription(input: {
    plan: string;
    returnUrl: string;
    test?: boolean;
    idempotencyKey?: string;
  }): Promise<AppSubscription>;
  requestPurchase(input: {
    name: string;
    prices: QuotedPrices;
    returnUrl: string;
    test?: boolean;
    idempotencyKey?: string;
  }): Promise<AppPurchase>;
  cancelSubscription(id: string): Promise<AppSubscription>;
  /** What the shop used, in the plan's currency. Refused (402) past the period's cap. */
  recordUsage(input: {
    amountMinor: number;
    description: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; amountMinor: number; usage: AppUsage }>;
  /** A credit on the shop's next statement, in its billing currency. */
  credit(input: {
    amountMinor: number;
    description: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; amountMinor: number; currency: string }>;
}

/** What `client.settings()` answers with. */
export interface AppSettingsState {
  /**
   * Every field your installed release declares in `[[settings]]`, by key:
   * what the merchant saved, else its default, else null. Secrets in the clear.
   */
  values: Record<string, string | number | boolean | null>;
  /** ISO, or null when the merchant has never saved. */
  updatedAt: string | null;
}

/** The pictures `client.uploadAsset()` takes. Checked by their bytes, so say what they are. */
export type AppAssetContentType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif';

export interface UploadedAppAsset {
  /** On `cdn.mystoreware.com`, the one host an image in your components may come from. */
  url: string;
  contentType: AppAssetContentType;
  sizeBytes: number;
  sha256: string;
}

/** Bytes to base64, without assuming a Node Buffer exists. */
function toBase64(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export class StorewareClient {
  private accessToken: string;
  private expiresAt: number | undefined;
  /**
   * The refresh token that is live right now.
   *
   * Rotation spends the old one, so this has to move with every refresh. A
   * client that kept presenting the token it was constructed with would
   * replay a spent token on its second refresh, which the server treats as
   * theft and answers by revoking the whole installation.
   */
  private refreshToken: string | undefined;
  /** One refresh at a time. Concurrent 401s all wait on the same rotation. */
  private refreshing: Promise<void> | null = null;
  private readonly options: StorewareClientOptions;

  constructor(options: StorewareClientOptions) {
    this.options = options;
    this.accessToken = options.accessToken;
    this.expiresAt = options.accessTokenExpiresAt;
    this.refreshToken = options.refreshToken;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  /** A body is rare on a delete, and `cancelOrder` is the one call that takes one. */
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body);
  }

  /**
   * What this shop pays your app. Ask for a plan or a one-time charge, then
   * send the merchant to its `confirmationUrl`; nothing is owed until they
   * approve. See https://storeware.ai/docs/selling/billing.
   */
  get billing(): AppBilling {
    return {
      state: async () => (await this.get<{ data: AppBillingState }>('/api/v1/app-billing')).data,
      requestSubscription: async (input) =>
        (await this.post<{ data: AppSubscription }>('/api/v1/app-billing/subscriptions', input))
          .data,
      requestPurchase: async (input) =>
        (await this.post<{ data: AppPurchase }>('/api/v1/app-billing/purchases', input)).data,
      recordUsage: async (input) =>
        (
          await this.post<{ data: { id: string; amountMinor: number; usage: AppUsage } }>(
            '/api/v1/app-billing/usage',
            input,
          )
        ).data,
      credit: async (input) =>
        (
          await this.post<{ data: { id: string; amountMinor: number; currency: string } }>(
            '/api/v1/app-billing/credits',
            input,
          )
        ).data,
      cancelSubscription: async (id) =>
        (
          await this.post<{ data: AppSubscription }>(
            `/api/v1/app-billing/subscriptions/${encodeURIComponent(id)}/cancel`,
          )
        ).data,
    };
  }

  /**
   * What the merchant set for your app on this shop, as your installed
   * release's `[[settings]]` declares it. You hear of a change as
   * `app.settings_updated.v1`. See https://storeware.ai/docs/extensions/settings.
   */
  async settings(): Promise<AppSettingsState> {
    return (await this.get<{ data: AppSettingsState }>('/api/v1/app/settings')).data;
  }

  /**
   * Puts a picture on Storeware for your components, and gives its address.
   * PNG, JPEG, WebP, GIF or AVIF, at most 5 MB. `data` is the bytes, or a
   * base64 string of them. Needs no permission.
   */
  async uploadAsset(input: {
    data: Uint8Array | ArrayBuffer | string;
    contentType: AppAssetContentType;
  }): Promise<UploadedAppAsset> {
    const data = typeof input.data === 'string' ? input.data : toBase64(input.data);
    return (
      await this.post<{ data: UploadedAppAsset }>('/api/v1/app/assets', {
        data,
        contentType: input.contentType,
      })
    ).data;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.canRefresh() && this.expiresAt !== undefined) {
      if (Date.now() >= this.expiresAt - REFRESH_AHEAD_MS) await this.refresh();
    }

    const sentWith = this.accessToken;
    let response = await this.send(method, path, body);

    // Retried exactly once. A refresh that produces another 401 means the
    // installation is gone rather than the token being stale, and looping
    // would turn an uninstall into a request storm.
    if (response.status === 401 && this.canRefresh()) {
      // Another request may already have rotated while this one was in
      // flight. Its token is good, and rotating again would only burn it.
      if (this.accessToken === sentWith) await this.refresh();
      response = await this.send(method, path, body);
    }

    if (!response.ok) {
      const parsed = (await response.json().catch(() => ({}))) as ApiErrorBody;
      throw new StorewareApiError(
        response.status,
        parsed.error?.type ?? 'unknown_error',
        parsed.error?.message ?? `HTTP ${response.status}`,
        parsed.error?.requiredScopes,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private canRefresh(): boolean {
    return this.refreshToken !== undefined;
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.rotate().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async rotate(): Promise<void> {
    const options = this.options;
    if (options.refreshToken === undefined || this.refreshToken === undefined) return;

    const tokens = await refreshTokens({
      refreshToken: this.refreshToken,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.expiresAt = Date.now() + tokens.expiresIn * 1000;
    await options.onTokensRefreshed(tokens);
  }

  private send(method: string, path: string, body?: unknown): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = new URL(path, this.options.apiUrl ?? DEFAULT_API_URL);

    return fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
}
