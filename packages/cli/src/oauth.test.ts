import { describe, expect, it } from 'vitest';
import { LoginError, pollForTokens, refreshTokens } from './oauth';

/** A token endpoint that answers from a script, recording what it was asked. */
function scripted(answers: { status: number; body: Record<string, unknown> }[]) {
  const asked: URLSearchParams[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    asked.push(new URLSearchParams(String(init?.body)));
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

function clock() {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    waits,
  };
}

const start = { deviceCode: 'dev-code', interval: 5, expiresIn: 900 };

describe('polling for a CLI sign-in', () => {
  it('waits while the person decides, slows down when told, and returns the pair', async () => {
    const { fetchImpl, asked } = scripted([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      {
        status: 200,
        body: {
          access_token: 'swd_a',
          refresh_token: 'swdr_b',
          expires_in: 3600,
          organization_id: 'org-1',
        },
      },
    ]);
    const time = clock();
    const pair = await pollForTokens('https://api.test/', start, { fetch: fetchImpl, ...time });

    expect(pair).toMatchObject({
      accessToken: 'swd_a',
      refreshToken: 'swdr_b',
      organizationId: 'org-1',
    });
    expect(pair.expiresAt).toBe(time.now() + 3600 * 1000);
    // Five seconds, five again, then ten once it was told to slow down.
    expect(time.waits).toEqual([5000, 5000, 10000]);
    expect(asked[0]!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(asked[0]!.get('client_id')).toBe('storeware-cli');
    expect(asked[0]!.get('device_code')).toBe('dev-code');
  });

  it('stops when the person turns it down', async () => {
    const { fetchImpl } = scripted([{ status: 400, body: { error: 'access_denied' } }]);
    await expect(
      pollForTokens('https://api.test', start, { fetch: fetchImpl, ...clock() }),
    ).rejects.toMatchObject({ reason: 'denied' });
  });

  it('stops when the code expires on the server', async () => {
    const { fetchImpl } = scripted([{ status: 400, body: { error: 'expired_token' } }]);
    await expect(
      pollForTokens('https://api.test', start, { fetch: fetchImpl, ...clock() }),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('gives up at expiry on its own clock, however patient the server is', async () => {
    const pending = Array.from({ length: 400 }, () => ({
      status: 400,
      body: { error: 'authorization_pending' },
    }));
    const { fetchImpl, asked } = scripted(pending);
    await expect(
      pollForTokens(
        'https://api.test',
        { ...start, expiresIn: 30 },
        { fetch: fetchImpl, ...clock() },
      ),
    ).rejects.toBeInstanceOf(LoginError);
    expect(asked.length).toBeLessThanOrEqual(6);
  });
});

describe('refreshing a CLI sign-in', () => {
  it('sends the refresh token as the CLI and returns the new pair', async () => {
    const { fetchImpl, asked } = scripted([
      { status: 200, body: { access_token: 'swd_c', refresh_token: 'swdr_d', expires_in: 3600 } },
    ]);
    const pair = await refreshTokens('https://api.test', 'swdr_b', fetchImpl, () => 0);
    expect(pair).toMatchObject({
      accessToken: 'swd_c',
      refreshToken: 'swdr_d',
      expiresAt: 3_600_000,
    });
    expect(asked[0]!.get('grant_type')).toBe('refresh_token');
    expect(asked[0]!.get('client_id')).toBe('storeware-cli');
  });

  it('says to sign in again when the refresh is refused', async () => {
    const { fetchImpl } = scripted([
      {
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: 'That sign-in was ended. Run storeware login.',
        },
      },
    ]);
    await expect(refreshTokens('https://api.test', 'swdr_old', fetchImpl)).rejects.toThrow(
      /storeware login/,
    );
  });
});
