import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

/**
 * The plugin manifest, `storeware.app.toml`.
 *
 * A plugin's manifest is the whole of what it declares about itself: identity,
 * the permissions it may ask a merchant for, the events it wants, and the
 * places it wants to appear. It lives in the plugin's own repository so that a
 * change to any of those is a reviewable diff rather than a click in a
 * dashboard nobody remembers making.
 *
 * This parser ships in the SDK rather than only on the server, so that
 * `storeware validate` in a plugin's CI rejects exactly what registration
 * would reject. Two validators drift; one does not.
 *
 * Structural validation happens here. Scope names are checked against the
 * server's live vocabulary by validateScopes, because the list of scopes grows
 * with the platform and a copy pinned in a published SDK would be wrong within
 * a release.
 */

export class ManifestError extends Error {
  constructor(
    message: string,
    /** Field paths that failed, for pointing at the offending line. */
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * Where a plugin may render inside the admin.
 *
 * A closed list on purpose. Each point is a commitment about what data is in
 * context and what the surrounding page will do, so an unrecognised one is an
 * error rather than something quietly ignored: an author who typos
 * `admin.product.sidebar` should be told, not left wondering why their
 * extension never appears.
 */
export const ADMIN_EXTENSION_POINTS = [
  'admin.product.detail.sidebar',
  'admin.product.detail.action',
  'admin.product.index.action',
  'admin.collection.detail.sidebar',
  'admin.collection.detail.action',
  'admin.order.detail.sidebar',
  'admin.order.detail.action',
  'admin.orders.index.action',
  'admin.customer.detail.sidebar',
  'admin.customer.detail.action',
  'admin.customers.index.action',
  'admin.settings.block',
] as const;

export type AdminExtensionPoint = (typeof ADMIN_EXTENSION_POINTS)[number];

/**
 * The points on a list, which act on the rows a merchant ticked.
 *
 * The ticked ids travel inside the signed session as `context.selection`,
 * never in the frame's address, so an app cannot be handed a selection the
 * merchant did not make by somebody editing a URL.
 */
export const INDEX_ACTION_POINTS = [
  'admin.product.index.action',
  'admin.orders.index.action',
  'admin.customers.index.action',
] as const satisfies readonly AdminExtensionPoint[];

export { MAX_SELECTION } from './bridge/protocol';

/** Whether a point is a list's action, and so carries a selection. */
export function isIndexAction(point: string): boolean {
  return (INDEX_ACTION_POINTS as readonly string[]).includes(point);
}

/** Named slots a storefront theme renders plugin blocks into. */
export const STOREFRONT_BLOCKS = [
  'storefront.product.below_description',
  'storefront.product.above_add_to_cart',
  'storefront.cart.summary',
  'storefront.collection.header',
] as const;

export type StorefrontBlock = (typeof STOREFRONT_BLOCKS)[number];

/**
 * Only https, and never a URL carrying a query string or fragment.
 *
 * Plaintext http would put an authorization code and a session JWT on the
 * wire. A query string on a redirect URI makes exact matching brittle in
 * exactly the way that invites someone to relax it into a prefix check later.
 * localhost is exempt, because local development has no certificate.
 */
const httpsUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      return url.protocol === 'https:' || (local && url.protocol === 'http:');
    },
    { message: 'must use https, except on localhost' },
  );

/**
 * Where Storeware runs apps it hosts: each app at `<slug>.storewareapps.com`.
 *
 * A registrable domain of its own, apart from everything of Storeware's, so a
 * hosted app shares no cookies with Storeware or, once the domain is on the
 * Public Suffix List, with another app.
 */
export const HOSTED_APPS_DOMAIN = 'storewareapps.com';

/** The address a hosted app is served from. */
export function hostedAppOrigin(slug: string, domain = HOSTED_APPS_DOMAIN): string {
  return `https://${slug}.${domain}`;
}

/** The most hosts a hosted app may send requests to, besides Storeware's API. */
export const MAX_EGRESS_HOSTS = 20;

/** The largest bundle `storeware app deploy` uploads, in bytes. */
export const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;

/** A public DNS name: no IP address, no port, no wildcard, at least one dot. */
const egressHost = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'must be a lowercase host name such as api.example.com, with no scheme, port or path',
  );

const redirectUri = httpsUrl.refine((value) => !new URL(value).search && !new URL(value).hash, {
  message: 'must not contain a query string or fragment',
});

