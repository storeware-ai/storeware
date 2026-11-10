import { describe, expect, it } from 'vitest';
import {
  ManifestError,
  manifestUrls,
  parseManifest,
  validateEvents,
  validateScopes,
} from './manifest';

const VALID = `
[app]
slug = "hello-storeware"
name = "Hello Storeware"
description = "Reacts to catalogue changes."
homepage_url = "https://hello.example.com"

[oauth]
redirect_uris = ["https://hello.example.com/callback"]
scopes = ["products:read", "products:write"]

[webhooks]
url = "https://hello.example.com/webhooks"
events = ["product.created.v1", "product.updated.v1"]

[[extensions.admin]]
point = "admin.product.detail.sidebar"
url = "https://hello.example.com/embed/sidebar"
title = "Size guide"

[[mcp.tools]]
name = "check_size_fit"
description = "Tells a shopper whether a garment will fit them."
url = "https://hello.example.com/mcp/check-size-fit"
scopes = ["products:read"]
`;

/** Replaces one line of the valid manifest, so each test varies one thing. */
function withLine(find: string, replace: string): string {
  if (!VALID.includes(find)) throw new Error(`fixture does not contain: ${find}`);
  return VALID.replace(find, replace);
}

describe('a well-formed manifest', () => {
  it('parses every section', () => {
    const manifest = parseManifest(VALID);

    expect(manifest.app.slug).toBe('hello-storeware');
    expect(manifest.oauth.scopes).toEqual(['products:read', 'products:write']);
    expect(manifest.webhooks?.events).toHaveLength(2);
    expect(manifest.extensions?.admin?.[0]?.point).toBe('admin.product.detail.sidebar');
    expect(manifest.mcp?.tools?.[0]?.name).toBe('check_size_fit');
  });

  it('needs nothing beyond identity and oauth', () => {
    const minimal = `
[app]
slug = "minimal"
name = "Minimal"

[oauth]
redirect_uris = ["https://minimal.example.com/cb"]
scopes = ["products:read"]
`;
    expect(parseManifest(minimal).webhooks).toBeUndefined();
  });
});

describe('structural rejections', () => {
  it('rejects TOML that does not parse', () => {
    expect(() => parseManifest('[app\nslug = ')).toThrow(/not valid TOML/);
  });

  it('rejects an unknown top-level section', () => {
    // The typo that motivates .strict(). Without it, [webhook] parses
    // cleanly and produces a plugin that silently receives nothing.
    expect(() => parseManifest(withLine('[webhooks]', '[webhook]'))).toThrow(ManifestError);
  });

  it('rejects an unrecognised admin extension point', () => {
    expect(() =>
      parseManifest(withLine('admin.product.detail.sidebar', 'admin.product.sidebar')),
    ).toThrow(ManifestError);
  });

  it.each([
    ['uppercase', 'Hello-Storeware'],
    ['a leading hyphen', '-hello'],
    ['an underscore', 'hello_storeware'],
    ['one character', 'h'],
  ])('rejects a slug with %s', (_label, slug) => {
    expect(() => parseManifest(withLine('slug = "hello-storeware"', `slug = "${slug}"`))).toThrow(
      ManifestError,
    );
  });

  it('rejects a plaintext redirect URI', () => {
    expect(() =>
      parseManifest(
        withLine(
          'redirect_uris = ["https://hello.example.com/callback"]',
          'redirect_uris = ["http://hello.example.com/callback"]',
        ),
      ),
    ).toThrow(/https/);
  });

  it('allows plaintext on localhost, which has no certificate', () => {
    const manifest = parseManifest(
      withLine(
        'redirect_uris = ["https://hello.example.com/callback"]',
        'redirect_uris = ["http://localhost:4000/callback"]',
      ),
    );
    expect(manifest.oauth.redirect_uris).toEqual(['http://localhost:4000/callback']);
  });

  it('rejects a redirect URI carrying a query string', () => {
    // Exact matching is the whole defence. A query string makes it brittle in
    // exactly the way that invites relaxing it to a prefix check later.
    expect(() =>
      parseManifest(
        withLine(
          'redirect_uris = ["https://hello.example.com/callback"]',
          'redirect_uris = ["https://hello.example.com/callback?tenant=1"]',
        ),
      ),
    ).toThrow(/query string/);
  });

  it('rejects duplicate redirect URIs', () => {
    expect(() =>
      parseManifest(
        withLine(
          'redirect_uris = ["https://hello.example.com/callback"]',
          'redirect_uris = ["https://hello.example.com/cb", "https://hello.example.com/cb"]',
        ),
      ),
    ).toThrow(/duplicates/);
  });

  it('rejects an unversioned event name', () => {
    expect(() => parseManifest(withLine('"product.created.v1"', '"product.created"'))).toThrow(
      ManifestError,
    );
  });

  it('rejects a manifest asking for no scopes at all', () => {
    expect(() =>
      parseManifest(withLine('scopes = ["products:read", "products:write"]', 'scopes = []')),
    ).toThrow(ManifestError);
  });
});

