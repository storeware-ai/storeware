import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * `storeware app import-shopify`: a Shopify app's `shopify.app.toml`, read and
 * written out again as a `storeware.app.toml`.
 *
 * The mapping is a pure function, `importShopify`, from the parsed Shopify file
 * to the text of the new manifest and three lists: what mapped, what has no
 * equivalent (each with the docs page that covers it), and what the developer
 * has to look at before `storeware validate` passes. `runImportShopify` is the
 * file handling around it, and `reportLines` is what the command prints.
 *
 * ## Why the tables are written out
 *
 * Every Storeware scope and topic named here is held against the platform's
 * own catalogue (`packages/core/src/auth/scopes.ts` and
 * `packages/core/src/events/catalogue.ts`) by `import-shopify.test.ts`, which
 * reads them from source. The CLI cannot import core: it is published on its
 * own. A Shopify name missing from these tables is never guessed at; it goes on
 * the list of things with no equivalent.
 *
 * ## Why nothing is widened
 *
 * A Shopify app asking for `read_orders` and subscribing to `products/update`
 * would be refused here too, because a Storeware event needs a scope that reads
 * the same data. The import says so and leaves the scope list as the developer
 * wrote it. Adding a scope quietly would change what a merchant is asked to
 * approve, which is the developer's decision to make.
 */

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export const DOCS_ORIGIN = 'https://storeware.ai/docs';

/** Docs pages, relative to the docs' root, as `commands.ts` writes guides. */
export const DOCS = {
  comingFromShopify: '/get-started/coming-from-shopify',
  quickstart: '/get-started/quickstart',
  manifest: '/build-apps/manifest',
  installs: '/build-apps/installs-and-tokens',
  hosting: '/build-apps/hosting',
  functions: '/build-apps/checkout-functions',
  storefront: '/extensions/storefront',
  admin: '/extensions/admin',
  automations: '/extensions/automations',
  appProxy: '/extensions/app-proxy',
  settings: '/extensions/settings',
  webhooks: '/webhooks',
  billing: '/selling/billing',
} as const;

export type DocsPath = (typeof DOCS)[keyof typeof DOCS];

export function docsUrl(path: DocsPath): string {
  return `${DOCS_ORIGIN}${path}`;
}

/** One thing that came across, and where it went. */
export interface Mapped {
  from: string;
  to: string;
  note?: string;
}

/** One thing with no Storeware equivalent, and the page that covers it. */
export interface Unmapped {
  item: string;
  reason: string;
  docs: DocsPath;
}

export interface ImportResult {
  manifestText: string;
  slug: string;
  mapped: Mapped[];
  unmapped: Unmapped[];
  /** Sentences the developer has to act on. `validate` may refuse the file until they do. */
  attention: string[];
}

/** One Shopify extension, from `[[extensions]]` or an `extensions/<name>/shopify.extension.toml`. */
export interface ShopifyExtension {
  type?: string;
  name?: string;
  handle?: string;
  targeting?: { target?: string; url?: string; module?: string }[];
  /** Where it was read from, for the report. */
  source?: string;
}

/** A plan from `--plans`, in the shape Shopify's managed pricing uses. */
export interface ShopifyPlan {
  name: string;
  /** In US dollars, such as 9.99. Absent or 0 for a free plan. */
  amount?: number;
  interval: 'EVERY_30_DAYS' | 'ANNUAL';
  trial_days?: number;
  features?: string[];
  capped_amount?: number;
  terms?: string;
}

export interface ImportOptions {
  extensions?: readonly ShopifyExtension[];
  plans?: readonly ShopifyPlan[];
  /** The file the manifest was made from, named in its header. */
  sourceName?: string;
}

/* ------------------------------------------------------------------------ */
/* Scopes                                                                    */
/* ------------------------------------------------------------------------ */

interface ScopeRule {
  to?: string;
  note?: string;
  reason?: string;
  docs?: DocsPath;
}

const both = (resource: string, read: string, write: string, note?: string) =>
  ({
    [`read_${resource}`]: { to: read, ...(note ? { note } : {}) },
    [`write_${resource}`]: { to: write, ...(note ? { note } : {}) },
  }) as Record<string, ScopeRule>;

const none = (resource: string, reason: string, docs: DocsPath = DOCS.comingFromShopify) =>
  ({
    [`read_${resource}`]: { reason, docs },
    [`write_${resource}`]: { reason, docs },
  }) as Record<string, ScopeRule>;

/**
 * Each Shopify access scope, and the Storeware scope that grants the same.
 *
 * A Storeware write covers its read, as a Shopify one does. Where Storeware
 * keeps the data under a resource with another name (stock under products,
 * returns and fulfilment under orders), the scope is that resource's, because
 * that is what the API asks for before handing the same data over.
 */
