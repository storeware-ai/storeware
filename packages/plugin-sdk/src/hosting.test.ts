import { describe, expect, it } from 'vitest';
import { ManifestError, manifestUrls, parseManifest } from './manifest';

/**
 * The rules for an app Storeware hosts.
 *
 * An address on the hosted domain is the app's own and only a hosted app's,
 * so one app can never be pointed at another's code, and the code cannot
 * call another hosted app either.
 */

const HOSTED = `
[app]
slug = "sizing"
name = "Sizing"
url = "https://sizing.storewareapps.com/"

[oauth]
scopes = ["products:read"]

[webhooks]
url = "https://sizing.storewareapps.com/webhooks"
events = ["product.created.v1"]

[runtime]
egress = ["api.sizes.example"]
`;

function problemsOf(source: string): string[] {
  try {
    parseManifest(source);
    return [];
  } catch (error) {
    if (error instanceof ManifestError) return [...error.issues];
    throw error;
  }
}

describe('a hosted app’s manifest', () => {
  it('parses, with the entry file defaulted and no bundle until deploy writes one', () => {
    const manifest = parseManifest(HOSTED);
    expect(manifest.runtime).toEqual({ main: 'src/worker.ts', egress: ['api.sizes.example'] });
  });

  it('accepts the bundle hash deploy writes, and nothing that is not one', () => {
    const hash = 'a'.repeat(64);
    expect(parseManifest(`${HOSTED}bundle = "${hash}"\n`).runtime?.bundle).toBe(hash);
    expect(problemsOf(`${HOSTED}bundle = "latest"\n`).join()).toMatch(/runtime.bundle/);
  });

  it('refuses another app’s address on the hosted domain', () => {
    const problems = problemsOf(
      HOSTED.replace(
        'https://sizing.storewareapps.com/webhooks',
        'https://reviews.storewareapps.com/webhooks',
      ),
    );
    expect(problems).toEqual([
      'https://reviews.storewareapps.com/webhooks: only sizing.storewareapps.com is this app’s on storewareapps.com',
    ]);
  });

  it('refuses another app’s address written with a trailing dot', () => {
    const problems = problemsOf(
      HOSTED.replace(
        'https://sizing.storewareapps.com/webhooks',
        'https://other.storewareapps.com./x',
      ),
    );
    expect(problems).toEqual([
      'https://other.storewareapps.com./x: only sizing.storewareapps.com is this app’s on storewareapps.com',
    ]);
  });

  it('refuses an address on the hosted domain from an app that is not hosted', () => {
    const remote = HOSTED.slice(0, HOSTED.indexOf('[runtime]'));
    expect(problemsOf(remote)).toEqual([
      'https://sizing.storewareapps.com/: an address on storewareapps.com needs [runtime]',
      'https://sizing.storewareapps.com/webhooks: an address on storewareapps.com needs [runtime]',
    ]);
  });

  it('refuses the bare hosted domain, whose pages belong to Storeware', () => {
    expect(
      problemsOf(HOSTED.replace('https://sizing.storewareapps.com/', 'https://storewareapps.com/')),
    ).toEqual([
      'https://storewareapps.com/: only sizing.storewareapps.com is this app’s on storewareapps.com',
    ]);
  });

  it('refuses egress to another hosted app, a repeated host, or anything that is not a host', () => {
    expect(
      problemsOf(HOSTED.replace('"api.sizes.example"', '"reviews.storewareapps.com"')),
    ).toEqual([
      'runtime.egress.reviews.storewareapps.com: a hosted app may not call another hosted app',
    ]);
    expect(
      problemsOf(HOSTED.replace('"api.sizes.example"', '"api.sizes.example", "api.sizes.example"')),
    ).toEqual(['runtime.egress: lists a host twice']);
    for (const bad of [
      'https://api.sizes.example',
      '10.0.0.1',
      '*.sizes.example',
      'API.Sizes.example',
      'localhost',
    ]) {
      expect(problemsOf(HOSTED.replace('"api.sizes.example"', `"${bad}"`)).join()).toMatch(
        /runtime.egress/,
      );
    }
  });

  it('refuses an entry file outside the app', () => {
    for (const main of ['/etc/passwd', '../secrets.ts', 'src/../../x.ts']) {
      expect(problemsOf(`${HOSTED}main = "${main}"\n`).join()).toMatch(/runtime.main/);
    }
  });
});

describe('every address an app is sent data at', () => {
  it('lists the Push 4 doors beside the older ones', () => {
    const manifest = parseManifest(`
[app]
slug = "reviews-plus"
name = "Reviews Plus"
url = "https://r.example/app"

[oauth]
scopes = ["products:read", "checkout:read"]

[app_proxy]
url = "https://r.example/proxy"

[[extensions.sections]]
handle = "reviews"
name = "Reviews"
url = "https://r.example/section"

[automations]
[[automations.actions]]
key = "ask"
label = "Ask"
url = "https://r.example/act"

[checkout.delivery_rates]
url = "https://r.example/rates"
`);
    expect(manifestUrls(manifest).sort()).toEqual([
      'https://r.example/act',
      'https://r.example/app',
      'https://r.example/proxy',
      'https://r.example/rates',
      'https://r.example/section',
    ]);
  });
});
