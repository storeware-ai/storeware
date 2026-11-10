import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './args';
import {
  KNOWN_THEME_FILE_VERSION,
  importReportLines,
  reportLines,
  starterTheme,
  validateTheme,
} from './theme';

/**
 * What can be tested without a shop.
 *
 * Which is nearly everything worth testing, and that is the point of the whole
 * command group: a theme file is data, so reading one is a pure function of the
 * file and the vocabulary. The network is four fetches around the edge.
 *
 * The section types below are real ones, on purpose. A fixture vocabulary would
 * make these tests pass against a registry that no longer exists, which is the
 * exact failure `@storeware/theme-schema` was extracted to prevent.
 */

const address = (problems: { at: string }[]) => problems.map((problem) => problem.at);
const sentence = (problems: { says: string }[]) =>
  problems.map((problem) => problem.says).join(' ');

describe('splitting argv', () => {
  it('does not let a switch swallow the filename after it', () => {
    // The bug this replaced. `--publish` took "my-theme.json" as its value and
    // the command was left with no positional at all.
    const args = parseArgs(['--publish', 'my-theme.json']);

    expect(args.has('publish')).toBe(true);
    expect(args.flag('publish')).toBeUndefined();
    expect(args.positional(0)).toBe('my-theme.json');
  });

  it('still lets a declared flag take its value', () => {
    const args = parseArgs(['--store', 'editor-test-shop', 'autumn.json']);

    expect(args.flag('store')).toBe('editor-test-shop');
    expect(args.positional(0)).toBe('autumn.json');
  });

  it('leaves the plugin commands parsing the way they did', () => {
    const init = parseArgs([
      './my-plugin',
      '--slug',
      'stock-sync',
      '--url',
      'http://localhost:4000',
    ]);
    expect(init.positional(0)).toBe('./my-plugin');
    expect(init.flag('slug')).toBe('stock-sync');
    expect(init.flag('url')).toBe('http://localhost:4000');

    const login = parseArgs(['--token', 'sw_abc', '--org', 'org_123']);
    expect(login.flag('token')).toBe('sw_abc');
    expect(login.flag('org')).toBe('org_123');

    const apply = parseArgs(['storeware.app.toml', '--publish']);
    expect(apply.positional(0)).toBe('storeware.app.toml');
    expect(apply.has('publish')).toBe(true);
  });

  it('takes a value joined by an equals sign, for anything that looks like a flag', () => {
    const args = parseArgs(['--name=--Autumn--', '--store=shop']);

    expect(args.flag('name')).toBe('--Autumn--');
    expect(args.flag('store')).toBe('shop');
  });

  it('treats an unknown flag as a switch, so a typo loses the flag and not the file', () => {
    const args = parseArgs(['--stroe', 'autumn.json']);

    expect(args.has('stroe')).toBe(true);
    expect(args.positional(0)).toBe('autumn.json');
  });

  it('does not read a missing value off the end of argv', () => {
    const args = parseArgs(['--store']);

    expect(args.has('store')).toBe(true);
    expect(args.flag('store')).toBeUndefined();
  });
});

describe('reading a file that is not one', () => {
  it('says so without inventing problems inside it', () => {
    for (const notATheme of [null, 42, 'theme', ['home'], { name: 'my-package' }]) {
      const report = validateTheme(notATheme);

      expect(report.errors.length).toBe(1);
      expect(report.version).toBeNull();
      expect(report.pages).toEqual([]);
    }
  });

  it('refuses a file from a newer platform rather than reading half of it', () => {
    const report = validateTheme({
      storeware: 'theme',
      version: KNOWN_THEME_FILE_VERSION + 1,
      tokens: {},
      templates: {},
    });

    expect(address(report.errors)).toEqual(['version']);
    expect(sentence(report.errors)).toContain('newer version');
  });

  it('wants the two objects the format is made of', () => {
    expect(
      address(validateTheme({ storeware: 'theme', version: 2, templates: {} }).errors),
    ).toEqual(['tokens']);

    expect(address(validateTheme({ storeware: 'theme', version: 2, tokens: {} }).errors)).toEqual([
      'templates',
    ]);
  });
});

describe('reading the tokens', () => {
  const theme = (tokens: Record<string, unknown>) => ({
    storeware: 'theme',
    version: 2,
    tokens,
    templates: {},
  });

  it('names a token no shop is allowed to set', () => {
    const report = validateTheme(theme({ spacing: '4px' }));

    expect(address(report.errors)).toEqual(['tokens.spacing']);
    expect(report.tokens).toEqual({ kept: 0, total: 1 });
  });

  it('refuses a value that would escape the style block', () => {
    const report = validateTheme(theme({ accent: 'red; } body { display: none' }));

    expect(address(report.errors)).toEqual(['tokens.accent']);
  });

  it('reads them one at a time, so one bad colour does not condemn the rest', () => {
    const report = validateTheme(
      theme({ accent: '#ff0000', bg: 'not-a-colour', fg: '#000000', radius: '4px' }),
    );

    expect(address(report.errors)).toEqual(['tokens.bg']);
    expect(report.tokens).toEqual({ kept: 3, total: 4 });
  });
});