/**
 * Slugs the platform speaks for.
 *
 * These are provenance keys in `product_enrichments.contributions`, where they
 * name who asserted an attribute. A plugin holding one of them could write a
 * value the admin then attributes to the merchant themselves or to their
 * import, which is the one claim an app must never be able to make.
 */
const RESERVED_SLUGS = new Set(['merchant', 'metafields', 'shopify', 'storeware']);

// Mirrors the check constraint on public.plugins.slug. Keeping the regex
// identical means a manifest that parses is a manifest that will insert.
const slug = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,62}$/,
    'must be lowercase letters, digits and hyphens, 2 to 63 characters, starting with a letter or digit',
  )
  .refine((value) => !RESERVED_SLUGS.has(value), {
    message: 'is a name the platform uses to attribute data it did not get from an app',
  });

// Shape only. Whether the scope exists is the server's question.
const scopeName = z.string().regex(/^[a-z_]+:(read|write)$/, 'must look like resource:action');

// Versioned event names, matching the outbox check constraint.
const eventName = z
  .string()
  .regex(
    /^[a-z_]+\.[a-z_]+\.v[0-9]+$/,
    'must be a versioned event name such as product.created.v1',
  );

/**
 * A path inside an app's own home, for a page the admin's navigation links to.
 * Relative, so it can never name another host.
 */
const appPath = z
  .string()
  .regex(/^\/[A-Za-z0-9._~/-]*$/, 'must be a path starting with /, such as /settings')
  .refine((value) => !value.includes('..') && !value.startsWith('//'), {
    message: 'must stay inside the app',
  });

/** An amount in a currency's minor units: cents, pence, paise. */
const minorAmount = z.number().int().min(1).max(10_000_000);

/**
 * A plan a merchant can choose, priced by hand in every currency Storeware
 * quotes. Never converted: a merchant in London sees the pounds written here.
 */
