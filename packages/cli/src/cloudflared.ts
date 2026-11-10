import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `cloudflared`, without asking anybody to install it.
 *
 * `storeware app dev` reaches the developer's laptop through a Cloudflare
 * quick tunnel. One already on the PATH is used as it is. Otherwise the CLI
 * downloads Cloudflare's own release for this machine, once, into its cache,
 * and checks it against the SHA-256 written below before it is ever run.
 *
 * The hashes are pinned here rather than read from the release page, because
 * a hash fetched from where the file came from proves only that the two
 * arrived together. Raising `VERSION` means taking the new hashes from the
 * release (GitHub lists each asset's digest), in a commit someone reviews.
 * On macOS the release is an archive, so the binary inside it has a hash too:
 * the one Cloudflare's release notes list.
 */

export const CLOUDFLARED_VERSION = '2026.10.7';

interface Asset {
  /** The file on the release. */
  file: string;
  /** Of the file as downloaded. */
  sha256: string;
  /** Of the program inside, for an archive. */
  binarySha256?: string;
}

const ASSETS: Record<string, Asset> = {
  'darwin-arm64': {
    file: 'cloudflared-darwin-arm64.tgz',
    sha256: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd',
    binarySha256: '2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12',
  },
  'darwin-x64': {
    file: 'cloudflared-darwin-amd64.tgz',
    sha256: '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848',
    binarySha256: '5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86',
  },
  'linux-x64': {
    file: 'cloudflared-linux-amd64',
    sha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
  },
  'linux-arm64': {
    file: 'cloudflared-linux-arm64',
    sha256: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775',
  },
  'linux-arm': {
    file: 'cloudflared-linux-arm',
    sha256: '74f690f6707182839b63e0465726c7776dd63f0a174390b911d5d71f35cab94e',
  },
  'linux-ia32': {
    file: 'cloudflared-linux-386',
    sha256: '4823d2f038395617e04e4070601ab45c0c43f31f15ee7586be299e19ef49d46e',
  },
  'win32-x64': {
    file: 'cloudflared-windows-amd64.exe',
    sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
  },
  'win32-ia32': {
    file: 'cloudflared-windows-386.exe',
    sha256: '88c6b972b410db0e26745f593510d772c825a13c5a2374819e3f13a05b333082',
  },
};

export class CloudflaredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflaredError';
  }
}

/** The release file for a platform and processor, or null where there is none. Pure. */
export function assetFor(platform: string, arch: string): Asset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Where a downloaded copy is kept: one folder per version, so an upgrade never runs stale bytes. */
export function cacheFolder(): string {
  return join(
    process.env.STOREWARE_CACHE_HOME ?? join(homedir(), '.storeware', 'cache'),
    'cloudflared',
    CLOUDFLARED_VERSION,
  );
}

function onPath(): boolean {
  const found = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  return !found.error && found.status === 0;
}

/**
 * The program to run: `cloudflared` from the PATH, or the checked copy in the
 * cache, downloading it first if there is none. Says what it is doing on
 * `say`, because forty megabytes is long enough to look like a hang.
 */
export async function cloudflaredBinary(
  say: (line: string) => void,
  options: { fetchImpl?: typeof fetch; platform?: string; arch?: string; usePath?: boolean } = {},
): Promise<string> {
  if ((options.usePath ?? true) && onPath()) return 'cloudflared';

  const platform = options.platform ?? process.platform;
  const asset = assetFor(platform, options.arch ?? process.arch);
  if (!asset) {
    throw new CloudflaredError(
      `There is no cloudflared release for ${platform} on ${options.arch ?? process.arch}. ` +
        'Install it yourself, or pass --tunnel <https origin> for a tunnel you run.',
    );
  }

  const folder = cacheFolder();
  const program = join(folder, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const expected = asset.binarySha256 ?? asset.sha256;
  try {
    if (sha256(await readFile(program)) === expected) return program;
  } catch {
    // Not downloaded yet.
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`;
  say(`  Downloading cloudflared ${CLOUDFLARED_VERSION} from Cloudflare, once`);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url);
  } catch (error) {
    throw new CloudflaredError(`Could not download cloudflared: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new CloudflaredError(
      `Could not download cloudflared: ${url} answered ${response.status}.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== asset.sha256) {
    throw new CloudflaredError(
      `The cloudflared download did not match its checksum, so it was not run. ${url}`,
    );
  }

  await mkdir(folder, { recursive: true });
  // Written beside its final name and moved, so a download cut off half way
  // never leaves a file that looks like the program.
  const work = await mkdtemp(join(tmpdir(), 'storeware-cloudflared-'));
  try {
    let binary = bytes;
    if (asset.file.endsWith('.tgz')) {
      const archive = join(work, asset.file);
      await writeFile(archive, bytes);
      const unpacked = spawnSync('tar', ['-xzf', archive, '-C', work], { stdio: 'ignore' });
      if (unpacked.status !== 0) throw new CloudflaredError('Could not unpack cloudflared.');
      binary = new Uint8Array(await readFile(join(work, 'cloudflared')));
      if (sha256(binary) !== asset.binarySha256) {
        throw new CloudflaredError(
          'The cloudflared program did not match its checksum, so it was not run.',
        );
      }
    }
    const staged = `${program}.partial`;
    await writeFile(staged, binary);
    await chmod(staged, 0o755);
    await rename(staged, program);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return program;
}