export const SHOPIFY_SCOPES: Readonly<Record<string, ScopeRule>> = {
  ...both('products', 'products:read', 'products:write'),
  ...both('inventory', 'products:read', 'products:write', 'Stock is part of products here.'),
  ...both('orders', 'orders:read', 'orders:write'),
  read_all_orders: { to: 'orders:read', note: 'Every order, with no 60 day window.' },
  ...both('draft_orders', 'orders:read', 'orders:write', 'Drafts are quotes here.'),
  ...both('order_edits', 'orders:read', 'orders:write'),
  ...both('fulfillments', 'orders:read', 'orders:write'),
  ...both('assigned_fulfillment_orders', 'orders:read', 'orders:write'),
  ...both('merchant_managed_fulfillment_orders', 'orders:read', 'orders:write'),
  ...both('third_party_fulfillment_orders', 'orders:read', 'orders:write'),
  ...both('returns', 'orders:read', 'orders:write'),
  ...both('gift_cards', 'orders:read', 'orders:write'),
  read_checkouts: { to: 'orders:read', note: 'Baskets are read with orders:read.' },
  write_checkouts: {
    reason: 'An app does not change a shopper’s basket here. Checkout functions shape it.',
    docs: DOCS.functions,
  },
  read_shopify_payments_disputes: { to: 'orders:read' },
  read_shopify_payments_payouts: { to: 'payments:read' },
  ...both('customers', 'customers:read', 'customers:write'),
  ...both('companies', 'companies:read', 'companies:write'),
  ...both('discounts', 'discounts:read', 'discounts:write'),
  ...both('price_rules', 'discounts:read', 'discounts:write'),
  ...both('own_subscription_contracts', 'subscriptions:read', 'subscriptions:write'),
  ...both('purchase_options', 'subscriptions:read', 'subscriptions:write'),
  ...both('content', 'content:read', 'content:write'),
  ...both('online_store_pages', 'content:read', 'content:write'),
  ...both('online_store_navigation', 'content:read', 'content:write'),
  ...both('legal_policies', 'content:read', 'content:write'),
  read_themes: { to: 'stores:read' },
  write_themes: {
    to: 'stores:write',
    note: 'It also configures the shop, which is more than themes.',
  },
  read_shipping: { to: 'stores:read' },
  write_shipping: {
    to: 'stores:write',
    note: 'It also configures the shop, which is more than shipping.',
  },
  read_analytics: { to: 'analytics:read' },
  read_reports: { to: 'analytics:read' },
  write_reports: { reason: 'Reports are read only here.', docs: DOCS.comingFromShopify },
  read_users: { to: 'staff:read' },
  ...none(
    'script_tags',
    'Scripts are not injected into a shop here. Use storefront blocks and sections.',
    DOCS.storefront,
  ),
  ...none('cart_transforms', 'Write a checkout function instead.', DOCS.functions),
  ...none('validations', 'Write a cart_validation checkout function instead.', DOCS.functions),
  ...none('payment_customizations', 'Write a payment_methods checkout function.', DOCS.functions),
  ...none('delivery_customizations', 'Write a delivery_rates checkout function.', DOCS.functions),
  ...none('locations', 'No equivalent scope. Stock is read with products:read.'),
  ...none('product_listings', 'No sales channels for apps. products:read reads the catalogue.'),
  ...none('publications', 'No sales channels for apps.'),
  ...none('markets', 'No equivalent scope.'),
  ...none('locales', 'No equivalent scope.'),
  ...none('translations', 'No equivalent scope.'),
  ...none('marketing_events', 'No equivalent scope.'),
  ...none('metaobjects', 'No metaobjects. An app declares its own fields under [metafields].'),
  ...none('metaobject_definitions', 'No metaobjects. Declare fields under [metafields].'),
  ...none('files', 'No equivalent scope.'),
  ...none('pixels', 'No web pixels.'),
  ...none('customer_events', 'No web pixels.'),
  ...none('payment_terms', 'No equivalent scope.'),
  ...none('customer_merge', 'No equivalent scope.'),
  ...none('store_credit_account_transactions', 'No equivalent scope.'),
};

/* ------------------------------------------------------------------------ */
/* Webhook topics                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Each Storeware topic named below, with the scopes any one of which lets an
 * app hear it. Mirrors `topicAccess` in `packages/core/src/events/catalogue.ts`;
 * the test holds the two together.
 */
export const TOPIC_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'product.created.v1': ['products:read'],
  'product.updated.v1': ['products:read'],
  'collection.created.v1': ['products:read'],
  'collection.updated.v1': ['products:read'],
  'collection.deleted.v1': ['products:read'],
  'inventory.adjusted.v1': ['products:read'],
  'checkout.started.v1': ['orders:read'],
  'checkout.updated.v1': ['orders:read'],
  'order.created.v1': ['orders:read'],
  'order.paid.v1': ['orders:read'],
  'order.canceled.v1': ['orders:read'],
  'order.changed.v1': ['orders:read'],
  'order.refunded.v1': ['orders:read'],
  'order.disputed.v1': ['orders:read'],
  'fulfillment.created.v1': ['orders:read'],
  'fulfillment.updated.v1': ['orders:read'],
  'return.requested.v1': ['orders:read'],
  'return.approved.v1': ['orders:read'],
  'return.declined.v1': ['orders:read'],
  'return.resolved.v1': ['orders:read'],
  'return.canceled.v1': ['orders:read'],
  'gift_card.issued.v1': ['orders:read', 'customers:read'],
  'subscription.created.v1': ['subscriptions:read'],
  'subscription.updated.v1': ['subscriptions:read'],
  'subscription.paused.v1': ['subscriptions:read'],
  'subscription.resumed.v1': ['subscriptions:read'],
  'subscription.canceled.v1': ['subscriptions:read'],
  'subscription.expired.v1': ['subscriptions:read'],
  'subscription.charged.v1': ['subscriptions:read'],
  'subscription.payment_failed.v1': ['subscriptions:read'],
  'subscription.skipped.v1': ['subscriptions:read'],
  'company.created.v1': ['companies:read'],
  'company.updated.v1': ['companies:read'],
  'theme.published.v1': ['stores:read'],
};

