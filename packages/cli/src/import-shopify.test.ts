import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  parseManifest,
  validateEvents,
  validateScopes,
  type EventAccess,
} from '@storeware/plugin-sdk/manifest';
import {
  DOCS,
  docsUrl,
  ImportError,
  importShopify,
  parsePlans,
  reportLines,
  runImportShopify,
  SHOPIFY_APP_TOPICS,
  SHOPIFY_COMPLIANCE_TOPICS,
  SHOPIFY_SCOPES,
  SHOPIFY_TOPICS,
  TOPIC_SCOPES,
  type ImportResult,
} from './import-shopify';

/**
 * `app import-shopify`, held to the platform it writes for.
 *
 * The scope and topic tables are pinned in the CLI, which cannot import core,
 * so the platform's own catalogue is loaded here from source and every name
 * the import writes is checked against it. The written manifest goes through
 * the SDK's parser and the same scope and event checks `storeware validate`
 * runs when signed in.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/shopify-app', import.meta.url));
const SHOPIFY_TOML = join(FIXTURE, 'shopify.app.toml');
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** A docs path is a page when its .mdx, or a folder's index.mdx, exists. */
function docsPageExists(path: string): boolean {
  const base = join(REPO, 'apps/docs/content/docs', path);
  return existsSync(`${base}.mdx`) || existsSync(join(base, 'index.mdx'));
}

interface Catalogue {
  scopes: readonly string[];
  events: EventAccess[];
}

/**
 * The platform's scopes and topics, from core's source. Imported by a path
 * built at run time, so the CLI's type check (rooted at `src`) never follows
 * it into core.
 */
async function platform(): Promise<Catalogue> {
  const load = (path: string) => import(new URL(path, import.meta.url).href) as Promise<unknown>;
  const scopes = (await load('../../core/src/auth/scopes.ts')) as { SCOPES: readonly string[] };
  const events = (await load('../../core/src/events/catalogue.ts')) as {
    eventAccessCatalogue: () => EventAccess[];
  };
  return { scopes: scopes.SCOPES, events: events.eventAccessCatalogue() };
}

let catalogue: Catalogue;
beforeAll(async () => {
  catalogue = await platform();
});

const unmappedItems = (result: ImportResult) => result.unmapped.map((u) => u.item);