describe('reading the pages', () => {
  const theme = (templates: Record<string, unknown>) => ({
    storeware: 'theme',
    version: 2,
    tokens: {},
    templates,
  });

  it('counts what it read against what the file listed', () => {
    const report = validateTheme(
      theme({ home: [{ type: 'intro' }, { type: 'products', limit: 12 }] }),
    );

    expect(report.errors).toEqual([]);
    expect(report.pages).toEqual([{ page: 'home', read: 2, total: 2 }]);
  });

  it('rejects a page the platform does not arrange, and says how many bands went with it', () => {
    const report = validateTheme(theme({ homepage: [{ type: 'intro' }, { type: 'intro' }] }));

    expect(address(report.errors)).toEqual(['templates.homepage']);
    expect(sentence(report.errors)).toContain('Its 2 bands will not be read');
    expect(report.pages).toEqual([]);
  });

  it('rejects a band this platform does not build', () => {
    const report = validateTheme(theme({ home: [{ type: 'sparkles' }] }));

    expect(address(report.errors)).toEqual(['templates.home[0]']);
    expect(sentence(report.errors)).toContain('sparkles is not a band');
  });

  it('rejects a band that may not sit on that page, and says where it may', () => {
    // `intro` is a home band. On a product page the shop drops it silently.
    const report = validateTheme(theme({ product: [{ type: 'intro' }] }));

    expect(address(report.errors)).toEqual(['templates.product[0]']);
    expect(sentence(report.errors)).toContain('They are allowed on: home');
  });

  it('blames the setting rather than the band', () => {
    const report = validateTheme(theme({ home: [{ type: 'products', limit: 900 }] }));

    expect(address(report.errors)).toEqual(['templates.home[0].limit']);
    expect(sentence(report.errors)).toContain('1 to 48');
  });

  it('blames a band id that could never be stored', () => {
    const report = validateTheme(theme({ home: [{ type: 'intro', id: 'NOT AN ID' }] }));

    expect(address(report.errors)).toEqual(['templates.home[0].id']);
  });

  it('orders pages the way the platform declares them, not the way the file happens to', () => {
    const report = validateTheme(
      theme({ article: [{ type: 'article_body' }], home: [{ type: 'intro' }] }),
    );

    expect(report.pages.map((page) => page.page)).toEqual(['home', 'article']);
  });
});

describe('what the shop accepts and then quietly changes', () => {
  const theme = (templates: Record<string, unknown>) => ({
    storeware: 'theme',
    version: 2,
    tokens: {},
    templates,
  });

  it('warns past the twelfth band, which no import report ever mentions', () => {
    const report = validateTheme(
      theme({ home: Array.from({ length: 14 }, () => ({ type: 'products' })) }),
    );

    expect(report.errors).toEqual([]);
    expect(address(report.warnings)).toContain('templates.home');
    expect(sentence(report.warnings)).toContain('The last 2 are dropped');
    expect(sentence(report.warnings)).toContain('does not count them');
  });

  it('does not count a band past the limit as one the shop will place', () => {
    // Otherwise `importReportLines` compares 14 against the 12 the shop placed
    // and reports a version disagreement, for a page that is merely too long.
    const report = validateTheme(
      theme({ home: Array.from({ length: 14 }, () => ({ type: 'products' })) }),
    );

    expect(report.pages).toEqual([{ page: 'home', read: 12, total: 14 }]);
  });

  it('warns about a choice nothing has a branch for, because the band keeps its default', () => {
    const report = validateTheme(theme({ home: [{ type: 'products', preset: 'holographic' }] }));

    // Not an error: an unreadable select falls back to absent rather than
    // taking its whole band off the page.
    expect(report.errors).toEqual([]);
    expect(address(report.warnings)).toEqual(['templates.home[0].preset']);
    expect(sentence(report.warnings)).toContain('grid, rail, mosaic, list');
  });

  it('warns about blocks over the band maximum', () => {
    const report = validateTheme(
      theme({
        home: [
          {
            type: 'multicolumn',
            blocks: Array.from({ length: 6 }, () => ({ type: 'column', heading: 'A' })),
          },
        ],
      }),
    );

    expect(report.errors).toEqual([]);
    expect(sentence(report.warnings)).toContain('6 blocks, and this band holds 4');
  });

  it('warns about a block that does not parse, which never fails its band', () => {
    const report = validateTheme(
      theme({
        home: [
          {
            type: 'multicolumn',
            blocks: [
              { type: 'column', heading: 'Fine' },
              { type: 'column', heading: 12 },
            ],
          },
        ],
      }),
    );

    expect(report.errors).toEqual([]);
    expect(sentence(report.warnings)).toContain('1 of 2 blocks do not parse');
  });

  it('counts the pictures, which only travel back to the shop that made them', () => {
    const report = validateTheme({
      storeware: 'theme',
      version: 2,
      store: 'store_a',
      tokens: {},
      templates: {
        home: [
          {
            type: 'gallery',
            blocks: [{ type: 'image', image: '6f0a1c22-3b4d-4e5f-8a9b-0c1d2e3f4a5b' }],
          },
        ],
      },
    });

    expect(report.pictures).toBe(1);
    expect(report.from).toBe('store_a');
    expect(reportLines(report).join('\n')).toContain(
      'kept only on import back into the shop this came from',
    );
  });

  it('says the pictures are lost when the file does not name the shop it came from', () => {
    const report = validateTheme({
      storeware: 'theme',
      version: 2,
      tokens: {},
      templates: {
        home: [
          {
            type: 'gallery',
            blocks: [{ type: 'image', image: '6f0a1c22-3b4d-4e5f-8a9b-0c1d2e3f4a5b' }],
          },
        ],
      },
    });

    expect(reportLines(report).join('\n')).toContain('they are dropped');
  });
});

