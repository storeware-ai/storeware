import { z } from 'zod';
import { manifestSchema } from './manifest';

/**
 * `storeware.app.toml` as JSON Schema, for editors and for the docs.
 *
 * The zod schema in `manifest.ts` is the rule; this is its published form.
 * Its descriptions are written here, for an app author, rather than taken
 * from the comments beside the zod fields, which explain the rules to whoever
 * maintains them. `manifest-schema.test.ts` holds the two together: every key
 * the schema has needs a line here, and a line for a key it does not have
 * fails. The checked-in copy at `schema/storeware.app.schema.json` is what
 * storeware.ai/docs serves; the same test fails when it is stale, and
 * `pnpm --filter @storeware/plugin-sdk schema:write` rewrites it.
 */

export const MANIFEST_SCHEMA_URL = 'https://storeware.ai/docs/schemas/storeware.app.json';

const CURRENCIES = {
  usd: 'US dollars, in cents.',
  gbp: 'Pounds sterling, in pence.',
  eur: 'Euros, in cents.',
  inr: 'Indian rupees, in paise.',
} as const;

const inEveryCurrency = (path: string): Record<string, string> =>
  Object.fromEntries(Object.entries(CURRENCIES).map(([code, words]) => [`${path}.${code}`, words]));

/** One line for each key, by its path; `[]` stands for any entry of a list. */
export const MANIFEST_DESCRIPTIONS: Readonly<Record<string, string>> = {
  manifest_version: 'Which shape of manifest this is. Write 2.',

  app: 'Who the app is and where it lives.',
  'app.slug':
    'Your client id. Lower case letters, digits and hyphens, 2 to 63 characters. It never changes.',
  'app.name': 'What merchants see on the consent screen and in their Apps list.',
  'app.description': 'A sentence or two for merchants.',
  'app.homepage_url': 'Your public site, shown to merchants.',
  'app.url':
    'Your home inside the admin, opened full height with a session token. With it, merchants install from Storeware.',
  'app.navigation': 'Up to five pages inside your home, listed under it in the admin.',
  'app.navigation[].label': 'The link text, up to 30 characters.',
  'app.navigation[].path': 'A path inside your home, starting with /.',
  'app.privacy_policy_url': 'Your privacy policy, shown to merchants.',
  'app.support_url': 'Where merchants get help, shown to merchants.',

  oauth: 'What the app may reach.',
  'oauth.redirect_uris':
    'Where an install that starts on your own site returns to, matched exactly. Not needed when app.url is set.',
  'oauth.scopes':
    'The permissions the app asks for. A merchant grants all of them or does not install.',

  privacy: 'Where data requests and erasures are posted.',
  'privacy.url':
    'Receives the compliance events. Needed when the app reads customer or order data.',

  billing: 'What the app charges, collected by Storeware on the merchant’s bill.',
  'billing.mode':
    'managed: Storeware shows your plans at install and on your app’s page. api: your app asks for each charge.',
  'billing.plans': 'Up to six plans.',
  'billing.plans[].key': 'What your app asks for, in lower_snake_case.',
  'billing.plans[].name': 'What the merchant reads, up to 40 characters.',
  'billing.plans[].description': 'One line under the name.',
  'billing.plans[].interval': 'month or year. Charged in advance.',
  'billing.plans[].prices':
    'The price in all four currencies, in minor units, each set by hand. Leave it out for a free plan.',
  ...inEveryCurrency('billing.plans[].prices'),
  'billing.plans[].trial_days': 'Days before the first charge, up to 90, once per shop.',
  'billing.plans[].features': 'Up to eight short lines shown with the plan.',
  'billing.plans[].usage':
    'Charges by use on top of the plan, billed at the end of each period, never more than the cap. Needs billing.mode api.',
  'billing.plans[].usage.cap': 'The most one period can cost, in all four currencies.',
  ...inEveryCurrency('billing.plans[].usage.cap'),
  'billing.plans[].usage.terms': 'What the merchant reads about the rate, such as 2 cents a label.',

  webhooks: 'Where events are posted, and which ones.',
  'webhooks.url': 'Where events are posted. Redirects are never followed.',
  'webhooks.events': 'Topics to receive. Each needs a scope that reads the same data.',

  extensions: 'Panels in the admin and blocks on the shop front.',
  'extensions.admin': 'Panels and actions your app adds to the admin.',
  'extensions.admin[].point':
    'Where in the admin it appears: a panel beside a record, an action in a record’s Apps menu, or an action on the rows ticked in a list.',
  'extensions.admin[].url': 'The page framed in the panel, or in the window an action opens.',
  'extensions.admin[].title': 'The panel’s heading, or the action’s name in the menu.',
  'extensions.storefront': 'Blocks your app adds to the shop front.',
  'extensions.storefront[].block': 'Where on the shop front the block appears.',
  'extensions.storefront[].url': 'Where Storeware asks for the block’s content.',
  'extensions.storefront[].format':
    'html, sanitised to text, lists, tables and links, or components, drawn in the shop’s own style.',
  'extensions.sections':
    'Up to ten sections a merchant can place on any page from the page editor.',
  'extensions.sections[].handle': 'The section’s key, in lower_snake_case. It never changes.',
  'extensions.sections[].name': 'What the merchant sees in the page editor, up to 40 characters.',
  'extensions.sections[].description': 'One line about the section, shown in the page editor.',
  'extensions.sections[].url': 'Where Storeware asks for the section’s content.',
  'extensions.sections[].format': 'components (the default) or html.',

  settings: 'Up to 30 fields a merchant fills in on your app’s page in their settings.',
  'settings[].key': 'The field’s key, in lower_snake_case. Your app reads it by this.',
  'settings[].label': 'What the merchant reads beside the box, up to 60 characters.',
  'settings[].help': 'One line under the box.',
  'settings[].type':
    'The kind of value. A secret is kept encrypted and shown to the merchant only as set.',
  'settings[].required': 'Whether the merchant must fill it in before saving.',
  'settings[].default': 'The value before the merchant changes it. A secret has none.',
  'settings[].options': 'For a select, the choices: from 2 to 30.',
  'settings[].options[].value': 'What your app reads.',
  'settings[].options[].label': 'What the merchant reads.',

  app_proxy: 'Pages under the shop’s own address, at /apps/your-slug/.',
  'app_proxy.url':
    'Where Storeware forwards each request, signed and without the shopper’s cookies.',

  automations: 'Triggers and actions your app adds to the shop’s automations.',
  'automations.triggers': 'Up to 20 things that can start an automation, fired by your app.',
  'automations.triggers[].key': 'The trigger’s key, in lower_snake_case letters.',
  'automations.triggers[].label': 'What the merchant reads, such as A review was left.',
  'automations.triggers[].description': 'One line about when it fires.',
  'automations.triggers[].fields':
    'Up to 20 values the trigger carries, which a condition can test.',
  'automations.triggers[].fields[].key': 'The value’s key, in lower_snake_case.',
  'automations.triggers[].fields[].label': 'What the merchant reads.',
  'automations.triggers[].fields[].type': 'The kind of value.',
  'automations.actions': 'Up to 20 steps a merchant can add to an automation.',
  'automations.actions[].key': 'The action’s key, in lower_snake_case letters.',
  'automations.actions[].label': 'What the merchant reads, such as Send a text.',
  'automations.actions[].description': 'One line about what it does.',
  'automations.actions[].url': 'Where Storeware posts the step, signed, with an idempotency key.',
  'automations.actions[].fields': 'Up to 20 values the merchant fills in for the step.',
  'automations.actions[].fields[].key': 'The value’s key, in lower_snake_case.',
  'automations.actions[].fields[].label': 'What the merchant reads.',
  'automations.actions[].fields[].type': 'The kind of value.',
  'automations.actions[].fields[].required': 'Whether the step needs it.',
  'automations.actions[].fields[].options': 'For a select, the choices: from 2 to 30.',
  'automations.actions[].fields[].options[].value': 'What your app receives.',
  'automations.actions[].fields[].options[].label': 'What the merchant reads.',

  checkout: 'Where your app takes part in checkout.',
  'checkout.delivery_rates':
    'Delivery choices your app offers. If it fails or is slow, the shop’s own rates are shown.',
  'checkout.delivery_rates.url':
    'Where Storeware asks for rates, with the basket and address. Needs checkout:read.',

  runtime: 'Run your app on Storeware, free, at https://<slug>.storewareapps.com. In beta.',
  'runtime.main': 'The file `storeware app deploy` bundles. Defaults to src/worker.ts.',
  'runtime.egress':
    'Hosts your code may call besides Storeware’s API, such as api.example.com. Nothing else is reachable.',
  'runtime.bundle': 'The bundle’s SHA-256, written by `storeware app deploy`. Do not edit it.',

  knowledge:
    'What your app knows about products, merged into search and every AI agent’s view of the catalogue.',
  'knowledge.url': 'Where Storeware asks your app about a product.',
  'knowledge.attributes': 'Attribute keys your app may set, in lower_snake_case.',
  'knowledge.relations': 'Relations your app may assert between two products.',
  'knowledge.scopes': 'Scopes these calls use.',

  metafields: 'Typed fields your app keeps on a merchant’s records.',
  'metafields.definitions': 'Up to 50 fields.',
  'metafields.definitions[].owner_type': 'The kind of record the field belongs to.',
  'metafields.definitions[].key': 'The field’s key, in lower_snake_case.',
  'metafields.definitions[].name': 'What a merchant sees.',
  'metafields.definitions[].description': 'A longer note for the merchant.',
  'metafields.definitions[].type': 'The kind of value the field holds.',
  'metafields.definitions[].is_list': 'Whether the field holds a list of values.',
  'metafields.definitions[].storefront_visible':
    'Whether shoppers see it. Never allowed for customer or order fields.',
  'metafields.scopes': 'Scopes these writes use.',

  mcp: 'Tools your app adds to every assistant on a shop.',
  'mcp.tools': 'The tools.',
  'mcp.tools[].name': 'The tool’s name, in lower_snake_case.',
  'mcp.tools[].description': 'What the tool does, for the model choosing it.',
  'mcp.tools[].url': 'Where Storeware calls the tool.',
  'mcp.tools[].scopes': 'Scopes the tool uses.',
  'mcp.tools[].input_schema': 'The tool’s arguments, as JSON Schema.',
};

type JsonSchemaNode = {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  [key: string]: unknown;
};

/** Every key path in a JSON Schema, in the notation `MANIFEST_DESCRIPTIONS` uses. */
export function schemaPaths(node: JsonSchemaNode, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path, ...schemaPaths(child, path));
  }
  if (node.items) paths.push(...schemaPaths(node.items, `${prefix}[]`));
  return paths;
}

function describe(node: JsonSchemaNode, prefix = ''): void {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    const words = MANIFEST_DESCRIPTIONS[path];
    if (words) child.description = words;
    describe(child, path);
  }
  if (node.items) describe(node.items, `${prefix}[]`);
}

/**
 * The manifest as JSON Schema (draft 2020-12), as an author writes it:
 * `io: 'input'`, so a key with a default is optional rather than required.
 */
export function manifestJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(manifestSchema, { io: 'input' }) as JsonSchemaNode;
  describe(generated);
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: MANIFEST_SCHEMA_URL,
    title: 'storeware.app.toml',
    description:
      'The manifest of a Storeware app: what it is, what it may reach, and where Storeware calls it.',
    ...rest,
  };
}