describe('cross-field rules', () => {
  it('rejects an MCP tool needing a scope the plugin never requests', () => {
    // Catching it here beats a tool that installs fine and 403s on first use.
    const source = withLine('scopes = ["products:read"]\n', 'scopes = ["orders:write"]\n');
    expect(() => parseManifest(source)).toThrow(/oauth.scopes does not request/);
  });

  it('rejects two tools sharing a name', () => {
    const source = `${VALID}
[[mcp.tools]]
name = "check_size_fit"
description = "A second tool that collides with the first one."
url = "https://hello.example.com/mcp/other"
scopes = []
`;
    expect(() => parseManifest(source)).toThrow(/share a name/);
  });

  it('rejects a tool name that is not lower_snake_case', () => {
    expect(() =>
      parseManifest(withLine('name = "check_size_fit"', 'name = "checkSizeFit"')),
    ).toThrow(ManifestError);
  });
});

describe('scope vocabulary', () => {
  const KNOWN = ['products:read', 'products:write', 'orders:read'];

  it('accepts scopes the platform knows', () => {
    expect(() => validateScopes(parseManifest(VALID), KNOWN)).not.toThrow();
  });

  it('names the unknown scope and lists what is available', () => {
    const manifest = parseManifest(
      withLine(
        'scopes = ["products:read", "products:write"]',
        'scopes = ["products:read", "wombats:write"]',
      ),
    );

    // Shape-valid but not a real scope, which is precisely the case a regex
    // cannot catch and a stale copy of the list would get wrong.
    expect(() => validateScopes(manifest, KNOWN)).toThrow(/wombats:write/);
    expect(() => validateScopes(manifest, KNOWN)).toThrow(/orders:read/);
  });
});

describe('scopes no app may hold', () => {
  const KNOWN = ['products:read', 'products:write', 'plugins:read', 'plugins:write'];

  it('refuses plugins:write, which would let an app manage other apps', () => {
    const manifest = parseManifest(
      withLine(
        'scopes = ["products:read", "products:write"]',
        'scopes = ["products:read", "plugins:write"]',
      ),
    );
    expect(() => validateScopes(manifest, KNOWN)).toThrow(
      'plugins:write is how a merchant manages their apps, and no app may hold it. Remove it from oauth.scopes.',
    );
  });

  it('refuses plugins:read too, which would show it every other app the shop has', () => {
    const manifest = parseManifest(
      withLine(
        'scopes = ["products:read", "products:write"]',
        'scopes = ["products:read", "plugins:read", "plugins:write"]',
      ),
    );
    expect(() => validateScopes(manifest, KNOWN)).toThrow(/plugins:read, plugins:write are how/);
  });

  it('still parses a stored manifest that asked, so an approved release keeps working', () => {
    expect(() =>
      parseManifest(
        withLine(
          'scopes = ["products:read", "products:write"]',
          'scopes = ["products:read", "plugins:write"]',
        ),
      ),
    ).not.toThrow();
  });
});

