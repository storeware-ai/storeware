import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '@storeware/plugin-sdk/manifest';
import { COMMANDS } from './commands';
import {
  hostedManifestTemplate,
  manifestTemplate,
  packageTemplate,
  safeName,
  scaffold,
  storewareVersions,
  templateFiles,
  TEMPLATES,
} from './scaffold';

const sdkVersion = (
  JSON.parse(
    spawnSync(process.execPath, ['-p', 'JSON.stringify(require("../plugin-sdk/package.json"))'], {
      encoding: 'utf8',
    }).stdout,
  ) as { version: string }
).version;

describe('what storeware init writes', () => {
  it('writes a manifest the SDK accepts, with a home and no redirect to maintain', () => {
    const manifest = parseManifest(manifestTemplate('my-app', 'My App', 'http://localhost:4000'));
    expect(manifest.app.url).toBe('http://localhost:4000/app');
    expect(manifest.oauth.redirect_uris).toEqual([]);
    expect(manifest.privacy?.url).toBe('http://localhost:4000/privacy');
  });

  it('writes a node server that is valid JavaScript', () => {
    const folder = mkdtempSync(join(tmpdir(), 'storeware-init-'));
    const file = join(folder, 'server.mjs');
    const server = templateFiles('node', 'My App').find(([path]) => path === 'src/server.js');
    writeFileSync(file, server![1]);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    expect(checked.stderr).toBe('');
    expect(checked.status).toBe(0);
  });

  it('runs dev without an env file, since app dev supplies one', () => {
    for (const template of TEMPLATES) {
      const pkg = JSON.parse(packageTemplate('my-app', template)) as {
        scripts: Record<string, string>;
      };
      // A hosted app has no dev server at all.
      expect(pkg.scripts.dev ?? '').not.toContain('--env-file');
    }
  });

  // The pin that once asked for a version of the SDK that did not exist.
  it('pins every @storeware package to the version beside this CLI', () => {
    expect(storewareVersions()['@storeware/plugin-sdk']).toBe(sdkVersion);
    for (const template of TEMPLATES) {
      const pkg = JSON.parse(packageTemplate('my-app', template)) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.dependencies['@storeware/plugin-sdk']).toBe(`^${sdkVersion}`);
      for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (name.startsWith('@storeware/')) expect(range).toBe(`^${storewareVersions()[name]}`);
      }
    }
  });

  it('gives every template a build, an AGENTS.md and the same three endpoints', () => {
    for (const template of TEMPLATES) {
      const files = new Map(
        scaffold(template, { slug: 'my-app', name: 'My App', url: 'http://localhost:4000' }),
      );
      const pkg = JSON.parse(files.get('package.json')!) as { scripts: Record<string, string> };
      expect(pkg.scripts.build, template).toBeTruthy();
      expect(files.get('AGENTS.md'), template).toContain('npm run build');
      // Every placeholder is filled.
      for (const [path, contents] of files)
        expect(contents, `${template} ${path}`).not.toContain('__APP_');
    }
  });

  it('lists the templates in the help exactly as init accepts them', () => {
    const init = COMMANDS.find((command) => command.id === 'init')!;
    const help = init.flags.find((flag) => flag.name === 'template')!.description;
    for (const template of TEMPLATES) expect(help).toContain(`\`${template}\``);
    expect(help.match(/`[a-z-]+`/g)).toHaveLength(TEMPLATES.length);
  });

  it('writes a hosted manifest the SDK accepts, every address on the app’s own name', () => {
    const manifest = parseManifest(hostedManifestTemplate('my-app', 'My App'));
    expect(manifest.app.url).toBe('https://my-app.storewareapps.com/');
    expect(manifest.webhooks?.url).toBe('https://my-app.storewareapps.com/webhooks');
    expect(manifest.privacy?.url).toBe('https://my-app.storewareapps.com/privacy');
    expect(manifest.runtime).toEqual({ main: 'src/worker.ts', egress: [] });
  });

  it('scaffolds a hosted app with no env file and a worker on the hosted SDK', async () => {
    const files = new Map(
      scaffold('hosted', { slug: 'my-app', name: 'My App', url: 'http://localhost:4000' }),
    );
    expect(files.has('.env.example')).toBe(false);
    const worker = files.get('src/worker.ts')!;
    expect(worker).toContain("from '@storeware/plugin-sdk/hosted'");
    expect(worker).toContain('createHostedApp(env)');
    expect(worker).toContain('export default');
    // Valid TypeScript, whatever the SDK's types turn out to be.
    const { transform } = await import('esbuild');
    await expect(transform(worker, { loader: 'ts', format: 'esm' })).resolves.toBeTruthy();
    const pkg = JSON.parse(files.get('package.json')!) as { scripts: Record<string, string> };
    expect(pkg.scripts.deploy).toBe('storeware app deploy');
    expect(files.get('AGENTS.md')).toContain('npm run deploy');
    expect(files.get('README.md')).not.toContain('your own servers');
  });

  it('keeps a name that would break TOML, JSX or a title out of them', () => {
    expect(safeName(`Bob's {size} <guide> "x" & co`)).toBe('Bobs size guide x  co');
  });
});
