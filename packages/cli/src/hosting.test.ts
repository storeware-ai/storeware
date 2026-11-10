import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BUNDLE_BYTES, parseManifest } from '@storeware/plugin-sdk/manifest';
import { fetchRuntimeLogs } from './api';
import {
  bundleHostedApp,
  consoleFailed,
  consoleLine,
  HostingError,
  sha256Hex,
  withRuntimeBundle,
  type ConsoleEntry,
} from './hosting';
import { hostedManifestTemplate } from './scaffold';

/**
 * What `app deploy` sends for a hosted app.
 *
 * The server keys a release by the hash of the manifest text, so the point of
 * every test here is the same: the same code and the same file must come out
 * byte for byte the same, or a deploy that changed nothing would ask every
 * merchant to approve it again.
 */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const MANIFEST = hostedManifestTemplate('sizing', 'Sizing');

describe('setting runtime.bundle in the text sent', () => {
  it('puts the line straight under [runtime], and changes nothing else', () => {
    const sent = withRuntimeBundle(MANIFEST, A);
    expect(parseManifest(sent).runtime?.bundle).toBe(A);
    expect(sent.replace(`bundle = "${A}"\n`, '')).toBe(MANIFEST);
    expect(sent).toContain(`[runtime]\nbundle = "${A}"\n`);
  });

  it('gives the same text for the same hash, every time', () => {
    expect(withRuntimeBundle(MANIFEST, A)).toBe(withRuntimeBundle(MANIFEST, A));
    expect(sha256Hex(new TextEncoder().encode(withRuntimeBundle(MANIFEST, A)))).toBe(
      sha256Hex(new TextEncoder().encode(withRuntimeBundle(MANIFEST, A))),
    );
  });

  it('replaces a bundle already in the file where it stands', () => {
    const stale = MANIFEST.replace('egress = []', `egress = []\nbundle = "${B}"  # old`);
    const sent = withRuntimeBundle(stale, A);
    expect(sent).toBe(MANIFEST.replace('egress = []', `egress = []\nbundle = "${A}"`));
    // Setting it again changes nothing.
    expect(withRuntimeBundle(sent, A)).toBe(sent);
  });

  it('takes the line out for a registration that names no code', () => {
    const sent = withRuntimeBundle(withRuntimeBundle(MANIFEST, A), null);
    expect(sent).toBe(MANIFEST);
    expect(parseManifest(sent).runtime?.bundle).toBeUndefined();
  });

  it('stops at the next table, and leaves it alone', () => {
    const panel = `\n[[extensions.admin]]\npoint = "admin.product.detail.sidebar"\nurl = "https://sizing.storewareapps.com/panel"\ntitle = "Sizing"\n`;
    const sent = withRuntimeBundle(`${MANIFEST}${panel}`, A);
    expect(sent).toBe(`${withRuntimeBundle(MANIFEST, A)}${panel}`);
  });

  it('keeps Windows line endings as they were', () => {
    const crlf = MANIFEST.replace(/\n/g, '\r\n');
    const sent = withRuntimeBundle(crlf, A);
    expect(sent).toContain(`[runtime]\r\nbundle = "${A}"\r\n`);
    expect(sent.replace(/\r\n/g, '\n')).toBe(withRuntimeBundle(MANIFEST, A));
  });

  it('finds a spaced or quoted header', () => {
    const spaced = MANIFEST.replace('[runtime]', '[ "runtime" ]  # hosted');
    expect(parseManifest(withRuntimeBundle(spaced, A)).runtime?.bundle).toBe(A);
  });

  it('says what to do when [runtime] is not a table of its own', () => {
    const inline = MANIFEST.replace(
      /\[runtime\][\s\S]*$/,
      'runtime = { main = "src/worker.ts", egress = [] }\n',
    );
    expect(() => withRuntimeBundle(inline, A)).toThrow(HostingError);
    expect(() => withRuntimeBundle(inline, A)).toThrow(/table of its own/);
  });
});