describe('events against the catalogue', () => {
  const CATALOGUE = [
    { topic: 'product.created.v1', anyOf: ['products:read'] },
    { topic: 'product.updated.v1', anyOf: ['products:read'] },
    { topic: 'order.created.v1', anyOf: ['orders:read'] },
    { topic: 'customer.erased.v1', anyOf: ['customers:read', 'orders:read'] },
  ];

  it('accepts events the requested scopes cover', () => {
    expect(() => validateEvents(parseManifest(VALID), CATALOGUE)).not.toThrow();
  });

  it('refuses an event whose data the app has not asked to read', () => {
    // The case this exists for: an app that asks only for products would
    // otherwise be sent every buyer's email address on each new order.
    const manifest = parseManifest(
      withLine(
        'events = ["product.created.v1", "product.updated.v1"]',
        'events = ["product.created.v1", "order.created.v1"]',
      ),
    );
    expect(() => validateEvents(manifest, CATALOGUE)).toThrow(
      'webhooks.events: order.created.v1 needs orders:read, which oauth.scopes does not request',
    );
  });

  it('counts a write scope as covering its read', () => {
    const manifest = parseManifest(`
[app]
slug = "writer"
name = "Writer"

[oauth]
redirect_uris = ["https://writer.example.com/callback"]
scopes = ["products:write"]

[webhooks]
url = "https://writer.example.com/webhooks"
events = ["product.created.v1"]
`);
    expect(() => validateEvents(manifest, CATALOGUE)).not.toThrow();
  });

  it('accepts any one of several scopes', () => {
    const manifest = parseManifest(
      withLine(
        'scopes = ["products:read", "products:write"]',
        'scopes = ["products:read", "orders:read"]',
      ).replace(
        'events = ["product.created.v1", "product.updated.v1"]',
        'events = ["customer.erased.v1"]',
      ),
    );
    expect(() => validateEvents(manifest, CATALOGUE)).not.toThrow();
  });

  it('refuses a well-shaped name the platform never sends', () => {
    const manifest = parseManifest(
      withLine(
        'events = ["product.created.v1", "product.updated.v1"]',
        'events = ["banana.exploded.v1"]',
      ),
    );
    expect(() => validateEvents(manifest, CATALOGUE)).toThrow(ManifestError);
    expect(() => validateEvents(manifest, CATALOGUE)).toThrow(
      /banana\.exploded\.v1 is not an event/,
    );
  });
});

/**
 * Fields an app keeps on a merchant's records.
 *
 * The sibling of `knowledge`, and the boundaries are the same ones: an app may
 * only write what it declared, may only ask for scopes it requested, and cannot
 * claim a name the platform uses to attribute data an app did not supply.
 */
describe('the fields an app declares', () => {
  const withMetafields = (body: string) => `${VALID}\n${body}`;

  const FITMENT = `
[metafields]
scopes = ["products:write"]

[[metafields.definitions]]
owner_type = "product"
key = "fitment_years"
name = "Fits model years"
type = "single_line_text"
is_list = true
storefront_visible = true
`;

  it('parses a declaration', () => {
    const manifest = parseManifest(withMetafields(FITMENT));

    expect(manifest.metafields?.definitions).toEqual([
      {
        owner_type: 'product',
        key: 'fitment_years',
        name: 'Fits model years',
        type: 'single_line_text',
        is_list: true,
        storefront_visible: true,
      },
    ]);
    // No namespace, on purpose. It is derived as `app_` plus the slug, so it
    // cannot be got wrong and cannot be squatted.
    expect(JSON.stringify(manifest.metafields)).not.toContain('namespace');
  });

  it('refuses a scope the app never asked a merchant for', () => {
    const manifest = withMetafields(FITMENT).replace(
      'scopes = ["products:write"]\n\n[[metafields.definitions]]',
      'scopes = ["orders:write"]\n\n[[metafields.definitions]]',
    );

    expect(() => parseManifest(manifest)).toThrow(ManifestError);
  });

  it('refuses two fields sharing a key on one kind of record', () => {
    const duplicate = withMetafields(
      `${FITMENT}
[[metafields.definitions]]
owner_type = "product"
key = "fitment_years"
name = "Again"
type = "single_line_text"
`,
    );

    expect(() => parseManifest(duplicate)).toThrow(/share a key/);
  });

  it('refuses to publish a field about a customer', () => {
    const private_ = withMetafields(`
[metafields]
scopes = ["products:write"]

[[metafields.definitions]]
owner_type = "customer"
key = "loyalty_tier"
name = "Loyalty tier"
type = "single_line_text"
storefront_visible = true
`);

    // The database refuses it either way. This is the sentence an author reads
    // instead of a constraint violation at install time.
    expect(() => parseManifest(private_)).toThrow(/can never be/);
  });

  it('refuses a slug the platform speaks for', () => {
    // `merchant` is the provenance key an attribute carries when the merchant
    // themselves asserted it. An app holding that slug could write a value the
    // admin then attributes to the merchant.
    for (const reserved of ['merchant', 'metafields', 'shopify', 'storeware']) {
      expect(() =>
        parseManifest(withLine('slug = "hello-storeware"', `slug = "${reserved}"`)),
      ).toThrow(ManifestError);
    }
  });
});