const billingPlan = z
  .object({
    /** What the app asks for when it requests this plan. */
    key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, 'must be lower_snake_case'),
    name: z.string().trim().min(1).max(40),
    description: z.string().trim().max(200).optional(),
    interval: z.enum(['month', 'year']).default('month'),
    /** Absent for a free plan. Otherwise all four, each set by hand. */
    prices: z
      .object({ usd: minorAmount, gbp: minorAmount, eur: minorAmount, inr: minorAmount })
      .strict()
      .optional(),
    /** Days before the first charge, at most once per shop. */
    trial_days: z.number().int().min(0).max(90).default(0),
    features: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
    /**
     * Charges by use on top of the plan, billed at the end of each period and
     * never more than the cap a period, in every quoted currency. `terms` is
     * what the merchant reads, such as "$0.02 per label".
     */
    usage: z
      .object({
        cap: z
          .object({ usd: minorAmount, gbp: minorAmount, eur: minorAmount, inr: minorAmount })
          .strict(),
        terms: z.string().trim().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A key a merchant never sees, in the same shape metafield keys take. */
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'must be lower_snake_case');

/**
 * What a merchant can type into an app's settings.
 *
 * `secret` is kept encrypted, shown to the merchant only as set or not set,
 * and handed back in full to the app alone. `select` needs `options`.
 */
export const SETTING_TYPES = [
  'single_line_text',
  'multi_line_text',
  'integer',
  'decimal',
  'boolean',
  'url',
  'color',
  'select',
  'secret',
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

const choice = z
  .object({
    value: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(60),
  })
  .strict();

const settingField = z
  .object({
    key: fieldKey,
    label: z.string().trim().min(1).max(60),
    help: z.string().trim().max(200).optional(),
    type: z.enum(SETTING_TYPES),
    required: z.boolean().default(false),
    default: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
    options: z.array(choice).min(2).max(30).optional(),
  })
  .strict();

export type SettingField = z.infer<typeof settingField>;

/**
 * What an app's block or section answers with.
 *
 * `html` is sanitised to text, lists, tables and links. `components` is a
 * list of nodes Storeware draws itself in the shop's own type and colours,
 * defined in `@storeware/plugin-sdk/components`.
 */
export const BLOCK_FORMATS = ['html', 'components'] as const;
export type BlockFormat = (typeof BLOCK_FORMATS)[number];

/**
 * A trigger or action key. Letters and underscores only, because a trigger
 * becomes part of an event name and the outbox allows no digits there.
 */
const automationKey = z
  .string()
  .regex(/^[a-z][a-z_]{1,31}$/, 'must be lower_snake_case letters, up to 32 characters');

/** The kinds of value an app's trigger carries, which a condition can test. */
export const TRIGGER_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'url'] as const;

/** The kinds of value a merchant fills in for an app's action. */
export const ACTION_FIELD_TYPES = [
  'text',
  'multi_line_text',
  'number',
  'boolean',
  'url',
  'select',
] as const;

const automationTrigger = z
  .object({
    key: automationKey,
    label: z.string().trim().min(1).max(60),
    description: z.string().trim().max(200).optional(),
    fields: z
      .array(
        z
          .object({
            key: fieldKey,
            label: z.string().trim().min(1).max(60),
            type: z.enum(TRIGGER_FIELD_TYPES),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();

const automationAction = z
  .object({
    key: automationKey,
    label: z.string().trim().min(1).max(60),
    description: z.string().trim().max(200).optional(),
    url: httpsUrl,
    fields: z
      .array(
        z
          .object({
            key: fieldKey,
            label: z.string().trim().min(1).max(60),
            type: z.enum(ACTION_FIELD_TYPES),
            required: z.boolean().default(false),
            options: z.array(choice).min(2).max(30).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();

export type AutomationTrigger = z.infer<typeof automationTrigger>;
export type AutomationAction = z.infer<typeof automationAction>;

/**
 * The manifest's shape. Exported for `manifest-schema.ts`, which publishes it
 * as JSON Schema; everything else parses through `parseManifest`.
 */
export const manifestSchema = z
  .object({
    /**
     * Which shape of manifest this is. 1 when absent; 2 adds an embedded home
     * (`app.url`), admin navigation and a privacy endpoint. Old releases keep
     * parsing whatever this says.
     */
    manifest_version: z.number().int().min(1).max(2).optional(),
    app: z.object({
      slug,
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      homepage_url: httpsUrl.optional(),
      /**
       * The app's home inside the admin: a page Storeware frames full size and
       * hands a session to. With it, merchants install from Storeware and the
       * app needs no redirect of its own.
       */
      url: httpsUrl.optional(),
      /** Up to five pages of the app's home, listed under it in the admin. */
      navigation: z
        .array(z.object({ label: z.string().trim().min(1).max(30), path: appPath }))
        .max(5)
        .optional(),
      privacy_policy_url: httpsUrl.optional(),
      support_url: httpsUrl.optional(),
    }),
    oauth: z.object({
      /** Needed for an app installed by its own redirect; optional with `app.url`. */
      redirect_uris: z.array(redirectUri).default([]),
      scopes: z.array(scopeName).min(1),
    }),
    /**
     * Where Storeware sends what the law obliges an app to act on: a customer
     * asking for their data, a customer erased, a shop's data to delete.
     */
    privacy: z.object({ url: httpsUrl }).optional(),
    /**
     * What the app charges, collected by Storeware on the merchant's bill.
     *
     * `managed`: Storeware shows these plans when the app is installed and on
     * the app's Plans page, and the merchant picks one there. `api`: the app
     * asks for a plan or a one-time charge itself, and Storeware asks the
     * merchant to approve it. Either way the merchant approves every charge
     * before it is made.
     */
    billing: z
      .object({
        mode: z.enum(['managed', 'api']),
        plans: z.array(billingPlan).max(6).default([]),
      })
      .strict()
      .optional(),
    webhooks: z
      .object({
        url: httpsUrl,
        events: z.array(eventName).min(1),
      })
      .optional(),
    extensions: z
      .object({
        admin: z
          .array(
            z.object({
              point: z.enum(ADMIN_EXTENSION_POINTS),
              url: httpsUrl,
              title: z.string().trim().min(1).max(60),
            }),
          )
          .optional(),
        storefront: z
          .array(
            z.object({
              block: z.enum(STOREFRONT_BLOCKS),
              url: httpsUrl,
              format: z.enum(BLOCK_FORMATS).default('html'),
            }),
          )
          .optional(),
        /**
         * Sections a merchant can place on any page from the page editor,
         * not only in the four named slots. Each is asked for like a block.
         */
        sections: z
          .array(
            z
              .object({
                handle: z
                  .string()
                  .regex(/^[a-z][a-z0-9_]{1,31}$/, 'must be lower_snake_case, up to 32 characters'),
                name: z.string().trim().min(1).max(40),
                description: z.string().trim().max(200).optional(),
                url: httpsUrl,
                format: z.enum(BLOCK_FORMATS).default('components'),
              })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .optional(),
    /**
     * Fields a merchant fills in on the app's page in their settings. The
     * app reads them with `GET /api/v1/app/settings` and hears of a change
     * as `app.settings_updated.v1`.
     */
    settings: z.array(settingField).max(30).optional(),
    /**
     * Pages under the shop's own address, at `/apps/<slug>/...`. Storeware
     * signs each request and forwards it here without the shopper's cookies.
     */
    app_proxy: z.object({ url: httpsUrl }).strict().optional(),
    /**
     * What the app adds to the shop's automations: triggers it fires with
     * `POST /api/v1/app/events`, and actions a merchant adds as a step.
     */
    automations: z
      .object({
        triggers: z.array(automationTrigger).max(20).default([]),
        actions: z.array(automationAction).max(20).default([]),
      })
      .strict()
      .optional(),
    /**
     * Where the app takes part in checkout. `delivery_rates` is asked for the
     * delivery choices on every basket with an address; if it fails or is
     * slow, the shop's own rates are shown, so checkout never stops.
     */
    checkout: z
      .object({
        delivery_rates: z.object({ url: httpsUrl }).strict().optional(),
      })
      .strict()
      .optional(),
    /**
     * Run the app on Storeware, at `https://<slug>.storewareapps.com`, rather
     * than on a server of the developer's own. `storeware app deploy` bundles
     * `main` and writes `bundle`; the code may reach Storeware's API and the
     * hosts in `egress`, and nothing else.
     */
    runtime: z
      .object({
        main: z
          .string()
          .min(1)
          .max(200)
          .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), {
            message: 'must be a path inside the app, such as src/worker.ts',
          })
          .default('src/worker.ts'),
        egress: z.array(egressHost).max(MAX_EGRESS_HOSTS).default([]),
        /** The SHA-256 of the uploaded bundle. Written by `storeware app deploy`. */
        bundle: z
          .string()
          .regex(/^[0-9a-f]{64}$/, 'is written by `storeware app deploy`; do not edit it')
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * What a plugin knows about products, as opposed to what it can do to them.
     *
     * The other sections let a plugin act: receive events, render a panel, offer
     * an agent a tool. This one lets it teach. A fitment plugin holding a real
     * compatibility database declares it here, and from the moment a merchant
     * installs it that knowledge is in the store's enrichment and its knowledge
     * graph, which means it is in search, in the storefront assistant and in
     * every external agent's view of the catalogue at once.
     *
     * That is a different kind of extension from a panel in the admin, and it is
     * the one an app model bolted onto a fixed data model cannot offer: there
     * has to be somewhere for contributed knowledge to go.
     *
     * Both lists are closed declarations rather than open permission, for the
     * same reason `mcp.tools.scopes` must be a subset of `oauth.scopes`.
     * Attributes drive search filters, so a plugin that could write any key
     * could change which products a shopper is shown. Declaring `fit` does not
     * let it start writing `waterproof`, and the declaration is what a merchant
     * is shown before they approve the install.
     */
    knowledge: z
      .object({
        url: httpsUrl,
        /**
         * Enrichment attribute keys this plugin may set.
         *
         * Same shape as the keys enrichment itself produces, because they land
         * in the same map and are read by the same filters. A plugin's value
         * wins over the model's for a key it declared: the model inferred it
         * from a description, and a plugin with a fitment database knows.
         */
        attributes: z
          .array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'must be lower_snake_case'))
          .default([]),
        /** Graph relations this plugin may assert between two products. */
        relations: z.array(z.string()).default([]),
        scopes: z.array(scopeName).default([]),
      })
      .refine((k) => k.attributes.length > 0 || k.relations.length > 0, {
        message: 'must declare at least one attribute or relation, or be omitted entirely',
      })
      .optional(),
    /**
     * Typed fields this plugin keeps on a merchant's records.
     *
     * The sibling of `knowledge`, and the difference between them is push
     * against pull. Knowledge is asked for: enrichment calls the plugin about
     * one product inside a two second window, merges the answer and stores none
     * of it, which suits a plugin that computes an answer from something it
     * already holds. A metafield is written: the plugin sets it when it has
     * something, it persists, the merchant can see it in the admin attributed
     * to the app, and no enrichment run is needed for it to take effect. That
     * suits a plugin that syncs a database.
     *
     * There is no namespace here on purpose. It is derived as `app_` plus the
     * plugin's slug, so it cannot be got wrong and cannot be squatted: a
     * database constraint refuses a merchant-owned definition in an `app_`
     * namespace and an app-owned one outside it, in both directions.
     *
     * A plugin may only write the fields it declared, checked on every write.
     * Attributes reach search filters, so an app able to write any field could
     * change which products a shopper is shown, and declaring `fitment_years`
     * does not let it start writing `waterproof`.
     *
     * Uninstalling removes these fields and their values from that shop about
     * two days later, so installing again in the meantime loses nothing.
     */
    metafields: z
      .object({
        definitions: z
          .array(
            z.object({
              owner_type: z.enum([
                'product',
                'variant',
                'collection',
                'customer',
                'order',
                'store',
              ]),
              key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'must be lower_snake_case'),
              /** What a merchant sees. Rendered on the shop front when visible. */
              name: z.string().trim().min(1).max(200),
              description: z.string().trim().max(2000).optional(),
              type: z.enum([
                'single_line_text',
                'multi_line_text',
                'integer',
                'decimal',
                'boolean',
                'date',
                'url',
              ]),
              is_list: z.boolean().default(false),
              /**
               * Whether shoppers see it.
               *
               * Requested rather than granted: a customer or order field can
               * never be public whatever an app asks for, and the database
               * refuses it rather than a service remembering to.
               */
              storefront_visible: z.boolean().default(false),
            }),
          )
          .min(1)
          .max(50),
        scopes: z.array(scopeName).default([]),
      })
      .optional(),
    mcp: z
      .object({
        tools: z
          .array(
            z.object({
              // Tool names reach a model, and a model picks tools by name, so
              // they follow the same convention as ours rather than whatever
              // casing an author prefers.
              name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, 'must be lower_snake_case'),
              description: z.string().trim().min(10).max(500),
              url: httpsUrl,
              scopes: z.array(scopeName).default([]),
              /**
               * The tool's arguments, as JSON Schema.
               *
               * A model picks a tool by its name and then has to fill in its
               * arguments, so a tool without this is one the model can only
               * call by guessing. Optional because a tool may genuinely take
               * none, and the default below says exactly that rather than
               * leaving it open.
               */
              input_schema: z
                .record(z.string(), z.unknown())
                .default({ type: 'object', additionalProperties: false }),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof manifestSchema>;

/** One plan from `[[billing.plans]]`. */
export type BillingPlan = z.infer<typeof billingPlan>;

/**
 * Parses and structurally validates a manifest.
 *
 * `.strict()` on the top level means an unknown section is an error. That is
 * deliberate: a typo like `[webhook]` for `[webhooks]` would otherwise parse
 * cleanly and produce a plugin that silently receives nothing.
 */
export function parseManifest(source: string): PluginManifest {
  let raw: unknown;
  try {
    raw = parseToml(source);
  } catch (error) {
    throw new ManifestError(
      `storeware.app.toml is not valid TOML: ${error instanceof Error ? error.message : 'parse failed'}`,
    );
  }

  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`,
    );
    throw new ManifestError(`storeware.app.toml is not valid:\n  ${issues.join('\n  ')}`, issues);
  }

  const manifest = result.data;

  // Cross-field checks the schema cannot express.
  const problems: string[] = [];

  if (new Set(manifest.oauth.redirect_uris).size !== manifest.oauth.redirect_uris.length) {
    problems.push('oauth.redirect_uris: contains duplicates');
  }

  // An app has to be reachable one way or the other: framed in the admin from
  // its home, or sent to its own redirect after consent.
  if (manifest.oauth.redirect_uris.length === 0 && !manifest.app.url) {
    problems.push('oauth.redirect_uris: name at least one, or set app.url for an embedded home');
  }
  if (manifest.app.navigation && !manifest.app.url) {
    problems.push('app.navigation: needs app.url, the home its paths are inside');
  }

  const declared = new Set(manifest.oauth.scopes);
  for (const tool of manifest.mcp?.tools ?? []) {
    // A tool cannot need access the plugin never asks a merchant for. Catching
    // it here beats a tool that installs fine and then 403s on first use.
    const missing = tool.scopes.filter((scope) => !declared.has(scope));
    if (missing.length > 0) {
      problems.push(
        `mcp.tools.${tool.name}: needs ${missing.join(', ')}, which oauth.scopes does not request`,
      );
    }
  }

  const toolNames = (manifest.mcp?.tools ?? []).map((t) => t.name);
  if (new Set(toolNames).size !== toolNames.length) {
    problems.push('mcp.tools: two tools share a name');
  }

  if (manifest.knowledge) {
    // The same rule tools follow. A contributor cannot need access the plugin
    // never asks a merchant for.
    const missing = manifest.knowledge.scopes.filter((scope) => !declared.has(scope));
    if (missing.length > 0) {
      problems.push(`knowledge: needs ${missing.join(', ')}, which oauth.scopes does not request`);
    }

    const attributes = manifest.knowledge.attributes;
    if (new Set(attributes).size !== attributes.length) {
      problems.push('knowledge.attributes: contains duplicates');
    }

    const relations = manifest.knowledge.relations;
    if (new Set(relations).size !== relations.length) {
      problems.push('knowledge.relations: contains duplicates');
    }
  }

  if (manifest.billing) {
    const keys = manifest.billing.plans.map((plan) => plan.key);
    if (new Set(keys).size !== keys.length) {
      problems.push('billing.plans: two plans share a key');
    }
    if (manifest.billing.mode === 'managed' && keys.length === 0) {
      problems.push('billing.plans: a managed app offers at least one plan');
    }
    for (const plan of manifest.billing.plans) {
      if (!plan.prices && plan.trial_days > 0) {
        problems.push(`billing.plans.${plan.key}: a free plan has nothing to try first`);
      }
    }
    if (manifest.billing.mode === 'managed' && manifest.billing.plans.some((plan) => plan.usage)) {
      problems.push(
        'billing.plans: usage is reported by the app, so a plan with usage needs mode = "api"',
      );
    }
  }

  if (manifest.metafields) {
    // The same rule tools and knowledge follow: a section cannot need access
    // the plugin never asks a merchant for.
    const missing = manifest.metafields.scopes.filter((scope) => !declared.has(scope));
    if (missing.length > 0) {
      problems.push(`metafields: needs ${missing.join(', ')}, which oauth.scopes does not request`);
    }

    const named = manifest.metafields.definitions.map((d) => `${d.owner_type}.${d.key}`);
    if (new Set(named).size !== named.length) {
      problems.push('metafields.definitions: two fields share a key on the same kind of record');
    }

    // Said here rather than discovered as a constraint violation at install.
    // The database refuses it either way; this is the sentence an author reads.
    const private_ = manifest.metafields.definitions.filter(
      (d) => d.storefront_visible && (d.owner_type === 'customer' || d.owner_type === 'order'),
    );
    if (private_.length > 0) {
      problems.push(
        `metafields.definitions: ${private_.map((d) => d.key).join(', ')} asks to be shown on the ` +
          'shop front, and a field about a customer or an order can never be',
      );
    }
  }

  problems.push(...settingsProblems(manifest.settings ?? []));

  const handles = (manifest.extensions?.sections ?? []).map((section) => section.handle);
  if (new Set(handles).size !== handles.length) {
    problems.push('extensions.sections: two sections share a handle');
  }

  if (manifest.automations) {
    const triggers = manifest.automations.triggers.map((trigger) => trigger.key);
    if (new Set(triggers).size !== triggers.length) {
      problems.push('automations.triggers: two triggers share a key');
    }
    const actions = manifest.automations.actions.map((action) => action.key);
    if (new Set(actions).size !== actions.length) {
      problems.push('automations.actions: two actions share a key');
    }
    for (const action of manifest.automations.actions) {
      for (const field of action.fields) {
        if (field.type === 'select' && !field.options) {
          problems.push(`automations.actions.${action.key}.${field.key}: a select needs options`);
        }
        if (field.type !== 'select' && field.options) {
          problems.push(
            `automations.actions.${action.key}.${field.key}: only a select has options`,
          );
        }
      }
    }
  }

  // A rate request carries the shopper's address and basket, which is what
  // `checkout:read` grants. The merchant sees that on the consent screen.
  if (manifest.checkout?.delivery_rates && !declared.has('checkout:read')) {
    problems.push(
      'checkout.delivery_rates: needs checkout:read, which oauth.scopes does not request',
    );
  }

  problems.push(...hostingProblems(manifest));

  if (problems.length > 0) {
    throw new ManifestError(
      `storeware.app.toml is not valid:\n  ${problems.join('\n  ')}`,
      problems,
    );
  }

  return manifest;
}

/**
 * Every address Storeware sends a shop's data to or frames for an app.
 *
 * One list, read by the reach a merchant approves and by the check that an
 * app's addresses are not Storeware's own, so a door added later cannot be
 * counted by one and missed by the other. `oauth.redirect_uris` are not in it:
 * they are where a person's browser is sent, checked on their own.
 */
export function manifestUrls(manifest: PluginManifest): string[] {
  return [
    ...(manifest.app.url ? [manifest.app.url] : []),
    ...(manifest.webhooks ? [manifest.webhooks.url] : []),
    ...(manifest.privacy ? [manifest.privacy.url] : []),
    ...(manifest.extensions?.admin ?? []).map((e) => e.url),
    ...(manifest.extensions?.storefront ?? []).map((e) => e.url),
    ...(manifest.extensions?.sections ?? []).map((e) => e.url),
    ...(manifest.mcp?.tools ?? []).map((t) => t.url),
    ...(manifest.knowledge ? [manifest.knowledge.url] : []),
    ...(manifest.app_proxy ? [manifest.app_proxy.url] : []),
    ...(manifest.automations?.actions ?? []).map((a) => a.url),
    ...(manifest.checkout?.delivery_rates ? [manifest.checkout.delivery_rates.url] : []),
  ];
}

/**
 * The hosting rules: an address on the hosted domain is the app's own and
 * only a hosted app's, and the code may not call another hosted app.
 */
function hostingProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  const own = new URL(hostedAppOrigin(manifest.app.slug)).hostname;
  const hosted = (host: string) =>
    host === HOSTED_APPS_DOMAIN || host.endsWith(`.${HOSTED_APPS_DOMAIN}`);

  for (const url of [...manifestUrls(manifest), ...manifest.oauth.redirect_uris]) {
    // One trailing dot names the same host, `other.storewareapps.com.` being
    // `other.storewareapps.com`, so it is not a way around the rules.
    const host = new URL(url).hostname.replace(/\.$/, '');
    if (!hosted(host)) continue;
    if (host !== own) {
      problems.push(`${url}: only ${own} is this app’s on ${HOSTED_APPS_DOMAIN}`);
    } else if (!manifest.runtime) {
      problems.push(`${url}: an address on ${HOSTED_APPS_DOMAIN} needs [runtime]`);
    }
  }

  const egress = manifest.runtime?.egress ?? [];
  if (new Set(egress).size !== egress.length) problems.push('runtime.egress: lists a host twice');
  for (const host of egress.filter(hosted)) {
    problems.push(`runtime.egress.${host}: a hosted app may not call another hosted app`);
  }
  return problems;
}

/** What is wrong with `[[settings]]`, as sentences an author can act on. */
function settingsProblems(fields: readonly SettingField[]): string[] {
  const problems: string[] = [];
  const keys = fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) problems.push('settings: two fields share a key');

  for (const field of fields) {
    const at = `settings.${field.key}`;
    if (field.type === 'select' && !field.options) problems.push(`${at}: a select needs options`);
    if (field.type !== 'select' && field.options) problems.push(`${at}: only a select has options`);
    if (field.default === undefined) continue;
    if (field.type === 'secret') {
      problems.push(`${at}: a secret has no default, or every shop would share it`);
      continue;
    }
    if (!settingAccepts(field, field.default)) {
      problems.push(`${at}: the default is not a ${field.type.replaceAll('_', ' ')}`);
    }
  }
  return problems;
}

/**
 * Whether a value fits a setting. The same rule the admin form and the API
 * apply to what a merchant saves, so a default that parses always saves.
 */
export function settingAccepts(field: SettingField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'decimal':
      return typeof value === 'number' && Number.isFinite(value);
    case 'url':
      return typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) && value.length <= 2000;
    case 'color':
      return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    case 'select':
      return typeof value === 'string' && (field.options ?? []).some((o) => o.value === value);
    case 'single_line_text':
      return typeof value === 'string' && value.length <= 500 && !/[\r\n]/.test(value);
    case 'multi_line_text':
    case 'secret':
      return typeof value === 'string' && value.length <= 2000;
  }
}

/**
 * Scopes no app may hold, whatever it asks for.
 *
 * The `plugins` resource is a merchant managing their apps: which are
 * installed, what each may reach, removing one, approving an update. An app
 * holding it could uninstall a competitor, read every other app's grant, or
 * register apps under the merchant's own organisation. There is no app that
 * needs it, so no app is given it.
 */
export const WITHHELD_FROM_APPS: readonly string[] = [
  'plugins:read',
  'plugins:write',
  // Building apps and what they earn. An app holding these could publish
  // releases of itself or read a developer's money.
  'developer:read',
  'developer:write',
  'earnings:read',
];

/**
 * Checks scope names against the platform's live vocabulary.
 *
 * Separate from parsing because the answer changes as the platform grows. The
 * CLI fetches the list from the API; the server passes its own. Stored
 * manifests are never re-checked here, so tightening this cannot stop an
 * approved release from parsing.
 */
export function validateScopes(manifest: PluginManifest, knownScopes: readonly string[]): void {
  const asked = [
    ...manifest.oauth.scopes,
    ...(manifest.mcp?.tools ?? []).flatMap((t) => t.scopes),
    ...(manifest.knowledge?.scopes ?? []),
    ...(manifest.metafields?.scopes ?? []),
  ];

  const withheld = [...new Set(asked.filter((scope) => WITHHELD_FROM_APPS.includes(scope)))];
  if (withheld.length > 0) {
    throw new ManifestError(
      `${withheld.join(', ')} ${withheld.length === 1 ? 'is' : 'are'} how a merchant manages their apps, and no app may hold ${withheld.length === 1 ? 'it' : 'them'}. Remove ${withheld.length === 1 ? 'it' : 'them'} from oauth.scopes.`,
      withheld,
    );
  }

  const known = new Set(knownScopes);
  const unknown = asked.filter((scope) => !known.has(scope));

  if (unknown.length > 0) {
    const distinct = [...new Set(unknown)];
    throw new ManifestError(
      `Unknown scopes: ${distinct.join(', ')}.\nAvailable scopes:\n  ${knownScopes.join('\n  ')}`,
      distinct,
    );
  }
}

/** One topic the platform emits, and the scopes any one of which lets an app hear it. */
export interface EventAccess {
  topic: string;
  anyOf: readonly string[];
}

/**
 * Checks declared events against the platform's catalogue and the app's scopes.
 *
 * An event is a read: `order.created.v1` carries a buyer's email address. So a
 * topic has to be one the platform emits, and `oauth.scopes` has to request a
 * scope that could read the same data, or the merchant approving the install
 * would be shown one permission and the app sent something it does not cover.
 *
 * Separate from parsing for the reason scopes are. The catalogue grows with the
 * platform; the CLI fetches it from the API and the server passes its own.
 */
export function validateEvents(manifest: PluginManifest, catalogue: readonly EventAccess[]): void {
  const events = manifest.webhooks?.events ?? [];
  if (events.length === 0) return;

  const byTopic = new Map(catalogue.map((entry) => [entry.topic, entry.anyOf]));
  // A write scope covers its read, the way the platform expands a grant.
  const requested = new Set(
    manifest.oauth.scopes.flatMap((scope) =>
      scope.endsWith(':write') ? [scope, `${scope.slice(0, -':write'.length)}:read`] : [scope],
    ),
  );

  const problems: string[] = [];
  for (const topic of new Set(events)) {
    const anyOf = byTopic.get(topic);
    if (!anyOf) {
      problems.push(`webhooks.events: ${topic} is not an event the platform sends`);
      continue;
    }
    if (!anyOf.some((scope) => requested.has(scope))) {
      problems.push(
        `webhooks.events: ${topic} needs ${anyOf.join(' or ')}, which oauth.scopes does not request`,
      );
    }
  }

  if (problems.length > 0) {
    throw new ManifestError(problems.join('\n'), problems);
  }
}

/**
 * Checks declared relations against the platform's graph vocabulary.
 *
 * Separate from parsing for the reason scopes are: the relation set is the
 * platform's, and a copy pinned inside a published SDK would eventually be
 * wrong. Held to the same standard as a scope rather than waved through,
 * because a relation the graph does not recognise is an edge nothing will ever
 * read, and a plugin author deserves to be told that at validate time rather
 * than discover it by having contributed nothing for a fortnight.
 */
export function validateRelations(
  manifest: PluginManifest,
  knownRelations: readonly string[],
): void {
  const relations = manifest.knowledge?.relations ?? [];
  if (relations.length === 0) return;

  const known = new Set(knownRelations);
  const unknown = [...new Set(relations.filter((relation) => !known.has(relation)))];

  if (unknown.length > 0) {
    throw new ManifestError(
      `Unknown relations: ${unknown.join(', ')}.\nAvailable relations:\n  ${knownRelations.join('\n  ')}`,
      unknown,
    );
  }
}