/** Shopify webhook topics a manifest can subscribe to, and their Storeware topic. */
export const SHOPIFY_TOPICS: Readonly<Record<string, keyof typeof TOPIC_SCOPES>> = {
  'products/create': 'product.created.v1',
  'products/update': 'product.updated.v1',
  'collections/create': 'collection.created.v1',
  'collections/update': 'collection.updated.v1',
  'collections/delete': 'collection.deleted.v1',
  'inventory_levels/update': 'inventory.adjusted.v1',
  'checkouts/create': 'checkout.started.v1',
  'checkouts/update': 'checkout.updated.v1',
  'orders/create': 'order.created.v1',
  'orders/paid': 'order.paid.v1',
  'orders/cancelled': 'order.canceled.v1',
  'orders/edited': 'order.changed.v1',
  'refunds/create': 'order.refunded.v1',
  'disputes/create': 'order.disputed.v1',
  'fulfillments/create': 'fulfillment.created.v1',
  'fulfillments/update': 'fulfillment.updated.v1',
  'returns/request': 'return.requested.v1',
  'returns/approve': 'return.approved.v1',
  'returns/decline': 'return.declined.v1',
  'returns/close': 'return.resolved.v1',
  'returns/cancel': 'return.canceled.v1',
  'gift_cards/create': 'gift_card.issued.v1',
  'subscription_contracts/create': 'subscription.created.v1',
  'subscription_contracts/update': 'subscription.updated.v1',
  'subscription_contracts/pause': 'subscription.paused.v1',
  'subscription_contracts/activate': 'subscription.resumed.v1',
  'subscription_contracts/cancel': 'subscription.canceled.v1',
  'subscription_contracts/expire': 'subscription.expired.v1',
  'subscription_billing_attempts/success': 'subscription.charged.v1',
  'subscription_billing_attempts/failure': 'subscription.payment_failed.v1',
  'subscription_billing_cycles/skip': 'subscription.skipped.v1',
  'companies/create': 'company.created.v1',
  'companies/update': 'company.updated.v1',
  'themes/publish': 'theme.published.v1',
};

/**
 * Shopify topics about the app itself. Storeware sends their equivalents to
 * `[webhooks] url` without a subscription, and a manifest may not name them.
 */
export const SHOPIFY_APP_TOPICS: Readonly<Record<string, string>> = {
  'app/uninstalled': 'app.uninstalled.v1',
  'app/scopes_update': 'app.scopes_changed.v1',
  'app_subscriptions/update': 'app_subscription.updated.v1',
  'app_subscriptions/approaching_capped_amount': 'app_usage.cap_approaching.v1',
  'app_purchases_one_time/update': 'app_purchase.accepted.v1 and app_purchase.declined.v1',
};

/** Shopify's mandatory compliance topics. Storeware posts all three to `[privacy] url`. */
export const SHOPIFY_COMPLIANCE_TOPICS: Readonly<Record<string, string>> = {
  'customers/data_request': 'compliance.customer_data_requested.v1',
  'customers/redact': 'compliance.customer_redacted.v1',
  'shop/redact': 'compliance.store_redacted.v1',
};

/** Hints for topics people often subscribe to that have no exact match. */
const TOPIC_HINTS: Readonly<Record<string, string>> = {
  'products/delete': 'Products are archived here, not deleted. See product.archived.v1.',
  'orders/updated': 'No catch all. order.changed.v1 and order.adjusted.v1 cover edits and money.',
  'orders/fulfilled': 'Listen for fulfillment.created.v1 instead.',
  'customers/create': 'No customer events beyond erasure and consent.',
  'customers/update': 'No customer events beyond erasure and consent.',
  'customers/delete': 'No customer events beyond erasure and consent.',
};

/* ------------------------------------------------------------------------ */
/* The rest                                                                  */
/* ------------------------------------------------------------------------ */

/** Shopify checkout function extension types. */
const FUNCTION_TYPES = new Set([
  'function',
  'product_discounts',
  'order_discounts',
  'shipping_discounts',
  'discount',
  'cart_transform',
  'cart_checkout_validation',
  'delivery_customization',
  'payment_customization',
  'fulfillment_constraints',
  'order_routing_location_rule',
]);

/** Top level keys of shopify.app.toml this import reads. Anything else is reported. */
const KNOWN_KEYS = new Set([
  'client_id',
  'name',
  'handle',
  'application_url',
  'embedded',
  'extension_directories',
  'web_directories',
  'access_scopes',
  'auth',
  'webhooks',
  'app_proxy',
  'pos',
  'build',
  'access',
  'app_preferences',
  'extensions',
]);

const RESERVED_SLUGS = new Set(['merchant', 'metafields', 'shopify', 'storeware']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const APP_PATH = /^\/[A-Za-z0-9._~/-]*$/;
const MAX_NAVIGATION = 5;
const MAX_PLANS = 6;

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(str).filter((v): v is string => v !== undefined) : [];

/** `"read_products, write_products"` or `["read_products"]`, as a list. */
function scopeList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return strings(value);
}

/** Https anywhere, http only on localhost: what the manifest accepts. */
export function storewareUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (local && url.protocol === 'http:');
  } catch {
    return false;
  }
}

/** A URL from Shopify's file, relative ones read against the app's own. */
function absolute(value: string, base: string | undefined): string | undefined {
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

function planKey(name: string): string {
  let key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(key)) key = `plan_${key}`;
  return key.slice(0, 32).replace(/_+$/, '').padEnd(2, '_');
}

/** A TOML basic string. JSON's escapes are all TOML escapes too. */
const q = (value: string) => JSON.stringify(value);

function tomlArray(values: readonly string[]): string {
  const one = `[${values.map(q).join(', ')}]`;
  if (one.length <= 80) return one;
  return `[\n${values.map((v) => `  ${q(v)},`).join('\n')}\n]`;
}