describe('bundling the code', () => {
  function app(files: Record<string, string>): string {
    const folder = mkdtempSync(join(tmpdir(), 'storeware-hosted-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
    return folder;
  }

  const CODE = {
    'src/worker.ts': `import { greet } from './greet';\nexport default { fetch: (r: Request) => new Response(greet(new URL(r.url).pathname)) };\n`,
    'src/greet.ts': `export const greet = (who: string): string => \`hello \${who}\`;\n`,
  };

  it('makes one readable ES module of the entry and what it imports', async () => {
    const { bytes, sha256 } = await bundleHostedApp(app(CODE), 'src/worker.ts');
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('export {');
    expect(text).toContain('hello ');
    expect(text).not.toContain('import ');
    // Not minified, so a logged line can be found in it.
    expect(text).toContain('// src/greet.ts');
    expect(sha256).toBe(sha256Hex(bytes));
  });

  it('gives the same bytes for the same code, wherever it is checked out', async () => {
    const one = await bundleHostedApp(app(CODE), 'src/worker.ts');
    const two = await bundleHostedApp(app(CODE), 'src/worker.ts');
    expect(two.sha256).toBe(one.sha256);
  });

  it('gives a different hash for different code', async () => {
    const one = await bundleHostedApp(app(CODE), 'src/worker.ts');
    const changed = await bundleHostedApp(
      app({ ...CODE, 'src/greet.ts': 'export const greet = (who: string) => `hi ${who}`;\n' }),
      'src/worker.ts',
    );
    expect(changed.sha256).not.toBe(one.sha256);
  });

  it('leaves the runtime’s own modules as imports', async () => {
    const { bytes } = await bundleHostedApp(
      app({ 'src/worker.ts': `import { env } from 'cloudflare:workers';\nexport default env;\n` }),
      'src/worker.ts',
    );
    expect(new TextDecoder().decode(bytes)).toContain('from "cloudflare:workers"');
  });

  it('refuses code that comes out as nothing', async () => {
    await expect(
      bundleHostedApp(app({ 'src/worker.ts': 'export type Nothing = never;\n' }), 'src/worker.ts'),
    ).rejects.toThrow(/came out empty/);
  });

  it('names the entry it cannot find', async () => {
    await expect(bundleHostedApp(app(CODE), 'src/missing.ts')).rejects.toThrow(
      'No file at src/missing.ts, which runtime.main names.',
    );
  });

  it('says where the code does not build', async () => {
    await expect(
      bundleHostedApp(app({ 'src/worker.ts': `import './nowhere';\n` }), 'src/worker.ts'),
    ).rejects.toThrow(/Could not bundle src\/worker\.ts:\n {2}src\/worker\.ts:1: /);
  });

  it('refuses a bundle over the limit before uploading anything', async () => {
    const big = `export default ${JSON.stringify('x'.repeat(MAX_BUNDLE_BYTES))};\n`;
    await expect(bundleHostedApp(app({ 'src/worker.ts': big }), 'src/worker.ts')).rejects.toThrow(
      /may be at most 3\.0 MB/,
    );
  });
});

describe('a line of what the code logged', () => {
  const entry: ConsoleEntry = {
    at: '2026-11-09T18:22:14.512Z',
    level: 'log',
    message: 'product created',
    installationId: 'inst',
    storeId: '9f2c1b7a-0000-4000-8000-000000000000',
    outcome: 'ok',
    status: 200,
    release: 'r1',
  };

  it('reads as time, level, message, then how the run ended', () => {
    expect(consoleLine(entry)).toBe('  18:22:14  log    product created  (200, 9f2c1b7a)');
    expect(consoleLine({ ...entry, outcome: 'exceededCpu', status: null, storeId: null })).toBe(
      '  18:22:14  log    product created  (exceededCpu)',
    );
  });

  it('counts a run that stopped early, a 5xx, or an error logged as failed', () => {
    expect(consoleFailed(entry)).toBe(false);
    expect(consoleFailed({ ...entry, outcome: 'exception' })).toBe(true);
    expect(consoleFailed({ ...entry, status: 502 })).toBe(true);
    expect(consoleFailed({ ...entry, level: 'error' })).toBe(true);
  });
});

describe('following a hosted app’s logs', () => {
  const credentials = {
    apiUrl: 'https://api.example.test',
    adminUrl: 'https://admin.example.test',
    token: 'swd_test',
    organizationId: '',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answering(page: unknown) {
    const asked: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(new URL(url));
        return new Response(JSON.stringify({ data: page }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return asked;
  }

  it('asks from the cursor the last page handed back, as after', async () => {
    const asked = answering({ logs: [], next: 'bG9nOjQy' });
    const page = await fetchRuntimeLogs(credentials, 'sizing', { after: 'bG9nOjQx', limit: 200 });
    expect(asked[0]!.pathname).toBe('/api/v1/developer/apps/sizing/runtime/logs');
    expect(asked[0]!.searchParams.get('after')).toBe('bG9nOjQx');
    expect(asked[0]!.searchParams.get('since')).toBeNull();
    expect(asked[0]!.searchParams.get('limit')).toBe('200');
    expect(page).toEqual({ logs: [], next: 'bG9nOjQy' });
  });

  it('still asks from a time, for a first call that starts there', async () => {
    const asked = answering({ logs: [], next: null });
    await fetchRuntimeLogs(credentials, 'sizing', { since: '2026-11-09T10:00:00.000Z' });
    expect(asked[0]!.searchParams.get('since')).toBe('2026-11-09T10:00:00.000Z');
    expect(asked[0]!.searchParams.get('after')).toBeNull();
  });
});
