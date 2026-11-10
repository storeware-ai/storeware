import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedAppOrigin, MAX_BUNDLE_BYTES } from '@storeware/plugin-sdk/manifest';

/**
 * What `storeware init` writes.
 *
 * Each template is a folder of real files under `packages/cli/templates`,
 * shipped in the CLI's tarball and copied as they are, with the app's name put
 * in. Real files rather than strings, so the packed-package smoke test
 * (`scripts/pack-smoke.mjs`) can install each one against the SDK as published
 * and typecheck and build it: a renamed export fails CI, not a developer's
 * first five minutes.
 *
 * What differs by app is made here: the manifest, `package.json` (whose
 * `@storeware/*` versions are the ones this CLI was built beside), the README
 * and the `AGENTS.md` a coding agent reads first.
 */

export const TEMPLATES = ['node', 'typescript', 'react-router', 'nextjs', 'hosted'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

interface TemplateSpec {
  /** One line, for `storeware init --help` and the README. */
  readonly summary: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** `@storeware/*` packages, pinned to this CLI's release. */
  readonly storeware: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  /** Where to look first, for the agent and the README. */
  readonly layout: readonly (readonly [path: string, what: string])[];
  /** What `.gitignore` adds beside `node_modules` and `.env`. */
  readonly ignore: readonly string[];
  /** Run by Storeware rather than on a server of the developer's own. */
  readonly hosted?: true;
}

const TYPESCRIPT = '^5.9.3';
const NODE_TYPES = '^22.20.5';
const REACT = '^19.2.0';

const SPECS: Record<TemplateName, TemplateSpec> = {
  node: {
    summary: 'Plain JavaScript on node:http, with nothing to build.',
    scripts: {
      // No env file in dev: `storeware app dev` hands the server its own.
      dev: 'node --watch src/server.js',
      build: 'node --check src/server.js',
      start: 'node --env-file=.env src/server.js',
    },
    storeware: ['@storeware/plugin-sdk'],
    dependencies: {},
    devDependencies: {},
    layout: [['src/server.js', 'the whole server: webhooks, privacy requests and your home']],
    ignore: [],
  },
  typescript: {
    summary: 'TypeScript on Hono, compiled with tsc.',
    scripts: {
      dev: 'tsx watch src/server.ts',
      build: 'tsc',
      typecheck: 'tsc --noEmit',
      start: 'node --env-file=.env dist/server.js',
    },
    storeware: ['@storeware/plugin-sdk'],
    dependencies: { hono: '^4.13.16', '@hono/node-server': '^1.19.18' },
    devDependencies: { typescript: TYPESCRIPT, tsx: '^4.23.15', '@types/node': NODE_TYPES },
    layout: [['src/server.ts', 'the whole server: webhooks, privacy requests and your home']],
    ignore: ['dist'],
  },
  'react-router': {
    summary: 'React Router with a home in the admin built on App UI and App Bridge.',
    scripts: {
      dev: 'react-router dev',
      build: 'react-router build',
      typecheck: 'react-router typegen && tsc',
      start: 'react-router-serve ./build/server/index.js',
    },
    storeware: ['@storeware/plugin-sdk', '@storeware/app-bridge-react', '@storeware/app-ui'],
    dependencies: {
      'react-router': '^7.18.5',
      '@react-router/node': '^7.18.5',
      '@react-router/serve': '^7.18.5',
      react: REACT,
      'react-dom': REACT,
      isbot: '^5.2.2',
    },
    devDependencies: {
      '@react-router/dev': '^7.18.5',
      vite: '^7.3.7',
      typescript: TYPESCRIPT,
      '@types/react': REACT,
      '@types/react-dom': REACT,
      '@types/node': NODE_TYPES,
    },
    layout: [
      ['app/storeware.server.ts', 'the Storeware app and your webhook handlers'],
      ['app/routes/app.tsx', 'your home inside the admin'],
      ['app/routes/webhooks.ts', 'where webhooks arrive'],
      ['app/routes/privacy.ts', 'where privacy requests arrive'],
    ],
    ignore: ['build', '.react-router'],
  },
  nextjs: {
    summary: 'Next.js with a home in the admin built on App UI and App Bridge.',
    scripts: {
      dev: 'next dev -p 4000',
      build: 'next build',
      typecheck: 'next typegen && tsc --noEmit',
      start: 'next start -p 4000',
    },
    storeware: ['@storeware/plugin-sdk', '@storeware/app-bridge-react', '@storeware/app-ui'],
    dependencies: {
      next: '^16.4.5',
      react: REACT,
      'react-dom': REACT,
      'server-only': '^0.0.1',
    },
    devDependencies: {
      typescript: TYPESCRIPT,
      '@types/react': REACT,
      '@types/react-dom': REACT,
      '@types/node': NODE_TYPES,
    },
    layout: [
      ['lib/storeware.ts', 'the Storeware app and your webhook handlers'],
      ['app/app/[[...path]]/page.tsx', 'your home inside the admin'],
      ['app/webhooks/route.ts', 'where webhooks arrive'],
      ['app/privacy/route.ts', 'where privacy requests arrive'],
    ],
    ignore: ['.next', 'next-env.d.ts'],
  },
  hosted: {
    summary: 'Run by Storeware at its own address, with no server of yours. In beta.',
    scripts: {
      build: 'tsc',
      typecheck: 'tsc',
      deploy: 'storeware app deploy',
    },
    storeware: ['@storeware/plugin-sdk'],
    dependencies: {},
    devDependencies: { typescript: TYPESCRIPT },
    layout: [['src/worker.ts', 'the whole app: webhooks, privacy requests and your home']],
    ignore: [],
    hosted: true,
  },
};

export function templateSummary(name: TemplateName): string {
  return SPECS[name].summary;
}

export function isTemplate(name: string): name is TemplateName {
  return (TEMPLATES as readonly string[]).includes(name);
}

/** Set by the build (`scripts/build-package.mjs`): each package's version beside this CLI. */
declare const __STOREWARE_VERSIONS__: Record<string, string> | undefined;

/**
 * The version of each `@storeware/*` package this CLI was released with.
 *
 * Read from the packages themselves: the build writes them in, and run from
 * source it reads the workspace's `package.json` files. A pin typed into this
 * file is how the scaffold once asked for an SDK version that did not exist.
 */
export function storewareVersions(): Record<string, string> {
  if (typeof __STOREWARE_VERSIONS__ !== 'undefined') return __STOREWARE_VERSIONS__;
  const versions: Record<string, string> = {};
  for (const folder of ['plugin-sdk', 'app-bridge-react', 'app-ui', 'cli']) {
    const pkg = JSON.parse(
      readFileSync(new URL(`../../${folder}/package.json`, import.meta.url), 'utf8'),
    ) as { name: string; version: string };
    versions[pkg.name] = pkg.version;
  }
  return versions;
}

/** Beside `src/` when run from source, beside `dist/` when installed. */
function templatesFolder(): string {
  return fileURLToPath(new URL('../templates/', import.meta.url));
}

/**
 * Letters, digits, spaces and ordinary punctuation. The name is written into
 * TOML, JSX and a page title, and a quote or a brace in any of them is a
 * syntax error in somebody's first file.
 */
export function safeName(name: string): string {
  return name.replace(/["'`\\{}<>&$]/g, '').trim();
}

/** Every file a template copies, by path inside the new app, with the name put in. */
export function templateFiles(template: TemplateName, name: string): [string, string][] {
  const root = join(templatesFolder(), template);
  const files: [string, string][] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        files.push([
          relative(root, path).split('\\').join('/'),
          readFileSync(path, 'utf8').replaceAll('__APP_NAME__', name),
        ]);
      }
    }
  };
  walk(root);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

/** Everything `init` writes, the template's own files and those made here. */
export function scaffold(
  template: TemplateName,
  options: { slug: string; name: string; url: string },
): [string, string][] {
  const hosted = SPECS[template].hosted === true;
  return [
    [
      'storeware.app.toml',
      hosted
        ? hostedManifestTemplate(options.slug, options.name)
        : manifestTemplate(options.slug, options.name, options.url),
    ],
    ['package.json', packageTemplate(options.slug, template)],
    // A hosted app is handed what it needs by Storeware, so it has no env.
    ...(hosted ? [] : [['.env.example', envTemplate()] as [string, string]]),
    ['.gitignore', gitignoreTemplate(template)],
    ['README.md', readmeTemplate(options.name, template)],
    ['AGENTS.md', agentsTemplate(options.name, template)],
    ...templateFiles(template, options.name),
  ];
}

export function manifestTemplate(slug: string, name: string, url: string): string {
  return `# Everything Storeware knows about this app is declared here, in your own
# repository, so changing what it can reach is a reviewable diff.
#
# \`storeware app dev\` swaps every localhost origin below for a tunnel's in the
# copy it sends, so this file can name localhost and still be reached.

manifest_version = 2

[app]
slug = "${slug}"
name = "${name}"
description = "Describe what a merchant gets from installing this."
homepage_url = "${url}"
# Your home inside the admin, opened with a session your server trades for
# the shop's tokens. Installed from Storeware, the app needs no redirect.
url = "${url}/app"

[oauth]
# A merchant grants exactly these. Ask for the least you can work with; a long
# list is the most common reason an install is turned down. plugins:read and
# plugins:write are how a merchant manages apps, and no app may ask for them.
scopes = ["products:read"]

[webhooks]
# Every event needs a scope above that reads the same data: hearing about an
# order needs orders:read. Redirects are never followed, so this URL is final.
url = "${url}/webhooks"
events = ["product.created.v1", "product.updated.v1"]

# Where Storeware sends a customer's data request, an erasure, and a shop's
# deletion. Required once you ask for customer or order data.
[privacy]
url = "${url}/privacy"

# Uncomment to render a panel inside the admin. The URL must be on your own
# origin, and the session token on the request is what proves a real merchant
# is looking at it.
#
# [[extensions.admin]]
# point = "admin.product.detail.sidebar"
# url = "${url}/embed/product-sidebar"
# title = "${name}"

# Uncomment to add a tool to the MCP server of every store that installs you.
# Its scopes must be a subset of oauth.scopes above.
#
# [[mcp.tools]]
# name = "describe_product"
# description = "Returns a short plain-language summary of a product."
# url = "${url}/mcp/describe-product"
# scopes = ["products:read"]

# Uncomment to give the merchant's own assistant in the admin a tool. It is
# called the same way. Leave out read_only for a tool that changes things: it
# then runs only after the merchant says the assistant may.
#
# [[assistant.tools]]
# name = "summarise_reviews"
# description = "Summarises what shoppers say about a product in its reviews."
# url = "${url}/assistant/summarise-reviews"
# scopes = ["products:read"]
# read_only = true
`;
}

/**
 * A hosted app's manifest: every address on the app's own name under the
 * hosted domain, and a `[runtime]` table naming the code. `bundle` is not in
 * it, because `storeware app deploy` writes it into the copy it sends and
 * nowhere else.
 */
export function hostedManifestTemplate(slug: string, name: string): string {
  const origin = hostedAppOrigin(slug);
  return `# Everything Storeware knows about this app is declared here, in your own
# repository, so changing what it can reach is a reviewable diff.
#
# Storeware runs this app at ${origin}. \`storeware app deploy\`
# bundles the code named in [runtime] and sends it with this file, so a
# change of code is a new release, reviewed like any other.

manifest_version = 2

[app]
slug = "${slug}"
name = "${name}"
description = "Describe what a merchant gets from installing this."
homepage_url = "${origin}/"
# Your home inside the admin, opened with a session the SDK checks.
url = "${origin}/"

[oauth]
# A merchant grants exactly these. Ask for the least you can work with; a long
# list is the most common reason an install is turned down.
scopes = ["products:read"]

[webhooks]
# Every event needs a scope above that reads the same data: hearing about an
# order needs orders:read.
url = "${origin}/webhooks"
events = ["product.created.v1", "product.updated.v1"]

# Where Storeware sends a customer's data request, an erasure, and a shop's
# deletion. Required once you ask for customer or order data.
[privacy]
url = "${origin}/privacy"

[runtime]
# The file deploy bundles into one module. Hosting is in beta.
main = "src/worker.ts"
# Hosts your code may call besides Storeware's API, such as "api.example.com".
# Each one is shown to the merchant who installs the app, and nothing else is
# reachable from it.
egress = []
`;
}

export function packageTemplate(slug: string, template: TemplateName = 'node'): string {
  const spec = SPECS[template];
  const versions = storewareVersions();
  const storeware = Object.fromEntries(
    spec.storeware.map((name) => [name, `^${versions[name] ?? '1.0.0'}`]),
  );
  const sorted = (deps: Record<string, string>) =>
    Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(
    {
      name: slug,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: spec.scripts,
      dependencies: sorted({ ...storeware, ...spec.dependencies }),
      // The CLI too, so `npx @storeware/cli` in this folder runs the version the
      // app was made with, and never a package of that name from anybody else.
      devDependencies: sorted({
        '@storeware/cli': `^${versions['@storeware/cli'] ?? '1.0.0'}`,
        ...spec.devDependencies,
      }),
    },
    null,
    2,
  )}\n`;
}

export function gitignoreTemplate(template: TemplateName = 'node'): string {
  return ['node_modules', '.env', '.storeware', ...SPECS[template].ignore, ''].join('\n');
}

export function envTemplate(): string {
  return `# For running on a server of your own. Under \`storeware app dev\` these are
# set for you, a development secret included.
PORT=4000
STOREWARE_APP_URL=https://your-app.example.com
STOREWARE_CLIENT_ID=
STOREWARE_CLIENT_SECRET=
`;
}

export function readmeTemplate(name: string, template: TemplateName = 'node'): string {
  const spec = SPECS[template];
  if (spec.hosted) return hostedReadme(name, spec);
  return `# ${name}

A Storeware app (${spec.summary.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}). It
runs on your own servers and reaches a merchant's shop through the same public
API Storeware's own admin uses.

## Getting started

1. \`npm install\`
2. \`npx @storeware/cli login\` opens the admin to approve the sign-in. No account
   yet? It offers to make a developer account, with a development store, first.
3. \`npx @storeware/cli app dev -- npm run dev\` runs this app on a development store,
   through a tunnel, with its credentials in the environment. Open the link it
   prints to see your home inside the admin.
4. \`npx @storeware/cli store seed\` and \`npx @storeware/cli store test-order\` give it
   products, customers and orders to hear about.
5. \`npx @storeware/cli app preflight\` runs the checks a review runs, and
   \`npx @storeware/cli app submit\` sends the listing for review.

## Where things are

${spec.layout.map(([path, what]) => `- \`${path}\`: ${what}`).join('\n')}
- \`storeware.app.toml\`: the whole declaration, the permissions you may ask a
  merchant for, the events you want, and where you appear in the admin. Nothing
  is configured in a dashboard, so a change to any of it is a diff.

## Things that will bite you

Read a request's body only through the SDK. A signature is over the raw bytes,
and a parsed and re-serialised body never verifies.

Keep installations somewhere durable. Each shop's webhook and session secrets
are handed over once, and there is no endpoint that hands them back.

Refresh tokens rotate. The SDK writes each new pair to your installation
store before using it; a store that drops writes signs you out of that shop.
`;
}

