#!/usr/bin/env node
/**
 * The packages as npm would hand them out, proved end to end.
 *
 * Packs `@storeware/cli`, `@storeware/plugin-sdk`, `@storeware/app-bridge-react`
 * and `@storeware/app-ui` into tarballs (each `prepack` builds `dist/`), then,
 * outside the workspace, for every template:
 *
 *   runs the packed CLI's `init --template <name>` into an empty folder,
 *   installs the app with npm, every `@storeware/*` package from its tarball,
 *   and typechecks and builds it.
 *
 * Nothing here can see the monorepo's source, so an export missing from a
 * tarball, a `workspace:` range left in a manifest, a declaration that does not
 * resolve, or a scaffold pinning a version that was never released (the bug
 * this exists for) fails here and not in a developer's first five minutes.
 *
 *     node scripts/pack-smoke.mjs [--out <folder>] [template ...]
 *
 * `--out` keeps the tarballs in a folder of your choosing, which is how the
 * release workflow publishes exactly the bytes this proved.
 *
 * Needs the network for the templates' other dependencies (React, Hono and
 * so on). Leaves its folder behind on failure and says where.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['cli', 'plugin-sdk', 'app-bridge-react', 'app-ui'];
const TEMPLATES = ['node', 'typescript', 'react-router', 'nextjs'];
const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const out = outAt === -1 ? null : resolve(argv[outAt + 1] ?? '');
const only = argv.filter((_, i) => outAt === -1 || (i !== outAt && i !== outAt + 1));
const templates = only.length > 0 ? only : TEMPLATES;

const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'storeware-pack-'));
const tarballs = out ?? join(work, 'tarballs');
mkdirSync(tarballs, { recursive: true });
if (readdirSync(tarballs).length > 0) {
  process.stderr.write(`pack-smoke: ${tarballs} is not empty\n`);
  process.exit(1);
}

function run(command, args, cwd, label = `${command} ${args.join(' ')}`) {
  process.stdout.write(`\n$ ${label}  (in ${cwd})\n`);
  try {
    execFileSync(command, args, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Set by pnpm and npm to where the outer command was typed, and read by
        // the CLI as its working folder: inherited, it points every child at the
        // folder `pnpm smoke` ran in rather than at the app it is checking.
        INIT_CWD: cwd,
        npm_config_update_notifier: 'false',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    });
  } catch {
    process.stderr.write(`\npack-smoke: failed: ${label}\nLeft everything in ${work}\n`);
    process.exit(1);
  }
}

/** The package as published: the tarball's own manifest, with pnpm's rewrites done. */
function packedManifest(tarball) {
  return JSON.parse(
    execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
}

const packed = {};
for (const folder of PACKAGES) {
  run('pnpm', ['pack', '--pack-destination', tarballs], join(ROOT, 'packages', folder));
}
for (const file of readdirSync(tarballs)) {
  const tarball = join(tarballs, file);
  const manifest = packedManifest(tarball);
  packed[manifest.name] = tarball;

  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  const problems = [
    JSON.stringify(manifest).includes('workspace:') && 'a workspace: range survived packing',
    manifest.private && 'it is marked private',
    /package\/src\//.test(listing) && 'it ships its TypeScript source',
    !/package\/dist\//.test(listing) && 'it ships no dist/',
    !listing.includes('package/LICENSE') && 'it ships no LICENSE',
    !listing.includes('package/README.md') && 'it ships no README',
  ].filter(Boolean);
  if (problems.length > 0) {
    process.stderr.write(`pack-smoke: ${manifest.name}: ${problems.join('; ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`packed ${manifest.name}@${manifest.version}: ${file}\n`);
}

// The CLI is installed once, as `npx @storeware/cli` would fetch it.
const cliHome = join(work, 'cli');
mkdirSync(cliHome);
writeFileSync(join(cliHome, 'package.json'), '{"private":true}\n');
run('npm', ['install', '--no-audit', '--no-fund', packed['@storeware/cli']], cliHome);
const storeware = join(cliHome, 'node_modules', '.bin', 'storeware');
run(storeware, ['--help'], cliHome, 'storeware --help');

for (const template of templates) {
  const app = join(work, `app-${template}`);
  run(storeware, ['init', app, '--template', template, '--name', 'Smoke test'], work);

  // The versions the scaffold pinned must be the ones just packed: a pin to a
  // version that was never published is the failure this whole script is for.
  const manifestPath = join(app, 'package.json');
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const overrides = {};
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!name.startsWith('@storeware/')) continue;
      const tarball = packed[name];
      if (!tarball) throw new Error(`${template} depends on ${name}, which is not published`);
      const version = packedManifest(tarball).version;
      if (range !== `^${version}`) {
        process.stderr.write(
          `pack-smoke: ${template} asks for ${name}@${range}, packed ${version}\n`,
        );
        process.exit(1);
      }
      pkg[field][name] = `file:${tarball}`;
    }
  }
  // And the @storeware packages they depend on in turn, from the same tarballs.
  for (const [name, tarball] of Object.entries(packed)) overrides[name] = `file:${tarball}`;
  pkg.overrides = overrides;
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);

  run('npm', ['install', '--no-audit', '--no-fund'], app);
  run(storeware, ['validate'], app, 'storeware validate');
  if (pkg.scripts.typecheck) run('npm', ['run', 'typecheck'], app);
  run('npm', ['run', 'build'], app);
  process.stdout.write(`\npack-smoke: ${template} installs, typechecks and builds.\n`);
}

rmSync(work, { recursive: true, force: true });
process.stdout.write(`\npack-smoke: ${templates.join(', ')} all passed.\n`);
