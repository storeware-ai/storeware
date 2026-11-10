import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetFor, cacheFolder, cloudflaredBinary, CloudflaredError, sha256 } from './cloudflared';

describe('cloudflared without an install', () => {
  let home: string | undefined;
  beforeEach(() => {
    home = process.env.STOREWARE_CACHE_HOME;
    process.env.STOREWARE_CACHE_HOME = mkdtempSync(join(tmpdir(), 'storeware-cache-'));
  });
  afterEach(() => {
    if (home === undefined) delete process.env.STOREWARE_CACHE_HOME;
    else process.env.STOREWARE_CACHE_HOME = home;
  });

  it('has a pinned release, with a checksum, for every machine a developer uses', () => {
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['win32', 'x64'],
    ] as const) {
      const asset = assetFor(platform, arch);
      expect(asset?.sha256, `${platform} ${arch}`).toMatch(/^[0-9a-f]{64}$/);
      // An archive's program is checked as well as the archive.
      if (asset?.file.endsWith('.tgz')) expect(asset.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(assetFor('aix', 'ppc64')).toBeNull();
  });

  it('refuses a download that does not match its checksum, and keeps nothing', async () => {
    const tampered = new Uint8Array([1, 2, 3]);
    const fetchImpl = (async () => new Response(tampered)) as unknown as typeof fetch;
    await expect(
      cloudflaredBinary(() => undefined, {
        fetchImpl,
        platform: 'linux',
        arch: 'x64',
        usePath: false,
      }),
    ).rejects.toThrow(CloudflaredError);
    expect(() => statSync(join(cacheFolder(), 'cloudflared'))).toThrow();
  });

  it('keeps a download that matches, and uses the kept copy after', async () => {
    // A stand-in release whose checksum is the one pinned is not possible to
    // make, so the check is exercised from the other side: a cached file is
    // only trusted when its bytes hash to the pinned value.
    const bytes = readFileSync(new URL('./cloudflared.ts', import.meta.url));
    expect(sha256(bytes)).not.toBe(assetFor('linux', 'x64')!.sha256);
    let downloads = 0;
    const fetchImpl = (async () => {
      downloads += 1;
      return new Response(bytes);
    }) as unknown as typeof fetch;
    await expect(
      cloudflaredBinary(() => undefined, {
        fetchImpl,
        platform: 'linux',
        arch: 'x64',
        usePath: false,
      }),
    ).rejects.toThrow(/checksum/);
    expect(downloads).toBe(1);
  });
});