/**
 * What a coding agent (Claude Code, Codex, Cursor) reads before it touches the
 * app: how to build, check and run it, and the few rules it would otherwise
 * learn by breaking them.
 */
export function agentsTemplate(name: string, template: TemplateName = 'node'): string {
  const spec = SPECS[template];
  if (spec.hosted) return hostedAgents(name, spec);
  const run = (script: string) => (spec.scripts[script] ? `npm run ${script}` : null);
  const checks = [run('typecheck'), run('build')].filter(Boolean);
  return `# ${name}: notes for coding agents

A Storeware app: ${spec.summary.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.
Storeware calls it over HTTPS (webhooks, privacy requests, its home inside the
admin), and it calls the shop back through the public API with
\`@storeware/plugin-sdk\`.

## Commands

- Install: \`npm install\`
- Check your work: ${checks.map((command) => `\`${command}\``).join(', then ')}
- Check the manifest: \`npx @storeware/cli validate\`
- Run it on a development store: \`npx @storeware/cli app dev -- npm run dev\` (the
  person must have run \`npx @storeware/cli login\` once)
- Send one signed event to the running app: \`npx @storeware/cli webhook trigger product.created.v1\`
- Run the checks a review runs: \`npx @storeware/cli app preflight\`

The Storeware docs are also an MCP server: \`npx @storeware/cli mcp\` answers docs
searches, reads any page as Markdown, and looks up the manifest schema and the
API. Prefer it to guessing a field name.

## Where things are

${spec.layout.map(([path, what]) => `- \`${path}\`: ${what}`).join('\n')}
- \`storeware.app.toml\`: scopes, events, URLs and admin panels. Change what the
  app may reach here and nowhere else, then run \`npx @storeware/cli validate\`.

## Rules

- Verify before trusting. Every request from Storeware is signed; let the SDK
  verify it (\`storeware.webhooks.handle\`, \`storeware.authenticateAdmin\`,
  \`storeware.verifyRequest\`) and pass it the raw request. Never parse the body
  first, and never remove a check that fails: a failing signature means the
  secret or the raw body is wrong.
- Ask for the fewest scopes. Every event in \`[webhooks] events\` needs a scope
  that reads the same data, and \`validate\` says which.
- Keep secrets on the server. \`STOREWARE_CLIENT_SECRET\` and each shop's tokens
  never reach a browser or a log line.
- Installations are kept in memory to start with, so a restart forgets every
  shop. Before shipping, give \`createStorewareApp\` an \`installations\` store over
  a database.
- Use the API through the SDK's client (\`client.get\`, \`client.post\`), which
  refreshes tokens. Paths are \`/api/v1/stores/{storeId}/...\`.
- Answer a webhook within a few seconds with a 2xx, and do slow work after.
`;
}

