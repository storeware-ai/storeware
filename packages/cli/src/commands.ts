/**
 * Every command the CLI has, described once.
 *
 * This list is the source for the usage text, for `storeware help <command>`
 * and `--help`, for which flags take a value when argv is parsed, and for the
 * CLI reference in the developer docs. Adding a command, a flag or an example
 * here is the whole of documenting it.
 *
 * ## Why this file imports nothing
 *
 * The docs build imports it by path (`apps/docs/scripts/generate/cli.mts`),
 * outside this package and without its dependencies, and
 * `apps/docs/src/imports.test.ts` follows every import a generator reaches. A
 * file of data and small pure helpers can be read from anywhere; one that
 * imported the API client could not. `commands.test.ts` scans this source to
 * hold it.
 *
 * ## How the text is written
 *
 * Every summary and description is read in a terminal and on storeware.ai, so
 * each is held to the docs' copy rules: plain sentences, no dash standing in
 * for punctuation, and no exclamation marks. Backticks mark code, and are
 * printed as they are in a terminal. A `<` or `>` belongs in a value
 * placeholder, never inside backticks in prose, because the docs escape it.
 */

export interface CommandArg {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface CommandFlag {
  /** Without the leading `--`. */
  readonly name: string;
  /** The placeholder for the value, as in `<handle>`. Absent for a switch. */
  readonly value?: string;
  readonly description: string;
}

export interface Command {
  /** The path joined with dots, which is also the handler's key. */
  readonly id: string;
  readonly path: readonly string[];
  /** Other paths that run the same command. */
  readonly aliases?: readonly (readonly string[])[];
  readonly group: Group;
  /** One sentence: what the command does. */
  readonly summary: string;
  /** Positional arguments, in order. */
  readonly args: readonly CommandArg[];
  /** What follows a bare `--`, when the command runs it. */
  readonly passthrough?: string;
  readonly flags: readonly CommandFlag[];
  /** Command lines, each as it is typed after the program's name. */
  readonly examples: readonly string[];
  /** A docs page that explains the task the command is part of. */
  readonly guide?: { readonly title: string; readonly path: string };
}

/** The headings commands are listed under, in order. */
export const GROUPS = ['Signing in', 'Building an app', 'Development stores', 'Themes'] as const;
export type Group = (typeof GROUPS)[number];

/** Flags every command takes, read before the command runs. */
export const GLOBAL_FLAGS = [
  {
    name: 'api',
    value: '<url>',
    description: 'Use another API, for local development.',
  },
  {
    name: 'admin',
    value: '<url>',
    description: 'Use another admin, for local development.',
  },
  {
    name: 'help',
    description: "Show the command's help instead of running it.",
  },
] as const satisfies readonly CommandFlag[];

const MANIFEST = {
  name: 'manifest',
  required: false,
  description: 'The manifest. `storeware.app.toml` in this directory when not given.',
} as const;

const NAMING_MANIFEST = {
  name: 'manifest',
  required: false,
  description: 'The manifest that names the app, when `--app` is not given.',
} as const;

const APP = {
  name: 'app',
  value: '<slug>',
  description: "Which app, by slug. The one in this directory's manifest when not given.",
} as const;

const DEV_STORE = {
  name: 'store',
  value: '<handle>',
  description: 'Which development store, by handle or id. Your first one when not given.',
} as const;

const SHOP = {
  name: 'store',
  value: '<handle>',
  description: 'Which shop, by handle or id, when the organisation has more than one.',
} as const;

const FUNCTION_HANDLE = {
  name: 'handle',
  required: true,
  description: 'The function, by the handle it has under `[[functions]]` in the manifest.',
} as const;

const THEME_FILE = {
  name: 'file',
  required: false,
  description: 'The theme file. `theme.json` in this directory when not given.',
} as const;

const json = (what: string) =>
  ({ name: 'json', description: `Print ${what} as JSON, for a script.` }) as const;

const QUICKSTART = { title: 'Quickstart', path: '/get-started/quickstart' } as const;
const DEVELOPMENT_STORES = {
  title: 'Development stores',
  path: '/get-started/development-stores',
} as const;
const THEMES = { title: 'Themes', path: '/themes' } as const;
const FUNCTIONS = { title: 'Checkout functions', path: '/build-apps/checkout-functions' } as const;

export const COMMANDS = [
  {
    id: 'login',
    path: ['login'],
    group: 'Signing in',
    summary: 'Sign in by approving a code in the admin.',
    args: [],
    flags: [
      {
        name: 'no-browser',
        description: 'Print the link to approve at, without opening a browser.',
      },
      {
        name: 'signup',
        description:
          'Make a developer account first, with a development store, then approve. For somebody new to Storeware.',
      },
      {
        name: 'token',
        value: '<key>',
        description: 'Sign in with an access key instead of a code. Needs `--org`.',
      },
      {
        name: 'org',
        value: '<id>',
        description: 'The organisation the access key belongs to.',
      },
      {
        name: 'store',
        value: '<handle>',
        description: 'With `--token`, the shop theme commands use when they are not given one.',
      },
    ],
    examples: ['login', 'login --signup', 'login --no-browser'],
  },
  {
    id: 'logout',
    path: ['logout'],
    group: 'Signing in',
    summary: 'End this sign-in, on the server as well as here.',
    args: [],
    flags: [],
    examples: [],
  },
  {
    id: 'whoami',
    path: ['whoami'],
    group: 'Signing in',
    summary: 'Show who you are, in which organisation, and your apps.',
    args: [],
    flags: [],
    examples: [],
  },
  {
    id: 'init',
    path: ['init'],
    group: 'Building an app',
    summary: 'Scaffold an app, with a manifest and a server to start from.',
    args: [
      {
        name: 'directory',
        required: false,
        description:
          'Where to make it. This directory when not given. A file already there is kept.',
      },
    ],
    flags: [
      {
        name: 'slug',
        value: '<slug>',
        description: "The app's handle. Made from the directory's name when not given.",
      },
      {
        name: 'name',
        value: '<name>',
        description: 'The name merchants see. Made from the slug when not given.',
      },
      {
        name: 'url',
        value: '<url>',
        description:
          'Where your server runs. `http://localhost:4000` when not given. Not used by `--template hosted`.',
      },
      {
        name: 'template',
        value: '<name>',
        description:
          'What to start from: `node` (plain JavaScript, the default), `typescript` (Hono), `react-router`, `nextjs`, or `hosted` (run by Storeware, in beta). Each comes with an `AGENTS.md` for coding agents.',
      },
    ],
    examples: [
      'init my-app',
      'init my-app --template react-router',
      'init my-app --template nextjs --name "Size guide"',
      'init my-app --template hosted',
    ],
    guide: QUICKSTART,
  },
  {
    id: 'validate',
    path: ['validate'],
    group: 'Building an app',
    summary: 'Check a manifest, and its scopes and events when you are signed in.',
    args: [
      {
        name: 'manifest',
        required: false,
        description:
          'The manifest to check. `storeware.app.toml` in this directory when not given.',
      },
    ],
    flags: [],
    examples: ['validate', 'validate apps/size-guide/storeware.app.toml'],
    guide: { title: 'The manifest', path: '/build-apps/manifest' },
  },
  {
    id: 'app.import-shopify',
    path: ['app', 'import-shopify'],
    group: 'Building an app',
    summary:
      "Write a storeware.app.toml from a Shopify app's shopify.app.toml, and list what has no equivalent.",
    args: [],
    flags: [
      {
        name: 'from',
        value: '<file>',
        description:
          'The Shopify file to read. `shopify.app.toml` in this directory when not given. Extensions in the `extensions` folder beside it are read too.',
      },
      {
        name: 'out',
        value: '<file>',
        description:
          'Where to write the manifest. `storeware.app.toml` beside the Shopify file when not given.',
      },
      {
        name: 'force',
        description: 'Replace a manifest that is already there.',
      },
      {
        name: 'plans',
        value: '<file>',
        description:
          'A JSON file of plans, each with a name, an amount in US dollars, an interval of `EVERY_30_DAYS` or `ANNUAL`, and trial days. Shopify keeps pricing in its Partner Dashboard, not in the file.',
      },
    ],
    examples: [
      'app import-shopify',
      'app import-shopify --from ../my-shopify-app/shopify.app.toml --out storeware.app.toml',
      'app import-shopify --plans plans.json --force',
    ],
    guide: { title: 'Coming from Shopify', path: '/get-started/coming-from-shopify' },
  },
  {
    id: 'app.dev',
    path: ['app', 'dev'],
    group: 'Building an app',
    summary: 'Run your app on a development store, through a tunnel to this machine.',
    args: [MANIFEST],
    passthrough:
      "The command that starts your server. It runs with your app's credentials and the tunnel's address in its environment.",
    flags: [
      {
        name: 'store',
        value: '<handle>',
        description:
          'Which development store, by handle or id. The one from last time, or your first, when not given. One is made if you have none.',
      },
      {
        name: 'tunnel',
        value: '<url>',
        description: 'A tunnel you run yourself, instead of cloudflared.',
      },
      {
        name: 'run',
        value: '"<command>"',
        description:
          'The command that starts your server, for a script runner that drops what follows `--`.',
      },
    ],
    examples: ['app dev -- npm run dev', 'app dev --store my-dev-store --run "npm start"'],
    guide: QUICKSTART,
  },
  {
    id: 'app.preflight',
    path: ['app', 'preflight'],
    group: 'Building an app',
    summary: 'Run the checks a review runs, against your app on a development store.',
    args: [NAMING_MANIFEST],
    flags: [
      APP,
      {
        name: 'store',
        value: '<handle>',
        description:
          'Which development store the app is installed on, by handle or id. The one `app dev` used when not given.',
      },
      json('each check and what it found'),
    ],
    examples: ['app preflight', 'app preflight --store my-dev-store'],
    guide: { title: 'Your listing', path: '/selling/listing' },
  },
  {
    id: 'app.submit',
    path: ['app', 'submit'],
    group: 'Building an app',
    summary: "Send your app's listing draft for review.",
    args: [NAMING_MANIFEST],
    flags: [APP, json('the version sent')],
    examples: ['app submit'],
    guide: { title: 'Your listing', path: '/selling/listing' },
  },
  {
    id: 'mcp',
    path: ['mcp'],
    group: 'Building an app',
    summary:
      'Serve the docs, the manifest schema and your app to a coding agent, over MCP on stdio.',
    args: [],
    flags: [],
    examples: ['mcp'],
    guide: { title: 'Building with a coding agent', path: '/cli/mcp' },
  },
  {
    id: 'app.deploy',
    path: ['app', 'deploy'],
    aliases: [['apply']],
    group: 'Building an app',
    summary:
      'Send a production release, with a hosted app’s code bundled and uploaded first, and say which shops take it.',
    args: [MANIFEST],
    flags: [
      {
        name: 'publish',
        description: 'Let merchants install it. Without this, it is a draft they cannot install.',
      },
    ],
    examples: ['app deploy', 'app deploy --publish'],
  },
  {
    id: 'app.releases',
    path: ['app', 'releases'],
    group: 'Building an app',
    summary: 'List releases, newest first, with how many shops run each.',
    args: [NAMING_MANIFEST],
    flags: [APP, json('the releases')],
    examples: ['app releases', 'app releases --json'],
  },
  {
    id: 'app.rollback',
    path: ['app', 'rollback'],
    group: 'Building an app',
    summary: 'Make an earlier production release the current one again.',
    args: [
      {
        name: 'version',
        required: true,
        description: 'The production release to bring back, as `app releases` lists it.',
      },
    ],
    flags: [APP],
    examples: ['app rollback 3'],
  },
  {
    id: 'app.logs',
    path: ['app', 'logs'],
    group: 'Building an app',
    summary: 'Show the API calls your app made, newest last.',
    args: [NAMING_MANIFEST],
    flags: [
      APP,
      {
        name: 'console',
        description:
          "Show what a hosted app's code logged instead, with how each run ended. Hosting is in beta.",
      },
      {
        name: 'store',
        value: '<handle>',
        description: 'Only calls on this development store, by handle or id.',
      },
      {
        name: 'failed',
        description:
          'Only calls that failed, with a 4xx or 5xx status. With `--console`, also runs that stopped early or logged an error.',
      },
      {
        name: 'follow',
        description: 'Keep printing calls as they are made, until you stop it.',
      },
      {
        name: 'json',
        description:
          'Print the calls as JSON, for a script. Not with `--follow`, except with `--console`, which prints one entry per line.',
      },
    ],
    examples: ['app logs', 'app logs --follow --failed', 'app logs --console --follow'],
  },
  {
    id: 'webhook.trigger',
    path: ['webhook', 'trigger'],
    group: 'Building an app',
    summary: 'Send your app one signed event from a development store.',
    args: [
      {
        name: 'topic',
        required: true,
        description:
          'The topic to send, such as `order.paid.v1`. A sample is sent when your stores have none yet.',
      },
    ],
    flags: [
      {
        name: 'store',
        value: '<handle>',
        description: 'Which development store it comes from. Your first one when not given.',
      },
      APP,
      json('what was sent and how your app answered'),
    ],
    examples: ['webhook trigger order.paid.v1'],
    guide: { title: 'Webhooks', path: '/webhooks' },
  },
  {
    id: 'function.sample',
    path: ['function', 'sample'],
    group: 'Building an app',
    summary: 'Print a sample input for a kind of checkout function, as JSON.',
    args: [
      {
        name: 'kind',
        required: true,
        description:
          'The kind: `discount`, `delivery_rates`, `payment_methods` or `cart_validation`.',
      },
    ],
    flags: [],
    examples: ['function sample discount', 'function sample cart_validation'],
    guide: FUNCTIONS,
  },
  {
    id: 'function.run',
    path: ['function', 'run'],
    group: 'Building an app',
    summary:
      'Run one of your checkout functions on this machine, with no network, and check its answer.',
    args: [FUNCTION_HANDLE, MANIFEST],
    flags: [
      {
        name: 'input',
        value: '<file>',
        description: 'A JSON file to hand it. A sample for its kind when not given.',
      },
      json('the answer, the time it took and any problems'),
    ],
    examples: ['function run volume_discount', 'function run volume_discount --input basket.json'],
    guide: FUNCTIONS,
  },
  {
    id: 'function.replay',
    path: ['function', 'replay'],
    group: 'Building an app',
    summary:
      'Run one of your checkout functions on the baskets a development store priced recently.',
    args: [FUNCTION_HANDLE, MANIFEST],
    flags: [
      {
        name: 'store',
        value: '<handle>',
        description:
          'Which development store, by handle or id. The one `app dev` used, or your only one, when not given.',
      },
      {
        name: 'limit',
        value: '<n>',
        description: 'How many baskets, newest first. 20 when not given, and at most 50.',
      },
      json('each basket and what the function answered'),
    ],
    examples: ['function replay volume_discount', 'function replay packs_of_six --limit 50'],
    guide: FUNCTIONS,
  },
  {
    id: 'store.list',
    path: ['store', 'list'],
    group: 'Development stores',
    summary: 'List your development stores.',
    args: [],
    flags: [json('the stores')],
    examples: ['store list'],
    guide: DEVELOPMENT_STORES,
  },
  {
    id: 'store.create',
    path: ['store', 'create'],
    group: 'Development stores',
    summary: 'Make a store that never opens and takes test payments only.',
    args: [{ name: 'name', required: true, description: 'What to call it.' }],
    flags: [json('the new store')],
    examples: ['store create "Size guide test shop"'],
    guide: DEVELOPMENT_STORES,
  },
  {
    id: 'store.seed',
    path: ['store', 'seed'],
    group: 'Development stores',
    summary: 'Fill a development store with sample products and customers.',
    args: [],
    flags: [DEV_STORE, json('what was added')],
    examples: ['store seed', 'store seed --store my-dev-store'],
    guide: DEVELOPMENT_STORES,
  },
  {
    id: 'store.test-order',
    path: ['store', 'test-order'],
    group: 'Development stores',
    summary: 'Place a real order, so your app gets real order events.',
    args: [],
    flags: [
      DEV_STORE,
      {
        name: 'paid',
        description: 'Also mark it paid, so `order.paid.v1` follows.',
      },
      {
        name: 'pay',
        value: '<outcome>',
        description:
          'Pay it by a test payment instead, ending the way you say: `approve`, `decline`, `needs_action` or `error`.',
      },
      json('the order'),
    ],
    examples: ['store test-order', 'store test-order --paid', 'store test-order --pay decline'],
    guide: { title: 'Test payments', path: '/get-started/test-payments' },
  },
  {
    id: 'theme.init',
    path: ['theme', 'init'],
    group: 'Themes',
    summary: 'Scaffold a theme, offline.',
    args: [
      {
        name: 'directory',
        required: false,
        description:
          'Where to make it. This directory when not given. A file already there is kept.',
      },
    ],
    flags: [
      {
        name: 'name',
        value: '<name>',
        description: "The theme's name. `A new theme` when not given.",
      },
    ],
    examples: ['theme init my-theme'],
    guide: THEMES,
  },
  {
    id: 'theme.validate',
    path: ['theme', 'validate'],
    group: 'Themes',
    summary: "Read a theme file with the platform's own parsers, offline.",
    args: [THEME_FILE],
    flags: [],
    examples: ['theme validate', 'theme validate my-theme/theme.json'],
    guide: THEMES,
  },
  {
    id: 'theme.pull',
    path: ['theme', 'pull'],
    group: 'Themes',
    summary: "Write this shop's published look to a file.",
    args: [
      {
        name: 'file',
        required: false,
        description: 'Where to write it. `theme.json` in this directory when not given.',
      },
    ],
    flags: [
      {
        name: 'out',
        value: '<file>',
        description: 'Where to write it, the same as giving the file.',
      },
      {
        name: 'name',
        value: '<name>',
        description: 'A name for the theme, written into the file.',
      },
      {
        name: 'force',
        description: 'Replace a file that is already there.',
      },
      SHOP,
    ],
    examples: ['theme pull', 'theme pull --store my-shop --force'],
    guide: THEMES,
  },
  {
    id: 'theme.push',
    path: ['theme', 'push'],
    group: 'Themes',
    summary: 'Send a theme file to the draft, which shoppers do not see.',
    args: [THEME_FILE],
    flags: [SHOP],
    examples: ['theme push', 'theme push my-theme/theme.json'],
    guide: THEMES,
  },
  {
    id: 'theme.preview',
    path: ['theme', 'preview'],
    group: 'Themes',
    summary: 'Print a link that serves the draft, retiring the last one.',
    args: [],
    flags: [SHOP],
    examples: ['theme preview'],
    guide: THEMES,
  },
  {
    id: 'theme.publish',
    path: ['theme', 'publish'],
    group: 'Themes',
    summary: 'Make the draft the shop, the one theme command a shopper sees.',
    args: [],
    flags: [
      {
        name: 'yes',
        description: 'Publish. Without it, the command shows what is in the draft and stops.',
      },
      SHOP,
    ],
    examples: ['theme publish', 'theme publish --yes'],
    guide: THEMES,
  },
] as const satisfies readonly Command[];

export type CommandId = (typeof COMMANDS)[number]['id'];

/** The command a command line names, and how many of its words name it. */
export function findCommand(
  words: readonly string[],
): { command: (typeof COMMANDS)[number]; length: number } | undefined {
  let found: { command: (typeof COMMANDS)[number]; length: number } | undefined;
  for (const command of COMMANDS) {
    const paths: readonly (readonly string[])[] = [
      command.path,
      ...('aliases' in command ? command.aliases : []),
    ];
    for (const path of paths) {
      const matches = path.length <= words.length && path.every((word, i) => words[i] === word);
      if (matches && (!found || path.length > found.length))
        found = { command, length: path.length };
    }
  }
  return found;
}

/**
 * Where a command takes the manifest's path among its arguments, or -1 when
 * it takes none and reads the one in the working directory.
 *
 * `app rollback 3` and `webhook trigger order.paid.v1` find their app from
 * the manifest too, but their first argument is a version and a topic. Reading
 * argument zero as the manifest whatever the command was looked for a file
 * called `3`.
 */
export function manifestArgument(command: Command): number {
  return command.args.findIndex((arg) => arg.name === 'manifest');
}

/** Whether a word is the first of a command that has more than one, like `app`. */
export function isGroupWord(word: string | undefined): boolean {
  return COMMANDS.some((command) => command.path.length > 1 && command.path[0] === word);
}

/** Every flag that takes a value, on any command. The parser reads these. */
export function valuedFlags(): string[] {
  const all: readonly CommandFlag[] = [
    ...GLOBAL_FLAGS,
    ...COMMANDS.flatMap((command): readonly CommandFlag[] => command.flags),
  ];
  return [...new Set(all.filter((flag) => flag.value !== undefined).map((flag) => flag.name))];
}

export function argLabel(arg: CommandArg): string {
  return arg.required ? `<${arg.name}>` : `[${arg.name}]`;
}

export function flagLabel(flag: CommandFlag): string {
  return flag.value === undefined ? `--${flag.name}` : `--${flag.name} ${flag.value}`;
}

export const PASSTHROUGH_LABEL = '-- <command>';

/**
 * How a command is typed: `storeware app dev [manifest] [flags] [-- <command>]`.
 *
 * `flags: false` leaves out `[flags]`, for a list of commands where every line
 * would carry it.
 */
export function synopsis(command: Command, program: string, options = { flags: true }): string {
  return [
    program,
    ...command.path,
    ...command.args.map(argLabel),
    ...(options.flags && command.flags.length > 0 ? ['[flags]'] : []),
    ...(command.passthrough === undefined ? [] : [`[${PASSTHROUGH_LABEL}]`]),
  ].join(' ');
}

/** The command's page in the docs, under `/cli/commands/`. */
export function pageOf(command: Command): string {
  return command.path.join('-');
}
