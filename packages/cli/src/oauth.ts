/**
 * Signing the CLI in with a device code (RFC 8628), and keeping it signed in.
 *
 * `storeware login` asks for a code, shows it, opens the admin and polls. A
 * person approves in the browser where they are already signed in, so no key
 * is ever pasted into a terminal. The token lasts an hour and its refresh
 * token rotates, so a copy left in an old shell's history stops working.
 *
 * Written against an injected `fetch` and `sleep`, so the polling rules (wait
 * longer when told to slow down, stop on a refusal or an expiry) are tested
 * without a server or a clock.
 */

export const CLI_CLIENT_ID = 'storeware-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  organizationId: string;
}

export class LoginError extends Error {
  constructor(
    readonly reason: 'denied' | 'expired' | 'refused' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

type Fetch = typeof fetch;

const base = (apiUrl: string) => apiUrl.replace(/\/$/, '');

async function oauthPost(
  fetchImpl: Fetch,
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw new LoginError('unreachable', `Could not reach ${url}: ${(error as Error).message}`);
  }
  const json = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  return { status: response.status, json };
}

export async function startDeviceLogin(
  apiUrl: string,
  clientName: string,
  fetchImpl: Fetch = fetch,
): Promise<DeviceStart> {
  const { status, json } = await oauthPost(fetchImpl, `${base(apiUrl)}/api/oauth/device/code`, {
    client_id: CLI_CLIENT_ID,
    client_name: clientName,
  });
  if (status !== 200 || typeof json.device_code !== 'string') {
    throw new LoginError(
      'refused',
      String(json.error_description ?? `Asking for a sign-in code failed with ${status}`),
    );
  }
  return {
    deviceCode: json.device_code,
    userCode: String(json.user_code),
    verificationUri: String(json.verification_uri),
    verificationUriComplete: String(json.verification_uri_complete ?? json.verification_uri),
    expiresIn: Number(json.expires_in ?? 900),
    interval: Number(json.interval ?? 5),
  };
}

function pairFrom(json: Record<string, unknown>, now: number): TokenPair {
  return {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token),
    expiresAt: now + Number(json.expires_in ?? 3600) * 1000,
    organizationId: String(json.organization_id ?? ''),
  };
}

/**
 * Polls until a person decides. Waits the interval the server asked for, five
 * seconds longer each time it says to slow down, and gives up at expiry.
 */
export async function pollForTokens(
  apiUrl: string,
  start: Pick<DeviceStart, 'deviceCode' | 'interval' | 'expiresIn'>,
  options: {
    fetch?: Fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<TokenPair> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + start.expiresIn * 1000;
  let interval = Math.max(1, start.interval);

  while (now() < deadline) {
    await sleep(interval * 1000);
    const { status, json } = await oauthPost(fetchImpl, `${base(apiUrl)}/api/oauth/token`, {
      grant_type: DEVICE_GRANT,
      device_code: start.deviceCode,
      client_id: CLI_CLIENT_ID,
    });
    if (status === 200 && typeof json.access_token === 'string') return pairFrom(json, now());

    switch (json.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5;
        continue;
      case 'access_denied':
        throw new LoginError('denied', 'Sign-in was turned down in the admin.');
      case 'expired_token':
        throw new LoginError('expired', 'The code expired. Run storeware login again.');
      default:
        throw new LoginError(
          'refused',
          String(json.error_description ?? `Signing in failed with ${status}`),
        );
    }
  }
  throw new LoginError('expired', 'The code expired. Run storeware login again.');
}

/** Trades a refresh token for a new pair. The old refresh token is spent. */
export async function refreshTokens(
  apiUrl: string,
  refreshToken: string,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): Promise<TokenPair> {
  const { status, json } = await oauthPost(fetchImpl, `${base(apiUrl)}/api/oauth/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLI_CLIENT_ID,
  });
  if (status !== 200 || typeof json.access_token !== 'string') {
    throw new LoginError(
      'refused',
      String(json.error_description ?? 'Your sign-in ended. Run storeware login.'),
    );
  }
  return pairFrom(json, now());
}