function hostedReadme(name: string, spec: TemplateSpec): string {
  return `# ${name}

A Storeware app that Storeware runs for you, at the address in
\`storeware.app.toml\`. There is no server to keep up: the code in
\`src/worker.ts\` is bundled and sent with each release. Hosting is in beta.

## Getting started

1. \`npm install\`
2. \`npx @storeware/cli login\` opens the admin to approve the sign-in. No account
   yet? It offers to make a developer account, with a development store, first.
3. \`npm run deploy\` bundles the code, uploads it and sends a release. Shops
   of yours that have the app take it straight away.
4. \`npx @storeware/cli app logs --console --follow\` shows what the code logs.
5. \`npx @storeware/cli app preflight\` runs the checks a review runs, and
   \`npx @storeware/cli app submit\` sends the listing for review.

## Where things are

${spec.layout.map(([path, what]) => `- \`${path}\`: ${what}`).join('\n')}
- \`storeware.app.toml\`: the whole declaration, the permissions you may ask a
  merchant for, the events you want, and the hosts your code may call. Nothing
  is configured in a dashboard, so a change to any of it is a diff.

## Things that will bite you

The code may call Storeware's API and the hosts in \`[runtime] egress\`, and
nothing else. Adding a host is a new release that each merchant approves.

Read a request's body only through the SDK. A signature is over the raw bytes,
and a parsed and re-serialised body never verifies.

A change of code is a new release. Shops that already have the app take it
when it reaches no further than before, and are asked when it does.
`;
}

