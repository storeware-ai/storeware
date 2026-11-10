import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionVerificationError, verifySession } from './session';

const SECRET = 'sess_secret_for_this_installation';
const CLIENT_ID = 'hello-storeware';
const NOW = 1_785_160_000;

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function mint(
  claims: Record<string, unknown> = {},
  options: { secret?: string; alg?: string } = {},
): string {
  const header = base64url(JSON.stringify({ alg: options.alg ?? 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({
      iss: 'https://storeware.ai',
      aud: CLIENT_ID,
      sub: 'staff-1',
      iat: NOW,
      exp: NOW + 300,
      jti: 'jti-1',
      sid: 'installation-1',
      store_id: 'store-1',
      org_id: 'org-1',
      context: { productId: 'prod-1' },
      ...claims,
    }),
  );
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('verifying a session', () => {
  it('returns the claims for a token we just minted', async () => {
    const claims = await verifySession({
      token: mint(),
      secret: SECRET,
      clientId: CLIENT_ID,
      nowSeconds: NOW,
    });

    expect(claims.sub).toBe('staff-1');
    expect(claims.sid).toBe('installation-1');
    expect(claims.context.productId).toBe('prod-1');
  });

  it('rejects a signature made with another secret', async () => {
    await expect(
      verifySession({
        token: mint({}, { secret: 'someone-elses-secret' }),
        secret: SECRET,
        clientId: CLIENT_ID,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(/signature mismatch/);
  });

  it('rejects a token whose body was edited after signing', async () => {
    const token = mint();
    const [header, , signature] = token.split('.') as [string, string, string];
    const tampered = base64url(
      JSON.stringify({ aud: CLIENT_ID, sub: 'someone-else', exp: NOW + 300 }),
    );

    await expect(
      verifySession({
        token: `${header}.${tampered}.${signature}`,
        secret: SECRET,
        clientId: CLIENT_ID,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(SessionVerificationError);
  });

  it('rejects alg: none', async () => {
    // The classic forgery. Reading the algorithm from the token instead of
    // from our own expectation is what makes it work.
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = base64url(JSON.stringify({ aud: CLIENT_ID, sub: 'attacker', exp: NOW + 300 }));

    await expect(
      verifySession({
        token: `${header}.${body}.`,
        secret: SECRET,
        clientId: CLIENT_ID,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(/unsupported signature algorithm/);
  });

  it('rejects an expired token', async () => {
    await expect(
      verifySession({
        token: mint({ exp: NOW - 1 }),
        secret: SECRET,
        clientId: CLIENT_ID,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(/expired/);
  });

  it('rejects a token minted for another app', async () => {
    await expect(
      verifySession({
        token: mint({ aud: 'somebody-elses-app' }),
        secret: SECRET,
        clientId: CLIENT_ID,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(/another app/);
  });

  it('rejects a token issued in the future', async () => {
    await expect(
      verifySession({
        token: mint({ iat: NOW + 3600 }),
        secret: SECRET,
        clientId: CLIENT_ID,
        nowSeconds: NOW,
      }),
    ).rejects.toThrow(/future/);
  });

  it.each([
    ['too few segments', 'aaa.bbb'],
    ['empty', ''],
    ['not base64', '!!!.!!!.!!!'],
  ])('rejects a %s token without throwing something unhelpful', async (_label, token) => {
    await expect(
      verifySession({ token, secret: SECRET, clientId: CLIENT_ID, nowSeconds: NOW }),
    ).rejects.toThrow(SessionVerificationError);
  });
});