describe('what an app charges', () => {
  const PAID = `
[billing]
mode = "managed"

[[billing.plans]]
key = "free"
name = "Free"

[[billing.plans]]
key = "pro"
name = "Pro"
trial_days = 14
features = ["Unlimited size guides"]
prices = { usd = 900, gbp = 800, eur = 900, inr = 75000 }
`;

  it('reads plans priced in every quoted currency, monthly unless it says', () => {
    const manifest = parseManifest(VALID + PAID);
    expect(manifest.billing?.mode).toBe('managed');
    expect(manifest.billing?.plans.map((plan) => [plan.key, plan.interval])).toEqual([
      ['free', 'month'],
      ['pro', 'month'],
    ]);
    expect(manifest.billing?.plans[1]?.prices?.gbp).toBe(800);
  });

  it('refuses a price missing a currency, since nothing is converted', () => {
    expect(() => parseManifest(VALID + PAID.replace('gbp = 800, ', ''))).toThrow(
      /billing\.plans\.1\.prices\.gbp/,
    );
  });

  it('refuses a trial on a free plan, two plans with one key, and a managed app with none', () => {
    expect(() =>
      parseManifest(VALID + PAID.replace('name = "Free"', 'name = "Free"\ntrial_days = 7')),
    ).toThrow(/free plan has nothing to try/);
    expect(() => parseManifest(VALID + PAID.replace('key = "pro"', 'key = "free"'))).toThrow(
      /share a key/,
    );
    expect(() => parseManifest(VALID + '\n[billing]\nmode = "managed"\n')).toThrow(
      /at least one plan/,
    );
  });

  it('lets an app that asks for its own charges declare no plans', () => {
    expect(parseManifest(VALID + '\n[billing]\nmode = "api"\n').billing?.plans).toEqual([]);
  });
});

describe('charges by use', () => {
  const USAGE = `
[billing]
mode = "api"

[[billing.plans]]
key = "metered"
name = "Metered"
prices = { usd = 500, gbp = 400, eur = 500, inr = 40000 }
usage = { cap = { usd = 5000, gbp = 4000, eur = 5000, inr = 400000 }, terms = "$0.02 per label" }
`;

  it('reads a capped usage price beside a plan', () => {
    const plan = parseManifest(VALID + USAGE).billing?.plans[0];
    expect(plan?.usage).toEqual({
      cap: { usd: 5000, gbp: 4000, eur: 5000, inr: 400000 },
      terms: '$0.02 per label',
    });
  });

  it('needs the app to report it, so refuses usage on a managed app', () => {
    expect(() => parseManifest(VALID + USAGE.replace('mode = "api"', 'mode = "managed"'))).toThrow(
      /needs mode = "api"/,
    );
  });
});

describe('[[assistant.tools]]', () => {
  const tool = (lines: string) => `${VALID}
[[assistant.tools]]
name = "draft_campaign"
description = "Drafts an email campaign for the products the merchant names."
url = "https://hello.example.com/assistant/draft-campaign"
${lines}
`;

  it('parses the same shape as an MCP tool, and is a write unless it says it only reads', () => {
    const manifest = parseManifest(tool('scopes = ["products:read"]'));
    const parsed = manifest.assistant?.tools?.[0];
    expect(parsed?.name).toBe('draft_campaign');
    expect(parsed?.read_only).toBe(false);
    expect(parsed?.input_schema).toEqual({ type: 'object', additionalProperties: false });
    expect(
      parseManifest(tool('scopes = ["products:read"]\nread_only = true')).assistant?.tools?.[0]
        ?.read_only,
    ).toBe(true);
  });

  it('refuses a read-only tool that holds a write scope', () => {
    expect(() => parseManifest(tool('scopes = ["products:write"]\nread_only = true'))).toThrow(
      /read_only cannot hold products:write/,
    );
  });

  it('refuses a scope the app never asks for', () => {
    expect(() => parseManifest(tool('scopes = ["orders:write"]'))).toThrow(
      /assistant.tools.draft_campaign: needs orders:write/,
    );
  });

  it('counts its address and scopes like every other door', () => {
    const manifest = parseManifest(tool('scopes = ["products:read"]'));
    expect(manifestUrls(manifest)).toContain('https://hello.example.com/assistant/draft-campaign');
    expect(() => validateScopes(manifest, ['products:read'])).toThrow(/products:write/);
  });
});