function hostedAgents(name: string, spec: TemplateSpec): string {
  return `# ${name}: notes for coding agents

A Storeware app that Storeware hosts: ${spec.summary.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.
It is one module, \`src/worker.ts\`, whose default export has a
\`fetch(request, env)\` like a Cloudflare Worker. Storeware calls it over HTTPS
(webhooks, privacy requests, its home inside the admin), and it calls the shop
back through the public API with \`@storeware/plugin-sdk\`.

## Commands

- Install: \`npm install\`
- Check your work: \`npm run typecheck\`, then \`npm run build\`
- Check the manifest: \`npx @storeware/cli validate\`
- Ship it: \`npm run deploy\` bundles \`src/worker.ts\` with esbuild, uploads the
  bundle and sends the manifest as a new release (the person must have run
  \`npx @storeware/cli login\` once).
- See what the code logged: \`npx @storeware/cli app logs --console\`
- Run the checks a review runs: \`npx @storeware/cli app preflight\`

The Storeware docs are also an MCP server: \`npx @storeware/cli mcp\` answers docs
searches, reads any page as Markdown, and looks up the manifest schema and the
API. Prefer it to guessing a field name.

## Where things are

${spec.layout.map(([path, what]) => `- \`${path}\`: ${what}`).join('\n')}
- \`storeware.app.toml\`: scopes, events, URLs and \`[runtime]\`. Change what the
  app may reach here and nowhere else, then run \`npx @storeware/cli validate\`.

## Rules

- This is not Node. No \`fs\`, no \`process.env\`, no long-running server. Use
  web APIs (\`fetch\`, \`Request\`, \`Response\`, \`crypto.subtle\`) and what \`env\`
  hands you. A dependency that needs Node will not bundle.
- The code may reach Storeware's API and the hosts in \`[runtime] egress\`, and
  nothing else. Add a host there before calling it.
- Never write \`runtime.bundle\` in the manifest. Deploy fills it in the copy
  it sends.
- The bundle may be at most ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB. Keep dependencies few.
- Verify before trusting. Let the SDK verify every request
  (\`storeware.webhooks.handle\`, \`storeware.authenticateAdmin\`) and pass it the
  raw request. Never parse the body first.
- Ask for the fewest scopes. Every event in \`[webhooks] events\` needs a scope
  that reads the same data, and \`validate\` says which.
- Answer a webhook within a few seconds with a 2xx.
`;
}