/** The path inside the app's home an admin link opens, or undefined when it leaves the app. */
function appPath(url: string, appUrl: string | undefined): string | undefined {
  let path: string | undefined;
  if (url.startsWith('app://')) path = `/${url.slice('app://'.length).replace(/^\/+/, '')}`;
  else if (url.startsWith('/')) path = url;
  else if (appUrl) {
    try {
      const target = new URL(url);
      const home = new URL(appUrl);
      if (target.origin === home.origin) path = target.pathname;
    } catch {
      path = undefined;
    }
  }
  if (path === undefined) return undefined;
  path = path.split(/[?#]/)[0] ?? path;
  return APP_PATH.test(path) && !path.includes('..') && !path.startsWith('//') ? path : undefined;
}

/** Where an extension of a Shopify type is covered in the Storeware docs. */
function extensionDocs(extension: ShopifyExtension): { reason: string; docs: DocsPath } {
  const type = extension.type ?? 'unknown';
  const targets = (extension.targeting ?? []).map((t) => t.target ?? '');
  const anyTarget = (prefix: string) => targets.some((t) => t.startsWith(prefix));
  if (type === 'theme' || type === 'theme_app_extension') {
    return {
      reason: 'App blocks and app embeds become storefront blocks and sections.',
      docs: DOCS.storefront,
    };
  }
  if (FUNCTION_TYPES.has(type)) {
    return {
      reason: 'Shopify Functions become checkout functions, written in TypeScript in a hosted app.',
      docs: DOCS.functions,
    };
  }
  if (type.startsWith('flow_')) {
    return {
      reason: 'Flow triggers and actions become [automations] triggers and actions.',
      docs: DOCS.automations,
    };
  }
  if (anyTarget('pos.') || type.startsWith('pos_')) {
    return { reason: 'No point of sale extensions.', docs: DOCS.comingFromShopify };
  }
  if (
    anyTarget('purchase.') ||
    anyTarget('customer-account.') ||
    type.startsWith('checkout_') ||
    type === 'customer_accounts_ui_extension'
  ) {
    return {
      reason: 'No checkout or customer account UI extensions. Checkout functions shape checkout.',
      docs: DOCS.comingFromShopify,
    };
  }
  if (type === 'web_pixel_extension') {
    return { reason: 'No web pixels.', docs: DOCS.comingFromShopify };
  }
  if (anyTarget('admin.') || type.startsWith('admin_') || type === 'ui_extension') {
    return {
      reason:
        'Admin actions and blocks become [[extensions.admin]] panels, which load a page of yours.',
      docs: DOCS.admin,
    };
  }
  return { reason: 'No equivalent extension type.', docs: DOCS.comingFromShopify };
}

function isAdminLink(extension: ShopifyExtension): boolean {
  return (
    extension.type === 'admin_link' ||
    (extension.targeting ?? []).some((t) => (t.target ?? '').endsWith('.link'))
  );
}

/** Reads `[[extensions]]` entries, from shopify.app.toml or an extension's own file. */
export function extensionsIn(source: unknown, origin?: string): ShopifyExtension[] {
  if (!isTable(source)) return [];
  const list = Array.isArray(source.extensions) ? source.extensions : [source];
  return list.filter(isTable).map((entry) => ({
    ...(str(entry.type) ? { type: str(entry.type)! } : {}),
    ...(str(entry.name) ? { name: str(entry.name)! } : {}),
    ...(str(entry.handle) ? { handle: str(entry.handle)! } : {}),
    targeting: (Array.isArray(entry.targeting) ? entry.targeting : []).filter(isTable).map((t) => ({
      ...(str(t.target) ? { target: str(t.target)! } : {}),
      ...(str(t.url) ? { url: str(t.url)! } : {}),
      ...(str(t.module) ? { module: str(t.module)! } : {}),
    })),
    ...(origin ? { source: origin } : {}),
  }));
}

/** Checks a `--plans` file's contents, and says plainly what is wrong. */
export function parsePlans(raw: unknown): ShopifyPlan[] {
  const list = Array.isArray(raw) ? raw : isTable(raw) ? raw.plans : undefined;
  if (!Array.isArray(list)) {
    throw new ImportError('The plans file holds a list of plans, or { "plans": [...] }.');
  }
  return list.map((entry, index) => {
    const at = `Plan ${index + 1}`;
    if (!isTable(entry)) throw new ImportError(`${at} is not an object.`);
    const name = str(entry.name);
    if (!name) throw new ImportError(`${at} has no name.`);
    const currency = str(entry.currency);
    if (currency && currency.toUpperCase() !== 'USD') {
      throw new ImportError(`${name} is priced in ${currency}. Give the amount in USD.`);
    }
    const amount = typeof entry.amount === 'string' ? Number(entry.amount) : (entry.amount ?? 0);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new ImportError(`${name} has an amount that is not a number of dollars.`);
    }
    const interval = str(entry.interval) ?? 'EVERY_30_DAYS';
    if (interval !== 'EVERY_30_DAYS' && interval !== 'ANNUAL') {
      throw new ImportError(`${name} has interval ${interval}. Use EVERY_30_DAYS or ANNUAL.`);
    }
    const trial = entry.trial_days ?? 0;
    if (typeof trial !== 'number' || !Number.isInteger(trial) || trial < 0) {
      throw new ImportError(`${name} has trial_days that is not a whole number.`);
    }
    const capped = entry.capped_amount;
    return {
      name,
      amount,
      interval,
      trial_days: trial,
      features: strings(entry.features),
      ...(typeof capped === 'number' ? { capped_amount: capped } : {}),
      ...(str(entry.terms) ? { terms: str(entry.terms)! } : {}),
    };
  });
}

/* ------------------------------------------------------------------------ */
/* The mapping                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Maps a parsed shopify.app.toml to a storeware.app.toml.
 *
 * Pure: the same input gives the same text, and nothing is read or written.
 */
export function importShopify(shopify: unknown, options: ImportOptions = {}): ImportResult {
  if (!isTable(shopify)) throw new ImportError('shopify.app.toml holds no settings.');
  const mapped: Mapped[] = [];
  const unmapped: Unmapped[] = [];
  const attention: string[] = [];
  const map = (from: string, to: string, note?: string) =>
    mapped.push({ from, to, ...(note ? { note } : {}) });
  const skip = (item: string, reason: string, docs: DocsPath) =>
    unmapped.push({ item, reason, docs });

  /* [app] ---------------------------------------------------------------- */

  const name = str(shopify.name);
  if (!name) throw new ImportError('shopify.app.toml has no name.');
  map('name', '[app] name');

  const handle = str(shopify.handle);
  let slug = handle ?? slugify(name);
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) {
    attention.push(
      `${handle ? 'handle' : 'name'} gives the slug "${slug}", which Storeware does not accept. ` +
        'Set [app] slug to 2 to 63 lower case letters, digits and hyphens.',
    );
    slug = 'my-app';
  }
  map(handle ? 'handle' : 'name', `[app] slug ${slug}`);

  if (str(shopify.client_id)) {
    map(
      'client_id',
      'Not carried over',
      'Your slug is your client id here, and Storeware makes your client secret.',
    );
  }

  const applicationUrl = str(shopify.application_url);
  const embedded = shopify.embedded !== false;
  let appUrl: string | undefined;
  let homepageUrl: string | undefined;
  if (applicationUrl) {
    if (!storewareUrl(applicationUrl)) {
      attention.push(
        `application_url is ${applicationUrl}. Storeware needs https, except on localhost. Set [app] url by hand.`,
      );
    } else if (embedded) {
      appUrl = applicationUrl;
      map('application_url', '[app] url', 'Your home inside the admin, framed full height.');
    } else {
      homepageUrl = applicationUrl;
      map(
        'application_url',
        '[app] homepage_url',
        'Your app is not embedded, so it is your homepage, not a page in the admin.',
      );
    }
    const host = (() => {
      try {
        return new URL(applicationUrl).hostname;
      } catch {
        return '';
      }
    })();
    if (
      /(^|\.)(trycloudflare\.com|ngrok\.io|ngrok-free\.app|ngrok\.app|shopify\.dev)$/.test(host)
    ) {
      attention.push(
        `application_url points at ${host}, which looks like a development address. ` +
          'Put your production URL in the manifest. storeware app dev runs its own tunnel.',
      );
    }
  }
  if (shopify.embedded !== undefined) {
    map('embedded', embedded ? '[app] url' : '[app] homepage_url');
  }

  /* Navigation: admin links and app preferences --------------------------- */

  const navigation: { label: string; path: string }[] = [];
  const extensions = [
    ...extensionsIn({ extensions: shopify.extensions }),
    ...(options.extensions ?? []),
  ];
  for (const extension of extensions) {
    const label = extension.name ?? extension.handle ?? 'Extension';
    const item = `extension ${extension.handle ?? label} (${extension.type ?? 'unknown type'})`;
    if (isAdminLink(extension)) {
      const link = (extension.targeting ?? []).find((t) => t.url);
      const path = link?.url ? appPath(link.url, appUrl) : undefined;
      if (path && appUrl && navigation.length < MAX_NAVIGATION) {
        navigation.push({ label: label.slice(0, 30), path });
        const onAPage = (extension.targeting ?? []).some(
          (t) =>
            t.target && t.target !== 'admin.app.nav.link' && !t.target.startsWith('admin.app.'),
        );
        map(
          item,
          `[[app.navigation]] ${path}`,
          onAPage
            ? 'A tab on your app’s home. For an action on a product or order page, add [[extensions.admin]].'
            : undefined,
        );
        continue;
      }
      skip(
        item,
        !appUrl
          ? 'Navigation needs [app] url, the embedded home it opens inside.'
          : navigation.length >= MAX_NAVIGATION
            ? `Storeware lists at most ${MAX_NAVIGATION} pages under your home.`
            : 'Its link leaves your app, and navigation stays inside it.',
        DOCS.admin,
      );
      continue;
    }
    const where = extensionDocs(extension);
    skip(item, where.reason, where.docs);
  }

  if (isTable(shopify.app_preferences) && str(shopify.app_preferences.url)) {
    const url = str(shopify.app_preferences.url)!;
    const path = appPath(url, appUrl);
    if (path && appUrl && navigation.length < MAX_NAVIGATION) {
      navigation.push({ label: 'Settings', path });
      map('[app_preferences] url', `[[app.navigation]] ${path}`);
    } else {
      skip(
        '[app_preferences] url',
        'Merchant settings are declared as [[settings]] fields, shown on your app’s page.',
        DOCS.settings,
      );
    }
  }

  /* [oauth] -------------------------------------------------------------- */

  const scopes: string[] = [];
  const access = isTable(shopify.access_scopes) ? shopify.access_scopes : {};
  for (const scope of scopeList(access.scopes)) {
    const rule = SHOPIFY_SCOPES[scope];
    if (rule?.to) {
      if (!scopes.includes(rule.to)) scopes.push(rule.to);
      map(scope, rule.to, rule.note);
    } else if (rule) {
      skip(scope, rule.reason ?? 'No equivalent scope.', rule.docs ?? DOCS.comingFromShopify);
    } else if (scope.startsWith('unauthenticated_')) {
      skip(
        scope,
        'Storefront API access is the shop’s own token, not an app’s.',
        DOCS.comingFromShopify,
      );
    } else if (scope.startsWith('customer_')) {
      skip(scope, 'No Customer Account API scopes.', DOCS.comingFromShopify);
    } else {
      skip(scope, 'No equivalent scope.', DOCS.comingFromShopify);
    }
  }
  for (const scope of scopeList(access.optional_scopes)) {
    skip(
      `optional scope ${scope}`,
      'A merchant grants every scope at install. There are no optional ones.',
      DOCS.manifest,
    );
  }
  if (access.use_legacy_install_flow === true) {
    skip(
      'use_legacy_install_flow',
      'Installs start from Storeware with [app] url, or from your site with [oauth] redirect_uris.',
      DOCS.installs,
    );
  }
  if (scopes.length === 0) {
    attention.push('No scope came across. Add at least one to [oauth] scopes.');
  }

  const redirects: string[] = [];
  const auth = isTable(shopify.auth) ? shopify.auth : {};
  for (const url of strings(auth.redirect_urls)) {
    let problem: string | undefined;
    if (!storewareUrl(url)) problem = 'Storeware needs https, except on localhost.';
    else if (new URL(url).search || new URL(url).hash) {
      problem = 'Storeware matches a redirect exactly, so it may not carry a query or fragment.';
    }
    if (problem) {
      skip(`redirect ${url}`, problem, DOCS.installs);
    } else if (!redirects.includes(url)) {
      redirects.push(url);
    }
  }
  if (redirects.length > 0) {
    map('[auth] redirect_urls', '[oauth] redirect_uris');
    if (appUrl) {
      attention.push(
        'With [app] url, merchants install from Storeware and need no redirect. ' +
          'Keep [oauth] redirect_uris only if installs also start on your own site.',
      );
    }
  }
  if (!appUrl && redirects.length === 0) {
    attention.push(
      'Storeware needs [app] url or at least one of [oauth] redirect_uris, so an install has somewhere to land.',
    );
  }

  /* [webhooks] and [privacy] ---------------------------------------------- */

  const hooks = isTable(shopify.webhooks) ? shopify.webhooks : {};
  if (str(hooks.api_version)) {
    map(
      `[webhooks] api_version ${str(hooks.api_version)}`,
      'Not needed',
      'Each Storeware topic carries its own version, such as .v1.',
    );
  }
  const events: string[] = [];
  const eventUrls: string[] = [];
  const privacyUrls: string[] = [];
  const base = applicationUrl;
  for (const subscription of (Array.isArray(hooks.subscriptions) ? hooks.subscriptions : []).filter(
    isTable,
  )) {
    const uri = str(subscription.uri);
    const url = uri ? absolute(uri, base) : undefined;
    const usable = url !== undefined && storewareUrl(url);
    const topics = strings(subscription.topics);
    const compliance = strings(subscription.compliance_topics);

    if (uri && !usable) {
      skip(
        `webhook uri ${uri}`,
        'Storeware posts events over https. It has no Pub/Sub or EventBridge delivery.',
        DOCS.webhooks,
      );
    }
    if (str(subscription.filter)) {
      skip(
        `webhook filter "${str(subscription.filter)}"`,
        'Every event in a topic is sent. Filter in your handler.',
        DOCS.webhooks,
      );
    }
    if (strings(subscription.include_fields).length > 0) {
      skip(
        'webhook include_fields',
        'Events carry their whole payload. Read the fields you need.',
        DOCS.webhooks,
      );
    }

    for (const topic of compliance) {
      const to = SHOPIFY_COMPLIANCE_TOPICS[topic];
      if (!to) {
        skip(`compliance topic ${topic}`, 'Not a compliance topic Storeware knows.', DOCS.webhooks);
        continue;
      }
      map(topic, `[privacy] url, as ${to}`);
      if (usable && !privacyUrls.includes(url)) privacyUrls.push(url);
    }

    for (const topic of topics) {
      const appTopic = SHOPIFY_APP_TOPICS[topic];
      if (appTopic) {
        map(topic, appTopic, 'Sent to [webhooks] url without subscribing, so it is not listed.');
        continue;
      }
      const compliant = SHOPIFY_COMPLIANCE_TOPICS[topic];
      if (compliant) {
        map(topic, `[privacy] url, as ${compliant}`);
        if (usable && !privacyUrls.includes(url)) privacyUrls.push(url);
        continue;
      }
      const to = SHOPIFY_TOPICS[topic];
      if (!to) {
        skip(`webhook ${topic}`, TOPIC_HINTS[topic] ?? 'No equivalent event.', DOCS.webhooks);
        continue;
      }
      if (!usable) continue;
      if (!events.includes(to)) events.push(to);
      if (!eventUrls.includes(url)) eventUrls.push(url);
      map(topic, to);
    }
  }

  const webhookUrl = eventUrls[0];
  if (eventUrls.length > 1) {
    attention.push(
      `Shopify sent your topics to ${eventUrls.length} addresses. Storeware sends every event to one, ` +
        `${webhookUrl}. Route on the topic in your handler. Not used: ${eventUrls.slice(1).join(', ')}.`,
    );
  }
  const expanded = new Set(
    scopes.flatMap((scope) =>
      scope.endsWith(':write') ? [scope, scope.replace(/:write$/, ':read')] : [scope],
    ),
  );
  for (const event of events) {
    const anyOf = TOPIC_SCOPES[event] ?? [];
    if (!anyOf.some((scope) => expanded.has(scope))) {
      attention.push(
        `${event} needs ${anyOf.join(' or ')}, which [oauth] scopes does not ask for. ` +
          'Add it or drop the event. storeware validate refuses the file until you do.',
      );
    }
  }
  const appEventsWanted = mapped.some((m) => Object.values(SHOPIFY_APP_TOPICS).includes(m.to));
  if (events.length === 0 && appEventsWanted) {
    attention.push(
      'Storeware sends app.uninstalled.v1 and the other app events to [webhooks] url, which needs at least one event. ' +
        'Add one, or leave [webhooks] out and go without them.',
    );
  }

  const privacyUrl = privacyUrls[0];
  if (privacyUrls.length > 1) {
    attention.push(
      `Your compliance topics went to ${privacyUrls.length} addresses. Storeware posts all three to ${privacyUrl}.`,
    );
  }
  if (!privacyUrl && scopes.some((s) => /^(customers|orders):/.test(s))) {
    attention.push(
      'Add [privacy] url. Storeware needs it with customer or order access, to send data requests and erasures.',
    );
  }

  /* [app_proxy] ----------------------------------------------------------- */

  let proxyUrl: string | undefined;
  if (isTable(shopify.app_proxy)) {
    const raw = str(shopify.app_proxy.url);
    const url = raw ? absolute(raw, base) : undefined;
    if (url && storewareUrl(url)) {
      proxyUrl = url;
      map('[app_proxy] url', '[app_proxy] url');
      const prefix = str(shopify.app_proxy.prefix) ?? 'apps';
      const subpath = str(shopify.app_proxy.subpath);
      if (subpath) {
        map(
          '[app_proxy] prefix and subpath',
          `/apps/${slug}`,
          'Storeware fixes the address, so these have no setting.',
        );
        attention.push(
          `Shoppers reach your proxy at /apps/${slug}, not /${prefix}/${subpath}. Update links in your app and its blocks.`,
        );
      }
    } else {
      skip('[app_proxy] url', 'Storeware needs an https URL here.', DOCS.appProxy);
    }
  }

  /* Billing ---------------------------------------------------------------- */

  const plans = options.plans ?? [];
  const planLines: string[] = [];
  const keys = new Set<string>();
  for (const plan of plans) {
    if (keys.size >= MAX_PLANS) {
      skip(`plan ${plan.name}`, `An app offers at most ${MAX_PLANS} plans.`, DOCS.billing);
      continue;
    }
    if (plan.capped_amount !== undefined || plan.terms) {
      skip(
        `plan ${plan.name} usage charges`,
        'Charges by use need mode = "api", where your app asks for each plan. Add usage to the plan by hand.',
        DOCS.billing,
      );
    }
    let key = planKey(plan.name);
    for (let n = 2; keys.has(key); n++) key = `${planKey(plan.name).slice(0, 29)}_${n}`;
    keys.add(key);
    const cents = Math.round((plan.amount ?? 0) * 100);
    const free = cents === 0;
    const lines = ['[[billing.plans]]', `key = ${q(key)}`, `name = ${q(plan.name.slice(0, 40))}`];
    lines.push(`interval = ${q(plan.interval === 'ANNUAL' ? 'year' : 'month')}`);
    let trial = plan.trial_days ?? 0;
    if (trial > 90) {
      attention.push(
        `${plan.name} had a ${trial} day trial. Storeware allows up to 90, so it is 90.`,
      );
      trial = 90;
    }
    if (free && trial > 0) {
      attention.push(`${plan.name} is free, so its trial was left out.`);
      trial = 0;
    }
    if (trial > 0) lines.push(`trial_days = ${trial}`);
    const features = (plan.features ?? []).slice(0, 8).map((f) => f.slice(0, 80));
    if (features.length > 0) lines.push(`features = ${tomlArray(features)}`);
    if (!free) {
      if (cents > 10_000_000) {
        throw new ImportError(`${plan.name} costs more than Storeware allows for one plan.`);
      }
      lines.push(
        '',
        '[billing.plans.prices]',
        `usd = ${cents}`,
        '# TODO: Storeware never converts prices. Write each one by hand, in minor',
        '# units (pence, cents, paise), then remove the # in front of it.',
        '# gbp = 0',
        '# eur = 0',
        '# inr = 0',
      );
      attention.push(
        `Plan ${key} has only its USD price. Add gbp, eur and inr under [billing.plans.prices]. ` +
          'storeware validate refuses the file until you do.',
      );
    }
    planLines.push(lines.join('\n'));
    map(
      `plan ${plan.name}`,
      `[[billing.plans]] ${key}`,
      free
        ? 'Free.'
        : `$${(cents / 100).toFixed(2)} a ${plan.interval === 'ANNUAL' ? 'year' : 'month'}.`,
    );
  }

  /* What is left -------------------------------------------------------------- */

  if (isTable(shopify.pos) && shopify.pos.embedded === true) {
    skip('[pos] embedded', 'No point of sale. Your app runs in the admin.', DOCS.comingFromShopify);
  }
  if (isTable(shopify.build)) {
    const keysSet = Object.keys(shopify.build);
    skip(
      `[build] ${keysSet.join(', ')}`.trim(),
      'Not needed. storeware app dev runs a tunnel and uses it in the copy it sends, and --store picks the development store.',
      DOCS.quickstart,
    );
  }
  if (isTable(shopify.access)) {
    skip(
      '[access] admin',
      'Your app calls the API with its own token. There is no direct API mode.',
      DOCS.installs,
    );
  }
  for (const key of Object.keys(shopify)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (/pricing|billing|plans?$/.test(key)) {
      skip(
        `[${key}]`,
        'Not read. Shopify sets pricing in the Partner Dashboard. Pass a plans file with --plans.',
        DOCS.billing,
      );
    } else {
      skip(key, 'Not something this import knows.', DOCS.comingFromShopify);
    }
  }

  /* The file ------------------------------------------------------------------- */

  const out: string[] = [
    '#:schema https://storeware.ai/docs/schemas/storeware.app.json',
    `# Made by storeware app import-shopify from ${options.sourceName ?? 'shopify.app.toml'}.`,
    '# Read what it printed, fill in any TODO, then run storeware validate.',
    'manifest_version = 2',
    '',
    '[app]',
    `slug = ${q(slug)}`,
    `name = ${q(name.slice(0, 120))}`,
  ];
  if (name.length > 120)
    attention.push('Your name was cut to 120 characters, the most Storeware shows.');
  if (appUrl) out.push(`url = ${q(appUrl)}`);
  if (homepageUrl) out.push(`homepage_url = ${q(homepageUrl)}`);
  for (const page of navigation) {
    out.push('', '[[app.navigation]]', `label = ${q(page.label)}`, `path = ${q(page.path)}`);
  }

  out.push('', '[oauth]', `scopes = ${tomlArray(scopes)}`);
  if (redirects.length > 0) out.push(`redirect_uris = ${tomlArray(redirects)}`);

  if (webhookUrl && events.length > 0) {
    out.push('', '[webhooks]', `url = ${q(webhookUrl)}`, `events = ${tomlArray(events)}`);
  } else if (webhookUrl || appEventsWanted) {
    const url = webhookUrl ?? (applicationUrl ? absolute('/webhooks', applicationUrl) : undefined);
    out.push(
      '',
      '# TODO: [webhooks] needs at least one event. App events such as',
      '# app.uninstalled.v1 are sent here once it has one.',
      '# [webhooks]',
      ...(url ? [`# url = ${q(url)}`] : []),
      '# events = ["product.updated.v1"]',
    );
  }
  if (privacyUrl) out.push('', '[privacy]', `url = ${q(privacyUrl)}`);
  if (proxyUrl) out.push('', '[app_proxy]', `url = ${q(proxyUrl)}`);
  if (planLines.length > 0) {
    out.push('', '[billing]', 'mode = "managed"');
    for (const plan of planLines) out.push('', plan);
  }

  return { manifestText: `${out.join('\n')}\n`, slug, mapped, unmapped, attention };
}