describe('the file `theme init` writes', () => {
  const starter = starterTheme('Autumn');

  it('is a theme the platform reads whole', () => {
    const report = validateTheme(starter);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('carries every token a shop may set, at a value the allow-list accepts', () => {
    // The guard on `STARTER_TOKENS` being copied out of the design system
    // rather than imported. A tightened rule fails here, before it reaches
    // somebody scaffolding a theme.
    const report = validateTheme(starter);

    expect(report.tokens.kept).toBe(10);
    expect(report.tokens.total).toBe(10);
  });

  it('is the shop as the platform ships it, so the first change is the only diff', () => {
    expect(starter.templates.home?.map((band) => (band as { type: string }).type)).toEqual([
      'intro',
      'assistant',
      'products',
    ]);

    // A product page defaults to its related products since 2026-09-29, so
    // the scaffold carries that, as the shop would render it.
    expect(starter.templates.product?.map((band) => (band as { type: string }).type)).toEqual([
      'related_products',
    ]);
    // Pages whose default renders nothing are absent rather than empty. An
    // empty array would say "put nothing on this page", which is a decision
    // the scaffold has no business making.
    expect(starter.templates.cart).toBeUndefined();
  });

  it('does not claim to have come from a shop, because it did not', () => {
    expect(starter.store).toBeUndefined();
  });
});

describe('printing what an import did', () => {
  const report = {
    placed: { home: 5, product: 2 },
    skipped: 3,
    picturesDropped: 1,
    tokensDropped: 2,
  };

  it('prints all four numbers, so no loss is left to be inferred', () => {
    const lines = importReportLines(report, 7).join('\n');

    expect(lines).toContain('5 on home');
    expect(lines).toContain('2 on product');
    expect(lines).toContain('skipped       3');
    expect(lines).toContain('pictures      1 dropped');
    expect(lines).toContain('tokens        2 dropped');
  });

  it('says nothing about a disagreement when there is none', () => {
    expect(importReportLines(report, 7).join('\n')).not.toContain('This CLI read');
  });

  it('names which side is behind when the two readings differ', () => {
    expect(importReportLines(report, 9).join('\n')).toContain('The shop is on an older release');
    expect(importReportLines(report, 4).join('\n')).toContain('Update the CLI');
  });

  it('says so plainly when nothing landed', () => {
    const empty = { placed: {}, skipped: 4, picturesDropped: 0, tokensDropped: 0 };

    expect(importReportLines(empty, 0).join('\n')).toContain('placed        nothing');
  });
});

describe('what this package is allowed to depend on', () => {
  /**
   * Read off disk rather than asserted in prose.
   *
   * The CLI may import the theme VOCABULARY and must never import the platform.
   * `@storeware/core` reaches a database, an environment and a network, and a
   * command line that pulled it in would stop being installable by anybody
   * outside this repository -- which would take `theme validate` offline, and
   * with it the only reason the vocabulary was extracted.
   *
   * Matched on the import specifier rather than on the name appearing at all,
   * so that the comment in `theme.ts` explaining why the envelope is restated
   * by hand -- which has to name the package it is avoiding -- does not fail
   * the rule it is explaining.
   */
  const sources = readdirSync(new URL('.', import.meta.url))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));

  it('imports the vocabulary and not the platform', () => {
    for (const source of sources) expect(source).not.toMatch(/from ['"]@storeware\/core/);

    expect(sources.join('\n')).toContain("from '@storeware/theme-schema'");
  });

  // Built into the published CLI (`scripts/build-package.mjs --bin`), so the
  // vocabulary is needed only to build it, and an install pulls in nothing.
  it('builds the vocabulary in and never declares the platform', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

    expect(manifest.devDependencies['@storeware/theme-schema']).toBeDefined();
    // One exception, for `app deploy`: esbuild runs a native binary it finds
    // by path, so it cannot be built in and is installed beside the CLI.
    expect(Object.keys(manifest.dependencies)).toEqual(['esbuild']);
    expect(manifest.devDependencies['@storeware/core']).toBeUndefined();
  });
});
