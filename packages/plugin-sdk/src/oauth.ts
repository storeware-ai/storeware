import { randomBase64url, sha256Base64url } from './crypto';

/**
 * The install flow for plugin authors.
 *
 * Everything here is something an author would otherwise write by hand, and
 * the two most commonly hand-rolled parts are the two easiest to get subtly
 * wrong: generating a PKCE pair, and remembering that `state` exists to stop
 * an attacker completing an install into somebody else's account.
 *
 * The shape of the flow:
 *
 *   1. createPkcePair() and keep the verifier in your session.
 *   2. Send the merchant to authorizationUrl().
 *   3. Storeware redirects back to your redirect_uri with a code.
 *   4. exchangeCode() on your server, never in the browser.
 *   5. Store the tokens against the store id you get back.
 */

export const DEFAULT_ADMIN_URL = 'https://app.storeware.ai';
export const DEFAULT_API_URL = 'https://api.storeware.ai';

export interface PkcePair {
  /** Keep this server side. It is the proof that you started the flow. */
  verifier: string;
  /** Safe to put in a URL. */
  challenge: string;
}

/**
 * Generates a PKCE pair.
 *
 * 96 bytes of entropy, which lands inside the RFC 7636 length bounds after
 * base64url encoding. Authors who roll their own tend to use something short
 * and memorable, which defeats the point.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomBase64url(64);
  return { verifier, challenge: await sha256Base64url(verifier) };
}

/** An unguessable value to round-trip through the merchant's browser. */
export function createState(): string {
  return randomBase64url(16);
}

export interface AuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  /**
   * Compare this against what comes back on your callback.
   *
   * Skipping the comparison means anyone can hand a merchant a link that
   * completes an install into an account the merchant does not control.
   */
  state: string;
  /** Prefills the store picker when you already know which store you want. */
  storeId?: string;
  /** Override for local development. */
  adminUrl?: string;
}

/** Builds the URL to send a merchant to. */
export function authorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL('/oauth/authorize', options.adminUrl ?? DEFAULT_ADMIN_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scopes.join(' '));
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);
  if (options.storeId) url.searchParams.set('store_id', options.storeId);
  return url.toString();
}

export interface StorewareTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
  storeId: string;
  installationId: string;
  /**
   * Returned only when a merchant installs.
   *
   * Store it now. There is no endpoint that hands it back, because a signing
   * secret you can fetch is a signing secret an attacker can fetch.
   */
  webhookSecret?: string;
  /** Also returned only at install. Verifies admin extension sessions. */
  sessionSecret?: string;
}

export class StorewareOAuthError extends Error {
  constructor(
    readonly error: string,
    description: string,
  ) {
    super(`${error}: ${description}`);
    this.name = 'StorewareOAuthError';
  }
}

interface TokenRequestOptions {
  clientId: string;
  clientSecret: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  store_id: string;
  installation_id: string;
  webhook_secret?: string;
  session_secret?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  options: TokenRequestOptions,
  params: Record<string, string>,
): Promise<StorewareTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL('/api/oauth/token', options.apiUrl ?? DEFAULT_API_URL);

  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...params,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    }).toString(),
  });

  const body = (await response.json()) as RawTokenResponse;

  if (!response.ok || body.error) {
    throw new StorewareOAuthError(
      body.error ?? 'request_failed',
      body.error_description ?? `HTTP ${response.status}`,
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    scopes: body.scope ? body.scope.split(' ') : [],
    storeId: body.store_id,
    installationId: body.installation_id,
    ...(body.webhook_secret ? { webhookSecret: body.webhook_secret } : {}),
    ...(body.session_secret ? { sessionSecret: body.session_secret } : {}),
  };
}

/**
 * Exchanges an authorization code for tokens.
 *
 * Server side only. The client secret must never reach a browser, and neither
 * must the verifier: sending both from the front end would leave PKCE
 * protecting nothing.
 */
export function exchangeCode(
  options: TokenRequestOptions & {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<StorewareTokens> {
  return postToken(options, {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
}

/**
 * Rotates a refresh token.
 *
 * The old pair stops working the moment this succeeds, so persist the new
 * tokens before you use them. Presenting a spent refresh token is treated as a
 * compromise and revokes the whole installation.
 */
export function refreshTokens(
  options: TokenRequestOptions & { refreshToken: string },
): Promise<StorewareTokens> {
  return postToken(options, {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  });
}

/** RFC 8693's grant, and the token type of the session the admin hands your home. */
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const SESSION_TOKEN_TYPE = 'urn:storeware:params:oauth:token-type:session-token';
export const INSTALL_GRANT = 'urn:storeware:grant-type:install';

/**
 * Trades the session token your app's home was opened with for the
 * installation's tokens.
 *
 * The way an app installed from Storeware gets its tokens: there is no
 * authorization code, because there was no redirect. The admin frames your
 * `app.url` with `?session=<token>`; your server sends that token with its
 * client secret, and gets the access and refresh tokens and the webhook and
 * session secrets an install would have returned. Server side only.
 */
export function exchangeSessionToken(
  options: TokenRequestOptions & { sessionToken: string },
): Promise<StorewareTokens> {
  return postToken(options, {
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: options.sessionToken,
    subject_token_type: SESSION_TOKEN_TYPE,
  });
}

/**
 * Trades the install grant from `app.installed.v1` for the installation's
 * tokens. For an app with no home in the admin, which no merchant opens and so
 * is never handed a session. A grant works for an hour.
 */
export function exchangeInstallGrant(
  options: TokenRequestOptions & { grant: string },
): Promise<StorewareTokens> {
  return postToken(options, { grant_type: INSTALL_GRANT, grant: options.grant });
}
