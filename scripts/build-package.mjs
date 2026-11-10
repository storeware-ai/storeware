#!/usr/bin/env node
/**
 * Builds a workspace package into `dist/` for npm, from the package's own
 * directory: `node ../../scripts/build-package.mjs`.
 *
 * Inside the monorepo every package is imported as TypeScript source, which is
 * right for Next, Vite and vitest and wrong for anybody who installs it from
 * npm. Node will not run `.ts`, and the source's relative imports have no
 * extension, which Node's ESM loader refuses. So the published copy is built:
 *
 *   JavaScript by esbuild, one file per entry in the package's `exports`, with
 *   what they share split into chunks, and every dependency and peer left as an
 *   import for the installer to provide.
 *
 *   Declarations by `tsc`, beside the JavaScript, with each relative import
 *   given the `.js` it resolves to, so a project on `moduleResolution: node16`
 *   reads them as well as one on `bundler`.
 *
 * `--bin` builds a program instead (the CLI): one file, everything bundled in,
 * workspace packages included, because a command typed into `npx` should not
 * wait on an install of its own dependencies, and no declarations. What the
 * package lists in `dependencies` is the exception, left for npm to install.
 *
 * The package's `publishConfig` names what this writes. `pnpm pack` swaps it in,
 * so the workspace keeps importing source and only the tarball points at
 * `dist/`. `scripts/pack-smoke.mjs` installs the tarballs to prove it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bin = process.argv.includes('--bin');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });

/** `./src/bridge/protocol.ts` from the exports map, as `bridge/protocol`. */
function entryPoints() {
  const sources = Object.values(pkg.exports ?? { '.': pkg.main }).filter(
    (target) => typeof target === 'string' && /\.tsx?$/.test(target),
  );
  return Object.fromEntries(
    sources.map((source) => [source.replace(/^\.\/src\//, '').replace(/\.tsx?$/, ''), source]),
  );
}

/** Each version of every package this build writes, for `__STOREWARE_VERSIONS__`. */
function workspaceVersions() {
  const packages = resolve(root, '..');
  const versions = {};
  for (const name of readdirSync(packages)) {
    const file = join(packages, name, 'package.json');
    if (!existsSync(file)) continue;
    const other = JSON.parse(readFileSync(file, 'utf8'));
    if (other.private !== true && other.name?.startsWith('@storeware/')) {
      versions[other.name] = other.version;
    }
  }
  return versions;
}

const builtins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

if (bin) {
  const entry = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
  await build({
    entryPoints: { index: entry },
    outdir: dist,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Its own dependencies stay imports, for npm to install beside it. There is
    // one, esbuild, for `app deploy`: it runs a native binary it finds by path,
    // and refuses to run from inside a bundle.
    external: [...builtins, ...Object.keys(pkg.dependencies ?? {})],
    // A bundled CommonJS dependency calls `require`, which an ES module has
    // only when it makes one.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    define: { __STOREWARE_VERSIONS__: JSON.stringify(workspaceVersions()) },
    logLevel: 'warning',
  });
} else {
  const external = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  await build({
    entryPoints: entryPoints(),
    outdir: dist,
    bundle: true,
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    external: [...builtins, ...external, ...external.map((name) => `${name}/*`)],
    logLevel: 'warning',
  });

  const tsconfig = join(dist, 'tsconfig.build.json');
  const src = relative(dist, join(root, 'src'));
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: relative(dist, join(root, 'tsconfig.json')),
      compilerOptions: {
        noEmit: false,
        emitDeclarationOnly: true,
        declaration: true,
        declarationMap: false,
        sourceMap: false,
        incremental: false,
        rootDir: src,
        outDir: '.',
      },
      include: [src],
      // Globs here resolve against this file, which sits in `dist/`.
      exclude: [`${src}/**/*.test.ts`, `${src}/**/*.test.tsx`, `${src}/test-setup.ts`],
    }),
  );
  const tsc = spawnSync('npx', ['--no-install', 'tsc', '-p', tsconfig], {
    cwd: root,
    stdio: 'inherit',
  });
  rmSync(tsconfig);
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  rewriteDeclarationImports(dist);
}

/**
 * `from './client'` becomes `from './client.js'`, or `./client/index.js` for a
 * folder: what a declaration beside its JavaScript must say for Node's
 * resolution to find it.
 */
function rewriteDeclarationImports(folder) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      rewriteDeclarationImports(path);
      continue;
    }
    if (!name.endsWith('.d.ts')) continue;
    const here = dirname(path);
    const source = readFileSync(path, 'utf8');
    const rewritten = source.replace(
      /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
      (whole, before, quote, specifier) => {
        if (/\.(js|json)$/.test(specifier)) return whole;
        const target = resolve(here, specifier);
        if (existsSync(`${target}.d.ts`)) return `${before}${quote}${specifier}.js${quote}`;
        if (existsSync(join(target, 'index.d.ts'))) {
          return `${before}${quote}${specifier}/index.js${quote}`;
        }
        throw new Error(`${relative(root, path)}: cannot resolve ${specifier}`);
      },
    );
    if (rewritten !== source) writeFileSync(path, rewritten);
  }
}