/** The manifest with the TODO prices filled in, as a developer would. */
function filled(text: string): string {
  return text
    .replace(/^# gbp = 0$/gm, 'gbp = 799')
    .replace(/^# eur = 0$/gm, 'eur = 899')
    .replace(/^# inr = 0$/gm, 'inr = 79900');
}

describe('the tables', () => {
  it('names only scopes the platform has, and none withheld from apps', () => {
    const known = new Set(catalogue.scopes);
    for (const [shopify, rule] of Object.entries(SHOPIFY_SCOPES)) {
      if (rule.to) {
        expect(known.has(rule.to), `${shopify} maps to ${rule.to}`).toBe(true);
        expect(rule.to).not.toMatch(/^(plugins|developer|earnings):/);
      } else {
        expect(rule.reason, shopify).toBeTruthy();
      }
    }
  });

  it('names only topics the platform sends, with the scopes the platform asks for', () => {
    const byTopic = new Map(catalogue.events.map((e) => [e.topic, [...e.anyOf]]));
    for (const [topic, anyOf] of Object.entries(TOPIC_SCOPES)) {
      expect(byTopic.get(topic), topic).toEqual([...anyOf]);
    }
    for (const to of Object.values(SHOPIFY_TOPICS)) expect(TOPIC_SCOPES[to]).toBeDefined();
  });

  it('keeps app and compliance topics out of the subscribable ones', () => {
    for (const topic of [
      ...Object.keys(SHOPIFY_APP_TOPICS),
      ...Object.keys(SHOPIFY_COMPLIANCE_TOPICS),
    ]) {
      expect(SHOPIFY_TOPICS[topic]).toBeUndefined();
    }
  });

  it('points only at docs pages that exist', () => {
    for (const [name, path] of Object.entries(DOCS)) {
      expect(docsPageExists(path), `${name}: ${path}`).toBe(true);
    }
    for (const rule of Object.values(SHOPIFY_SCOPES)) {
      if (rule.docs) expect(docsPageExists(rule.docs), rule.docs).toBe(true);
    }
  });
});

describe('importing the sample app', () => {
  let result: ImportResult;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-shopify-'));
    cpSync(FIXTURE, dir, { recursive: true });
    result = (await runImportShopify({ cwd: dir, plans: 'plans.json' })).result;
  });

  it('writes a file the SDK parses, once the TODO prices are filled in', () => {
    expect(
      result.manifestText.startsWith(
        '#:schema https://storeware.ai/docs/schemas/storeware.app.json\n',
      ),
    ).toBe(true);
    // As written, the three missing currencies stop it, and the report says so.
    expect(() => parseManifest(result.manifestText)).toThrow(/billing\.plans\.1\.prices\.gbp/);
    expect(result.attention.some((s) => s.includes('Plan pro has only its USD price'))).toBe(true);

    const manifest = parseManifest(filled(result.manifestText));
    expect(manifest.manifest_version).toBe(2);
    validateScopes(manifest, catalogue.scopes);
    validateEvents(manifest, catalogue.events);
  });

  it('maps identity, the home and its navigation', () => {
    const manifest = parseManifest(filled(result.manifestText));
    expect(manifest.app).toMatchObject({
      slug: 'size-guide-pro',
      name: 'Size Guide Pro',
      url: 'https://sizeguide.example.com',
      navigation: [
        { label: 'Charts', path: '/charts' },
        { label: 'Settings', path: '/settings' },
      ],
    });
    // Shopify's client id is never reused as the slug.
    expect(result.manifestText).not.toContain('8f3c2a9d1e7b4c6a5f0e9d8c7b6a5f4e');
  });

  it('maps each scope with an equivalent, and lists the one without', () => {
    const manifest = parseManifest(filled(result.manifestText));
    expect(manifest.oauth.scopes).toEqual([
      'products:read',
      'products:write',
      'orders:read',
      'customers:read',
      'stores:read',
    ]);
    expect(unmappedItems(result)).toContain('read_markets');
    expect(unmappedItems(result)).toContain('optional scope read_discounts');
    expect(manifest.oauth.redirect_uris).toHaveLength(3);
  });

  it('maps webhooks to one url and its events, and compliance to [privacy]', () => {
    const manifest = parseManifest(filled(result.manifestText));
    expect(manifest.webhooks).toEqual({
      url: 'https://sizeguide.example.com/webhooks/app',
      events: [
        'product.updated.v1',
        'product.created.v1',
        'order.paid.v1',
        'inventory.adjusted.v1',
      ],
    });
    expect(manifest.privacy).toEqual({ url: 'https://sizeguide.example.com/webhooks/compliance' });
    expect(result.mapped).toContainEqual(
      expect.objectContaining({ from: 'app/uninstalled', to: 'app.uninstalled.v1' }),
    );
    expect(unmappedItems(result)).toEqual(
      expect.arrayContaining(['webhook shop/update', 'webhook products/delete']),
    );
  });

  it('maps the app proxy, and says where shoppers now reach it', () => {
    const manifest = parseManifest(filled(result.manifestText));
    expect(manifest.app_proxy).toEqual({ url: 'https://sizeguide.example.com/proxy' });
    expect(result.attention).toContainEqual(
      expect.stringContaining('/apps/size-guide-pro, not /apps/size-guide'),
    );
  });

  it('maps plans to managed billing, in dollars, with the other currencies left to fill', () => {
    const manifest = parseManifest(filled(result.manifestText));
    expect(manifest.billing?.mode).toBe('managed');
    expect(manifest.billing?.plans).toEqual([
      expect.objectContaining({ key: 'starter', interval: 'month', trial_days: 0 }),
      expect.objectContaining({
        key: 'pro',
        interval: 'month',
        trial_days: 14,
        prices: { usd: 999, gbp: 799, eur: 899, inr: 79900 },
        features: ['Unlimited size charts', 'Fit notes on every product'],
      }),
      expect.objectContaining({
        key: 'pro_yearly',
        interval: 'year',
        prices: expect.objectContaining({ usd: 9900 }),
      }),
    ]);
    expect(manifest.billing?.plans[0]?.prices).toBeUndefined();
  });

  it('lists everything with no equivalent, each with a docs page that exists', () => {
    const items = unmappedItems(result);
    expect(items).toEqual(
      expect.arrayContaining([
        '[pos] embedded',
        expect.stringMatching(/^\[build\] /),
        'extension bundle-discount (function)',
        'extension Size chart block (theme)',
      ]),
    );
    expect(result.unmapped.find((u) => u.item.includes('(function)'))?.docs).toBe(DOCS.functions);
    expect(result.unmapped.find((u) => u.item.includes('(theme)'))?.docs).toBe(DOCS.storefront);
    for (const item of result.unmapped) {
      expect(docsPageExists(item.docs), `${item.item}: ${item.docs}`).toBe(true);
    }
  });

  it('prints plain sentences, with no dash standing in for punctuation', () => {
    const text = reportLines(result, 'storeware.app.toml').join('\n');
    expect(text).toContain('No Storeware equivalent');
    expect(text).toContain(docsUrl(DOCS.comingFromShopify));
    const prose = [
      text,
      result.manifestText,
      ...result.unmapped.map((u) => u.reason),
      ...result.attention,
    ].join('\n');
    expect(prose).not.toMatch(/[—–]| - |!/);
  });
});

describe('what the import will not do', () => {
  const base = {
    name: 'Fit',
    handle: 'fit',
    application_url: 'https://fit.example.com',
    access_scopes: { scopes: 'read_orders' },
  };

  it('does not widen scopes to cover an event, and says why validate will refuse it', () => {
    const result = importShopify({
      ...base,
      webhooks: {
        subscriptions: [{ topics: ['products/update'], uri: 'https://fit.example.com/hooks' }],
      },
    });
    const manifest = parseManifest(result.manifestText);
    expect(manifest.oauth.scopes).toEqual(['orders:read']);
    expect(result.attention).toContainEqual(
      expect.stringContaining('product.updated.v1 needs products:read'),
    );
    expect(() => validateEvents(manifest, catalogue.events)).toThrow(/products:read/);
  });

  it('uses the first address for events, and notes the rest', () => {
    const result = importShopify({
      ...base,
      webhooks: {
        subscriptions: [
          { topics: ['orders/paid'], uri: 'https://fit.example.com/a' },
          { topics: ['orders/create'], uri: 'https://fit.example.com/b' },
          { topics: ['orders/cancelled'], uri: 'pubsub://project:topic' },
        ],
      },
    });
    expect(parseManifest(result.manifestText).webhooks?.url).toBe('https://fit.example.com/a');
    expect(result.attention).toContainEqual(
      expect.stringContaining('Not used: https://fit.example.com/b'),
    );
    expect(unmappedItems(result)).toContain('webhook uri pubsub://project:topic');
  });

  it('asks for [privacy] when the app reads orders and had no compliance topics', () => {
    const result = importShopify(base);
    expect(result.attention).toContainEqual(expect.stringContaining('Add [privacy] url'));
  });

  it('leaves [webhooks] commented out when only app topics were subscribed', () => {
    const result = importShopify({
      ...base,
      webhooks: { subscriptions: [{ topics: ['app/uninstalled'], uri: '/webhooks' }] },
    });
    expect(result.manifestText).toContain('# [webhooks]');
    expect(parseManifest(result.manifestText).webhooks).toBeUndefined();
  });

  it('derives the slug from the name when there is no handle', () => {
    const { handle: _handle, ...unnamed } = base;
    expect(importShopify({ ...unnamed, name: 'Fit & Finish Pro' }).slug).toBe('fit-finish-pro');
  });

  it('refuses a plans file it cannot read plainly', () => {
    expect(() =>
      parsePlans({ plans: [{ name: 'Pro', amount: 5, interval: 'EVERY_DAY' }] }),
    ).toThrow(ImportError);
    expect(() => parsePlans({ plans: [{ name: 'Pro', amount: 5, currency: 'EUR' }] })).toThrow(
      /USD/,
    );
  });
});

describe('the command', () => {
  it('writes storeware.app.toml beside the Shopify file, and refuses to replace it without --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-shopify-'));
    cpSync(SHOPIFY_TOML, join(dir, 'shopify.app.toml'));

    const first = await runImportShopify({ cwd: dir });
    expect(first.out).toBe(join(dir, 'storeware.app.toml'));
    expect(readFileSync(first.out, 'utf8')).toBe(first.result.manifestText);

    writeFileSync(first.out, 'kept\n');
    await expect(runImportShopify({ cwd: dir })).rejects.toThrow(/--force/);
    expect(readFileSync(first.out, 'utf8')).toBe('kept\n');

    await runImportShopify({ cwd: dir, force: true });
    expect(readFileSync(first.out, 'utf8')).toBe(first.result.manifestText);
  });

  it('reads --from and writes --out where it is told', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-shopify-'));
    const ran = await runImportShopify({ cwd: dir, from: SHOPIFY_TOML, out: 'out/../app.toml' });
    expect(ran.out).toBe(join(dir, 'app.toml'));
    expect(parseManifest(ran.result.manifestText).app.slug).toBe('size-guide-pro');
  });

  it('says plainly when there is no Shopify file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-shopify-'));
    await expect(runImportShopify({ cwd: dir })).rejects.toThrow(/No shopify\.app\.toml/);
  });
});