/* ------------------------------------------------------------------------ */
/* The command                                                               */
/* ------------------------------------------------------------------------ */

export interface RunOptions {
  /** Where the command was typed. */
  cwd: string;
  from?: string;
  out?: string;
  force?: boolean;
  plans?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function parseTomlFile(text: string, path: string): unknown {
  try {
    return parseToml(text);
  } catch (error) {
    throw new ImportError(
      `${path} is not valid TOML: ${error instanceof Error ? error.message : 'it did not parse'}`,
    );
  }
}

/** Each `extensions/<name>/shopify.extension.toml` beside the app's file. */
async function extensionFiles(directory: string): Promise<ShopifyExtension[]> {
  const folder = join(directory, 'extensions');
  let names: string[];
  try {
    names = (await readdir(folder)).sort();
  } catch {
    return [];
  }
  const found: ShopifyExtension[] = [];
  for (const name of names) {
    const file = join(folder, name, 'shopify.extension.toml');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    found.push(...extensionsIn(parseTomlFile(text, file), relative(directory, file)));
  }
  return found;
}

/**
 * Reads shopify.app.toml, its extensions and any plans file, and writes the
 * manifest beside it. Refuses to replace a file unless told to.
 */
export async function runImportShopify(
  options: RunOptions,
): Promise<{ from: string; out: string; result: ImportResult }> {
  const from = resolve(options.cwd, options.from ?? 'shopify.app.toml');
  const out = resolve(options.cwd, options.out ?? join(dirname(from), 'storeware.app.toml'));

  let text: string;
  try {
    text = await readFile(from, 'utf8');
  } catch {
    throw new ImportError(
      `No shopify.app.toml at ${from}. Run this in your Shopify app's folder, or pass --from <file>.`,
    );
  }
  if (!options.force && (await exists(out))) {
    throw new ImportError(`${out} is already there. Pass --force to replace it.`);
  }

  let plans: ShopifyPlan[] | undefined;
  if (options.plans) {
    const path = resolve(options.cwd, options.plans);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new ImportError(`No plans file at ${path}.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ImportError(`${options.plans} is not JSON.`);
    }
    plans = parsePlans(json);
  }

  const result = importShopify(parseTomlFile(text, from), {
    extensions: await extensionFiles(dirname(from)),
    ...(plans ? { plans } : {}),
    sourceName: basename(from),
  });
  await writeFile(out, result.manifestText, 'utf8');
  return { from, out, result };
}

/** Two columns, the second starting at the same place on every line. */
function columns(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.min(40, Math.max(0, ...rows.map(([a]) => a.length)));
  return rows.map(([a, b]) =>
    a.length > width ? `  ${a}\n  ${' '.repeat(width)}  ${b}` : `  ${a.padEnd(width)}  ${b}`,
  );
}

/** What the command prints: what mapped, what needs a look, and what has no equivalent. */
export function reportLines(result: ImportResult, written: string): string[] {
  const lines = [`Wrote ${written}.`, ''];
  lines.push('Mapped');
  lines.push(
    ...columns(result.mapped.map((m) => [m.from, m.note ? `${m.to}. ${m.note}` : m.to] as const)),
  );
  if (result.attention.length > 0) {
    lines.push('', 'Needs your attention');
    for (const sentence of result.attention) lines.push(`  ${sentence}`);
  }
  if (result.unmapped.length > 0) {
    lines.push('', 'No Storeware equivalent');
    for (const item of result.unmapped) {
      lines.push(`  ${item.item}`, `    ${item.reason}`, `    ${docsUrl(item.docs)}`);
    }
  }
  lines.push(
    '',
    result.attention.length > 0
      ? 'Next, deal with what needs your attention, then run storeware validate.'
      : 'Next, run storeware validate.',
    `Moving an app from Shopify: ${docsUrl(DOCS.comingFromShopify)}`,
  );
  return lines;
}
