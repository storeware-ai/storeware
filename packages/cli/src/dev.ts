import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseManifest } from '@storeware/plugin-sdk/manifest';
import {
  applyManifest,
  createDevelopmentSecret,
  createDevelopmentStore,
  installDevelopmentRelease,
  listDevelopmentStores,
  listMyPlugins,
  type DevelopmentStore,
} from './api';
import { CloudflaredError, cloudflaredBinary } from './cloudflared';
import type { Credentials } from './config';

/**
 * `storeware app dev`: the app on the developer's laptop, installed on a
 * development store, with every URL in its manifest pointing at a tunnel.
 *
 * Storeware calls apps from the public internet and refuses private
 * addresses, so localhost has to be reached through a tunnel. The manifest in
 * the repository is never edited: its local origin is swapped for the tunnel's
 * in the copy sent as a development release, which pins only on the
 * developer's own development stores and is never offered to a merchant. Each
 * save of the manifest sends another.
 */

const out = (text: string) => process.stdout.write(`${text}\n`);

export class DevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevError';
  }
}

/** Every origin a manifest names, in the order they appear. Pure. */
export function originsIn(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/https?:\/\/[^\s"'/]+/g)) found.add(match[0]);
  return [...found];
}

const isLocal = (origin: string) => {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};

/**
 * The manifest with every local origin replaced by the tunnel's. Text in,
 * text out: the bytes sent are the developer's own but for those origins, so
 * the release reads exactly like the file. Pure.
 */
export function rewriteLocalOrigins(source: string, tunnel: string): string {
  const to = tunnel.replace(/\/$/, '');
  let rewritten = source;
  // Longest first, so localhost:4000 cannot eat the front of localhost:40001.
  const local = originsIn(source)
    .filter(isLocal)
    .sort((a, b) => b.length - a.length);
  for (const origin of local) {
    rewritten = rewritten.split(origin).join(to);
  }
  return rewritten;
}

/** The port the local origin listens on, for the tunnel to forward to. Pure. */
export function localPortOf(source: string): number | null {
  const local = originsIn(source).find(isLocal);
  if (!local) return null;
  const url = new URL(local);
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

interface DevState {
  storeId?: string;
  slug?: string;
  clientSecret?: string;
}

/**
 * Kept beside the project, not in the home directory: a development secret
 * belongs to one app on one laptop. The folder ignores itself, so it never
 * reaches a commit.
 */
async function loadState(directory: string): Promise<DevState> {
  try {
    return JSON.parse(
      await readFile(join(directory, '.storeware', 'dev.json'), 'utf8'),
    ) as DevState;
  } catch {
    return {};
  }
}

/** The development store `app dev` last ran this app on, if it has. */
export async function rememberedStoreId(directory: string): Promise<string | undefined> {
  return (await loadState(directory)).storeId;
}

async function saveState(directory: string, state: DevState): Promise<void> {
  const folder = join(directory, '.storeware');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '.gitignore'), '*\n', 'utf8');
  await writeFile(join(folder, 'dev.json'), `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function chooseStore(
  credentials: Credentials,
  named: string | undefined,
  remembered: string | undefined,
  appName: string,
): Promise<DevelopmentStore> {
  const stores = await listDevelopmentStores(credentials);
  if (named) {
    const match = stores.find((store) => store.id === named || store.handle === named);
    if (!match)
      throw new DevError(`No development store called ${named}. Leave out --store to make one.`);
    return match;
  }
  const kept = stores.find((store) => store.id === remembered);
  if (kept) return kept;
  if (stores[0]) return stores[0];
  out(`  No development store yet. Making "${appName} dev".`);
  return createDevelopmentStore(credentials, `${appName} dev`);
}

/**
 * Starts a Cloudflare quick tunnel and resolves with its public origin.
 * `cloudflared` is the one on the PATH, or a checked download (`./cloudflared`).
 */
async function startTunnel(port: number): Promise<{ origin: string; child: ChildProcess }> {
  let program: string;
  try {
    program = await cloudflaredBinary(out);
  } catch (error) {
    throw new DevError(error instanceof CloudflaredError ? error.message : String(error));
  }
  return new Promise((done, fail) => {
    const child = spawn(
      program,
      ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      child.kill();
      fail(new DevError('cloudflared started but gave no address within 30 seconds.'));
    }, 30_000);
    const read = (chunk: Buffer) => {
      const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
      if (found) {
        clearTimeout(timer);
        done({ origin: found[0], child });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(
        new DevError(
          `cloudflared failed: ${error.message}. Pass --tunnel <https origin> for a tunnel you run yourself.`,
        ),
      );
    });
  });
}

export async function runDev(
  credentials: Credentials,
  options: {
    manifestPath: string;
    store?: string | undefined;
    tunnel?: string | undefined;
    command: string[];
  },
): Promise<void> {
  const directory = resolve(options.manifestPath, '..');
  const original = await readFile(options.manifestPath, 'utf8');
  const manifest = parseManifest(original);
  const port = localPortOf(original);
  if (!port && !options.tunnel) {
    throw new DevError(
      'No localhost URL in the manifest to stand in for. Point app.url or webhooks.url at http://localhost:<port>.',
    );
  }

  const state = await loadState(directory);
  if (state.slug && state.slug !== manifest.app.slug) delete state.clientSecret;
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const child of children) child.kill();
  };
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });

  try {
    let origin = options.tunnel?.replace(/\/$/, '');
    if (!origin) {
      out(`  Opening a tunnel to localhost:${port}`);
      const tunnel = await startTunnel(port!);
      children.push(tunnel.child);
      origin = tunnel.origin;
    }
    out(`  Tunnel        ${origin}`);

    const store = await chooseStore(credentials, options.store, state.storeId, manifest.app.name);
    out(`  Store         ${store.name} (${store.handle})`);

    // An app needs a row before it can have development releases. A new one
    // is registered as a draft, which only its own development stores see.
    const mine = await listMyPlugins(credentials);
    if (!mine.some((plugin) => plugin.slug === manifest.app.slug)) {
      const created = await applyManifest(
        credentials,
        rewriteLocalOrigins(original, origin),
        false,
      );
      out(`  Registered    ${created.clientId} as a draft`);
    }

    if (!state.clientSecret) {
      state.clientSecret = (await createDevelopmentSecret(credentials, manifest.app.slug)).secret;
    }
    await saveState(directory, {
      storeId: store.id,
      slug: manifest.app.slug,
      clientSecret: state.clientSecret,
    });

    const send = async (source: string) => {
      const applied = await applyManifest(
        credentials,
        rewriteLocalOrigins(source, origin!),
        false,
        'development',
      );
      if (!applied.release) throw new DevError('The server did not record a release.');
      const installed = await installDevelopmentRelease(
        credentials,
        store.id,
        manifest.app.slug,
        applied.release.id,
      );
      out(
        `  Release       development ${applied.release.version}${applied.release.created ? '' : ' (unchanged)'} on ${store.handle}`,
      );
      return installed;
    };

    const installed = await send(original);
    if (installed.embedded) {
      out(
        `  Open          ${credentials.adminUrl.replace(/\/$/, '')}/stores/${store.id}/apps/${manifest.app.slug}`,
      );
    }

    if (options.command.length > 0) {
      const [program, ...rest] = options.command;
      const child = spawn(program!, rest, {
        stdio: 'inherit',
        env: {
          ...process.env,
          ...(port ? { PORT: String(port) } : {}),
          STOREWARE_CLIENT_ID: manifest.app.slug,
          STOREWARE_CLIENT_SECRET: state.clientSecret,
          STOREWARE_API_URL: credentials.apiUrl,
          STOREWARE_ADMIN_URL: credentials.adminUrl,
          STOREWARE_APP_URL: origin,
          PLUGIN_URL: origin,
          STOREWARE_STORE_ID: store.id,
        },
      });
      children.push(child);
      child.on('exit', (code) => {
        stop();
        process.exit(code ?? 0);
      });
    } else {
      out('');
      out('  Your server needs these. Pass your start command after -- to have them set for you.');
      out(`    STOREWARE_CLIENT_ID=${manifest.app.slug}`);
      out('    STOREWARE_CLIENT_SECRET (saved in .storeware/dev.json)');
      out(`    STOREWARE_APP_URL=${origin}`);
    }

    out('');
    out('  Watching the manifest. Each save sends a new development release.');
    let timer: NodeJS.Timeout | undefined;
    watch(options.manifestPath, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        readFile(options.manifestPath, 'utf8')
          .then((source) => {
            parseManifest(source);
            return send(source);
          })
          .catch((error: unknown) => out(`  Not sent: ${(error as Error).message}`));
      }, 300);
    });
    await new Promise<never>(() => {});
  } catch (error) {
    stop();
    throw error;
  }
}
