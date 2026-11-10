import { base64urlToText, hmacSha256Base64url, timingSafeEqual } from './crypto';

/**
 * Verifying an admin extension session, for plugin authors.
 *
 * Your extension renders in an iframe on your own origin, so your server sees
 * a request from a browser you have no reason to trust. Anyone can open that
 * URL. The session token in the query string is what makes it meaningful, and
 * verifying it is not optional: without this check your extension will happily
 * render a merchant's data to whoever guesses the URL.
 *
 * The secret is the `session_secret` handed to you once, when the merchant
 * installed your app.
 */

export class SessionVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`Session verification failed: ${reason}`);
    this.name = 'SessionVerificationError';
  }
}

/**
 * What the admin page around your extension had in context.
 *
 * Record ids as strings, such as `productId` beside a product. On a list's
 * action, `selection` holds the ids of the rows the merchant ticked, at most
 * 100. It is inside the signed token rather than in your page's address, so
 * nobody can hand your app a selection the merchant did not make.
 */
export interface SessionContext {
  selection?: string[];
  [key: string]: string | string[] | undefined;
}

export interface ExtensionSessionClaims {
  /** Always https://storeware.ai. */
  iss: string;
  /** Your client id. */
  aud: string;
  /** The staff account viewing your extension. */
  sub: string;
  exp: number;
  iat: number;
  jti: string;
  /** The installation, so you know which merchant's access token to use. */
  sid: string;
  store_id: string;
  org_id: string;
  /** What the surrounding page had in context, for example `{ productId }`. */
  context: SessionContext;
}

export interface VerifySessionOptions {
  token: string;
  /** The session_secret from your install response. */
  secret: string;
  /** Your client id. A token minted for another app must not verify here. */
  clientId: string;
  /** Injectable for tests. */
  nowSeconds?: number;
}

/**
 * Verifies a session token and returns its claims.
 *
 * Throws rather than returning null, so an author who forgets to check the
 * result gets a failure instead of an unauthenticated render.
 */
export async function verifySession(
  options: VerifySessionOptions,
): Promise<ExtensionSessionClaims> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  const parts = options.token.split('.');
  if (parts.length !== 3) throw new SessionVerificationError('malformed token');
  const [header, body, signature] = parts as [string, string, string];

  let decodedHeader: unknown;
  try {
    decodedHeader = JSON.parse(base64urlToText(header));
  } catch {
    throw new SessionVerificationError('malformed header');
  }

  // Read from our own expectation, never from the token. Trusting the token's
  // own `alg` is how "alg: none" forgeries get accepted.
  if (
    typeof decodedHeader !== 'object' ||
    decodedHeader === null ||
    (decodedHeader as { alg?: unknown }).alg !== 'HS256'
  ) {
    throw new SessionVerificationError('unsupported signature algorithm');
  }

  const expected = await hmacSha256Base64url(options.secret, `${header}.${body}`);
  if (!timingSafeEqual(expected, signature)) {
    throw new SessionVerificationError('signature mismatch');
  }

  let claims: ExtensionSessionClaims;
  try {
    claims = JSON.parse(base64urlToText(body)) as ExtensionSessionClaims;
  } catch {
    throw new SessionVerificationError('malformed claims');
  }

  // Checked even though the signature already passed. A token minted for a
  // different app is correctly signed with a different secret, so this only
  // fires on a real mistake, but the mistake it catches is serving one
  // merchant's data under another app's session.
  if (claims.aud !== options.clientId)
    throw new SessionVerificationError('token is for another app');
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new SessionVerificationError('token has expired');
  }
  if (typeof claims.iat === 'number' && claims.iat > now + 60) {
    throw new SessionVerificationError('token was issued in the future');
  }

  return claims;
}
