#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  hostedAppOrigin,
  ManifestError,
  parseManifest,
  validateEvents,
  validateScopes,
} from '@storeware/plugin-sdk/manifest';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import {
  ApiError,
  applyManifest,
  createDevelopmentStore,
  createTestOrder,
  fetchMe,
  fetchEvents,
  fetchRuntimeLogs,
  fetchScopes,
  listAppRequests,
  listDevelopmentStores,
  listMyPlugins,
  listReleases,
  promoteRelease,
  runPreflight,
  seedDevelopmentStore,
  submitListing,
  signOut,
  triggerWebhook,
  uploadBundle,
  type ApplyResult,
  type AppRequest,
} from './api';
import { parseArgs } from './args';
import { findCommand, isGroupWord, manifestArgument, type CommandId } from './commands';
import { commandHelp, THEME_USAGE, USAGE, usageLine } from './help';
import { describeTestOrder, payFlag } from './test-orders';
import {
  clearCredentials,
  loadConfig,
  requireCredentials,
  saveConfig,
  NotAuthenticatedError,
  type Credentials,
} from './config';
import { DevError, runDev } from './dev';
import { LoginError, pollForTokens, startDeviceLogin } from './oauth';
import { THEME_COMMANDS, ThemeError } from './theme';
import { isTemplate, safeName, scaffold, storewareVersions, TEMPLATES } from './scaffold';
import { serveMcp } from './mcp';
import { CloudflaredError } from './cloudflared';
import {
  bundleHostedApp,
  consoleFailed,
  consoleLine,
  HostingError,
  withRuntimeBundle,
  type ConsoleEntry,
} from './hosting';

/**
 * The storeware CLI.
 *
 * Five verbs for a plugin author, because that loop is only five steps:
 * scaffold, validate, register, check, sign in. Anything else belongs in the
 * partner portal, where it can be looked at rather than remembered.
 *
 * `theme` is a group rather than a verb, and it is the one place that shape was
 * worth breaking. A theme has its own loop -- scaffold, read, send, look,
 * publish -- against a different noun, and flattening it would have meant
 * `storeware validate` doing two unrelated things depending on what happened to
 * be in the working directory.
 *
 * Argument parsing is hand-rolled, in `./args`. A dependency here would ship in
 * the published binary, and the surface is a dozen flags.
 *
 * Every command is described once, in `./commands`. The usage text, `help`,
 * which flags take a value, and the CLI reference in the docs are all read
 * from there. This file holds what each command does, in `HANDLERS`, which the
 * type checker holds to one handler per command in the registry.
 */

const out = (text: string) => process.stdout.write(`${text}\n`);
const err = (text: string) => process.stderr.write(`${text}\n`);

/*
 * Everything after a bare `--` is a command to run, not arguments to read:
 * `storeware app dev -- npm run dev`.
 */
const separator = process.argv.indexOf('--');
const passthrough = separator === -1 ? [] : process.argv.slice(separator + 1);
const argv = separator === -1 ? process.argv : process.argv.slice(0, separator);

const verb = argv[2];

/**
 * The command argv names, matched word by word against the registry.
 *
 * Matched BEFORE argv is split, because the match says where the arguments
 * start: `storeware theme push file.json` names its command in two words and
 * leaves the parser everything after them, while `storeware apply file.toml`
 * names it in one. A word that starts with `--` never names a command, so
 * `storeware theme --help` matches nothing and prints the group's usage.
 */
const found = findCommand(argv.slice(2));

/*
 * When nothing matched, a group's word followed by one this CLI does not know:
 * `storeware app nonsense`. It is skipped over like a real subcommand would be,
 * and it is what makes the usage that follows an error.
 */
const next = argv[3];
const subcommand =
  found === undefined && isGroupWord(verb) && next !== undefined && !next.startsWith('--')
    ? next
    : undefined;

const args = parseArgs(argv.slice(2 + (found?.length ?? (subcommand === undefined ? 1 : 2))));

const flag = (name: string): string | undefined => args.flag(name);
const has = (name: string): boolean => args.has(name);
const positional = (index: number): string | undefined => args.positional(index);

/**
 * Where the person ran the command. `pnpm storeware` from the repository root
 * runs this in the CLI's own package; pnpm and npm both say where it was
 * really typed in INIT_CWD.
 */
function workingDirectory(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

/**
 * The manifest a command names, or the one in the working directory, which is
 * the usual case. Only from the argument the command declares as the manifest
 * (`manifestArgument`), so a version or a topic is never read as a path.
 */
function manifestPath(): string {
  const at = found ? manifestArgument(found.command) : -1;
  return resolve(
    workingDirectory(),
    (at >= 0 ? positional(at) : undefined) ?? 'storeware.app.toml',
  );
}

async function readManifest(): Promise<string> {
  const path = manifestPath();
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(`No manifest at ${path}. Run \`storeware init\` to create one.`);
  }
}

async function init(): Promise<void> {
  const directory = resolve(workingDirectory(), positional(0) ?? '.');
  const template = flag('template') ?? 'node';
  if (!isTemplate(template)) {
    throw new Error(`No template called ${template}. Choose one of: ${TEMPLATES.join(', ')}.`);
  }
  const slug = (flag('slug') ?? basename(directory))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = safeName(
    flag('name') ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  );
  const url = flag('url') ?? 'http://localhost:4000';
  if (template === 'hosted' && !slug) {
    throw new Error('A hosted app needs a slug for its address. Pass `--slug <slug>`.');
  }

  for (const [file, contents] of scaffold(template, { slug, name, url })) {
    const path = join(directory, file);
    // Never overwrite. Running init in an existing project should add what is
    // missing, not silently replace somebody's server.
    try {
      await readFile(path, 'utf8');
      out(`  skipped  ${file} (already exists)`);
    } catch {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, 'utf8');
      out(`  created  ${file}`);
    }
  }

  // Relative when it is near, as the person typed it; whole when it is not.
  const near = relative(workingDirectory(), directory);
  const into = near.startsWith('..') ? directory : near;
  out(
    `\nScaffolded ${name} from the ${template} template.\n\n` +
      (into ? `  cd ${into}\n` : '') +
      '  npm install\n' +
      '  npx @storeware/cli login                 approve this CLI in the admin\n' +
      (template === 'hosted'
        ? '  npm run deploy                           bundle the code and send a release\n' +
          `\n  Storeware runs it at ${hostedAppOrigin(slug)}. Hosting is in beta.\n`
        : '  npx @storeware/cli app dev -- npm run dev run it on a development store\n'),
  );
}

async function validate(): Promise<void> {
  const source = await readManifest();
  const manifest = parseManifest(source);

  const config = await loadConfig();

  // Scope names are checked against the live vocabulary when we can reach it.
  // A copy pinned in the CLI would be wrong within a release, and being wrong
  // in the direction of "your valid scope is invalid" is worse than skipping.
  if (config.token && config.organizationId) {
    const credentials = requireCredentials(config);
    const [scopes, events] = await Promise.all([
      fetchScopes(credentials),
      fetchEvents(credentials),
    ]);
    validateScopes(
      manifest,
      scopes.map((s) => s.name),
    );
    validateEvents(manifest, events);
    out('Manifest is valid: every scope exists and covers the events it asks for.');
  } else {
    out('Manifest is structurally valid.');
    out('Sign in to also check scopes and events against the platform.');
  }

  out('');
  out(`  ${manifest.app.name}  (${manifest.app.slug})`);
  out(`  scopes        ${manifest.oauth.scopes.join(' ')}`);
  out(`  redirects     ${manifest.oauth.redirect_uris.join(', ')}`);
  out(`  events        ${manifest.webhooks?.events.join(' ') ?? 'none'}`);
  out(`  extensions    ${manifest.extensions?.admin?.length ?? 0} admin`);
  out(`  mcp tools     ${manifest.mcp?.tools?.length ?? 0}`);
  if (manifest.runtime) {
    out(
      `  hosted at     ${hostedAppOrigin(manifest.app.slug)} (beta), from ${manifest.runtime.main}`,
    );
    out(`  may call      ${manifest.runtime.egress.join(' ') || 'only Storeware'}`);
  }

  if (manifest.knowledge) {
    // Spelled out rather than counted, unlike the lines above. These are the
    // two lists a merchant is asked to approve, and an author should be able to
    // read back exactly what they are asking for before anybody is asked.
    out(`  contributes   attributes: ${manifest.knowledge.attributes.join(' ') || 'none'}`);
    out(`                relations:  ${manifest.knowledge.relations.join(' ') || 'none'}`);
  }
}

/**
 * The code of an app Storeware hosts, uploaded, and the manifest text to send
 * with its hash in `runtime.bundle`.
 *
 * A bundle is kept under its app, so an app that does not exist yet is
 * registered first, as a draft naming no bundle, and the code follows. That
 * draft is the one release the server lets go without code; nobody can
 * install it, and the release sent straight after replaces it.
 */
async function deployHostedCode(
  credentials: Credentials,
  source: string,
  slug: string,
  main: string,
): Promise<{ source: string; sha256: string; bytes: number; registered: ApplyResult | null }> {
  out(`Bundling ${main}`);
  const bundle = await bundleHostedApp(dirname(manifestPath()), main);
  let registered: ApplyResult | null = null;
  const upload = () => uploadBundle(credentials, slug, bundle.sha256, bundle.bytes);
  try {
    await upload();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    registered = await applyManifest(credentials, withRuntimeBundle(source, null), false);
    out(`Registered ${registered.clientId} as a draft, to keep its code under.`);
    await upload();
  }
  return {
    source: withRuntimeBundle(source, bundle.sha256),
    sha256: bundle.sha256,
    bytes: bundle.bytes.byteLength,
    registered,
  };
}

async function apply(): Promise<void> {
  const written = await readManifest();
  // Parsed locally first, so an obvious mistake is caught without a round trip
  // and without a half-written registration.
  const manifest = parseManifest(written);

  const credentials = requireCredentials(await loadConfig());
  const hosted = manifest.runtime
    ? await deployHostedCode(credentials, written, manifest.app.slug, manifest.runtime.main)
    : null;
  const source = hosted?.source ?? written;
  const sent = await applyManifest(credentials, source, has('publish'));
  // The secret is handed over once, by whichever call registered the app.
  const clientSecret = sent.clientSecret ?? hosted?.registered?.clientSecret;
  const result = {
    ...sent,
    created: sent.created || hosted?.registered?.created === true,
    ...(clientSecret ? { clientSecret } : {}),
  };

  out('');
  out(result.created ? `Registered ${result.clientId}` : `Updated ${result.clientId}`);
  out('');
  out(`  client_id      ${result.clientId}`);

  if (result.clientSecret) {
    out(`  client_secret  ${result.clientSecret}`);
    out('');
    out('  The secret is shown once. Store it now; it cannot be read back.');
  }

  out(`  scopes         ${result.scopes.join(' ')}`);
  out(`  extensions     ${result.extensions}`);
  out(`  mcp tools      ${result.mcpTools}`);
  if (result.release) {
    out(
      `  release        ${result.release.version}${result.release.created ? '' : ' (unchanged, same bytes)'}`,
    );
  }

  if (hosted) {
    out(`  hosted at      ${hostedAppOrigin(manifest.app.slug)}`);
    out(`  code           ${hosted.sha256.slice(0, 12)} (${Math.ceil(hosted.bytes / 1024)} KB)`);
  }

  if (result.removedScopes.length > 0) {
    out('');
    out(`  Dropped since the last version: ${result.removedScopes.join(', ')}.`);
  }

  const shops = result.installations;
  if (shops && shops.advanced + shops.pending > 0) {
    out('');
    if (shops.advanced > 0) {
      out(`  ${shops.advanced} shop(s) now run this release: it reaches no further than before.`);
    }
    if (shops.pending > 0) {
      out(
        `  ${shops.pending} shop(s) keep the release they approved until their merchant approves this one,`,
      );
      out('  because it asks for more: a new scope, event, host, panel, tool or field.');
    }
  }

  if (!has('publish')) {
    out('');
    out('  This is a draft, so merchants cannot install it. Add --publish when ready.');
  }
  if (hosted) {
    out('');
    out('  Hosting is in beta. `storeware app logs --console` shows what the code logs.');
  }
  out('');
}

async function whoami(): Promise<void> {
  const credentials = requireCredentials(await loadConfig());
  const me = await fetchMe(credentials);
  const organization = me.organizations.find(
    (o) => o.organizationId === credentials.organizationId,
  );

  out('');
  out(`  ${me.email}`);
  out(
    `  ${organization?.organizationName ?? credentials.organizationId} (${organization?.roleName ?? 'unknown role'})`,
  );
  out(`  ${credentials.apiUrl}`);

  const mine = await listMyPlugins(credentials);
  out('');
  if (mine.length === 0) {
    out('  No plugins published by this organisation yet.');
  } else {
    for (const plugin of mine) {
      out(`  ${plugin.slug}  ${plugin.status}  ${plugin.scopes.join(' ') || 'no scopes'}`);
    }
  }
  out('');
}

/** Opens a page in the person's browser, and says so if it cannot. */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, commandArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The link is printed above; opening it is a courtesy.
  }
}

/**
 * Signs in by device code: no key is pasted anywhere. The person approves in
 * the admin, where they are already signed in, and picks the organisation.
 */
async function deviceLogin(): Promise<void> {
  const config = await loadConfig();
  const start = await startDeviceLogin(config.apiUrl, `storeware CLI on ${hostname()}`);

  // Somebody new has nothing to approve with yet. The developer sign-up makes
  // an organisation, a profile and a development store, accepts the terms,
  // and then hands them to this same code to approve.
  const signup = `${config.adminUrl.replace(/\/$/, '')}/developers/start?code=${encodeURIComponent(start.userCode)}`;
  const open = has('signup') ? signup : start.verificationUriComplete;

  out('');
  out(`  Your code   ${start.userCode}`);
  out(`  Approve at  ${has('signup') ? signup : start.verificationUri}`);
  if (!has('signup')) out(`  New here?   ${signup}`);
  out('');
  if (!has('no-browser')) {
    openBrowser(open);
    out('  Opened in your browser. Check the code there matches this one.');
  }
  out('  Waiting for approval...');

  const pair = await pollForTokens(config.apiUrl, start);
  const path = await saveConfig({
    token: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: pair.expiresAt,
    organizationId: pair.organizationId,
    ...(flag('api') ? { apiUrl: flag('api')! } : {}),
    ...(flag('admin') ? { adminUrl: flag('admin')! } : {}),
  });
  const me = await fetchMe(requireCredentials(await loadConfig()));
  const organization = me.organizations.find((o) => o.organizationId === pair.organizationId);
  out('');
  out(
    `Signed in as ${me.email} in ${organization?.organizationName ?? pair.organizationId}. Saved to ${path}.`,
  );
}

async function logout(): Promise<void> {
  const config = await loadConfig();
  if (config.token && !process.env.STOREWARE_CLI_TOKEN && !process.env.STOREWARE_TOKEN) {
    await signOut(requireCredentials(config)).catch(() => undefined);
  }
  await clearCredentials();
  out('Signed out.');
}

async function login(): Promise<void> {
  const token = flag('token');
  const organizationId = flag('org');

  if (!token && !organizationId) return deviceLogin();
  if (!token || !organizationId) {
    err('Usage: storeware login');
    err('   or: storeware login --token <access key> --org <organisation id>');
    process.exitCode = 1;
    return;
  }

  await clearCredentials();
  const path = await saveConfig({
    token,
    organizationId,
    ...(flag('api') ? { apiUrl: flag('api')! } : {}),
    ...(flag('admin') ? { adminUrl: flag('admin')! } : {}),
    // Saved as typed, id or handle. It is resolved against the live list on
    // every command that uses it, so storing a handle here cannot go stale into
    // a wrong shop: a handle that no longer exists fails by name.
    ...(flag('store') ? { storeId: flag('store')! } : {}),
  });

  // Proved rather than assumed. Saving a token that does not work and finding
  // out on the next command wastes the developer's time, not ours.
  const me = await fetchMe(requireCredentials(await loadConfig()));
  out(`Signed in as ${me.email}. Credentials saved to ${path}.`);
}

const json = (value: unknown): void => {
  out(JSON.stringify(value, null, 2));
};

async function credentials(): Promise<Credentials> {
  return requireCredentials(await loadConfig());
}

/** The slug of the app in this directory, read from its manifest. */
async function slugHere(): Promise<string> {
  return flag('app') ?? parseManifest(await readManifest()).app.slug;
}

async function appDev(): Promise<void> {
  return runDev(await credentials(), {
    manifestPath: manifestPath(),
    store: flag('store'),
    tunnel: flag('tunnel'),
    // `--run "<command>"` for a runner that eats the `--`.
    command: flag('run') ? flag('run')!.split(/\s+/).filter(Boolean) : passthrough,
  });
}

async function appReleases(): Promise<void> {
  const releases = await listReleases(await credentials(), await slugHere());
  if (has('json')) return json(releases);
  out('');
  for (const release of releases) {
    const marks = [
      release.current ? 'current' : '',
      release.installs ? `${release.installs} shop(s)` : '',
      release.pendingApproval ? `${release.pendingApproval} waiting for approval` : '',
    ].filter(Boolean);
    out(
      `  ${release.channel === 'development' ? 'dev ' : ''}${release.version}  ${release.createdAt.slice(0, 16).replace('T', ' ')}  ${marks.join(', ')}`,
    );
  }
  out('');
}

async function appRollback(): Promise<void> {
  const version = Number(positional(0));
  const creds = await credentials();
  const slug = await slugHere();
  const target = (await listReleases(creds, slug)).find(
    (release) => release.channel === 'production' && release.version === version,
  );
  if (!target) throw new Error(`No production release ${positional(0) ?? ''} of ${slug}.`);
  await promoteRelease(creds, slug, target.id);
  out(`Release ${version} is current again. Shops that approved it run it; the rest are asked.`);
}

/**
 * `app logs --console`: what a hosted app's code logged, in the order it was
 * kept.
 *
 * `--store` and `--failed` are applied here rather than by the server, so a
 * page may print fewer lines than it fetched. Following pages from the cursor
 * each page hands back (`next`), the last line's place in the log, so no line
 * is skipped or printed twice however many share a moment.
 */
async function appConsole(creds: Credentials, slug: string): Promise<void> {
  const storeId = flag('store') ? (await devStore(creds)).id : null;
  const keep = (entry: ConsoleEntry) =>
    (!storeId || entry.storeId === storeId) && (!has('failed') || consoleFailed(entry));
  const first = await fetchRuntimeLogs(creds, slug, { limit: 100 });
  if (has('json') && !has('follow')) {
    return json({ logs: first.logs.filter(keep), next: first.next });
  }

  const show = (logs: ConsoleEntry[]) => {
    for (const entry of logs) {
      if (keep(entry)) out(has('json') ? JSON.stringify(entry) : consoleLine(entry));
    }
  };

  show(first.logs);
  if (!has('follow')) {
    if (first.logs.length === 0) out(`  Nothing logged by ${slug} yet.`);
    return;
  }
  // From where the first page ended, or, from a server that gave no cursor,
  // from now.
  let from: { after: string } | { since: string } = first.next
    ? { after: first.next }
    : { since: new Date().toISOString() };
  // Polls every two seconds until interrupted, at once while pages come full.
  for (;;) {
    const page = await fetchRuntimeLogs(creds, slug, { ...from, limit: 200 });
    show(page.logs);
    if (page.next) from = { after: page.next };
    if (page.logs.length < 200) await new Promise((done) => setTimeout(done, 2000));
  }
}

async function appLogs(): Promise<void> {
  const creds = await credentials();
  const slug = await slugHere();
  if (has('console')) return appConsole(creds, slug);
  const query = {
    ...(flag('store') ? { storeId: (await devStore(creds)).id } : {}),
    ...(has('failed') ? { failed: true } : {}),
  };
  const line = (call: AppRequest) =>
    `  ${call.createdAt.slice(11, 19)}  ${String(call.status).padEnd(3)}  ${call.method.padEnd(6)} ${call.path}  ${call.durationMs ?? '?'}ms  ${call.storeId.slice(0, 8)}`;
  const first = await listAppRequests(creds, slug, { ...query, limit: 50 });
  if (has('json') && !has('follow')) return json(first);
  for (const call of [...first].reverse()) out(line(call));
  if (!has('follow')) return;
  let after = first[0]?.id ?? 0;
  // Polls every two seconds until interrupted.
  for (;;) {
    await new Promise((done) => setTimeout(done, 2000));
    const newer = await listAppRequests(creds, slug, { ...query, after, limit: 200 });
    for (const call of [...newer].reverse()) out(line(call));
    after = newer[0]?.id ?? after;
  }
}

async function webhookTrigger(): Promise<void> {
  if (!positional(0)) {
    out(usageLine('webhook.trigger'));
    process.exitCode = 1;
    return;
  }
  const creds = await credentials();
  const store = await devStore(creds);
  const sent = await triggerWebhook(creds, await slugHere(), {
    topic: positional(0)!,
    storeId: store.id,
  });
  if (has('json')) return json(sent);
  out(
    `${sent.ok ? 'Delivered' : 'Not delivered'}: ${sent.topic} to ${sent.url}` +
      `${sent.status ? `, answered ${sent.status}` : ''}${sent.error ? `, ${sent.error}` : ''}` +
      `${sent.durationMs !== undefined ? ` in ${sent.durationMs}ms` : ''}.`,
  );
  out(
    sent.sample
      ? '  No real event of this kind on your development stores yet, so a stand-in marked sample: true was sent.'
      : '  The latest real event of this kind from your development stores, signed as a delivery is.',
  );
  if (!sent.ok) process.exitCode = 1;
}

async function devStore(creds: Credentials) {
  const stores = await listDevelopmentStores(creds);
  const named = flag('store');
  const store = named ? stores.find((s) => s.id === named || s.handle === named) : stores[0];
  if (!store) {
    throw new Error(
      named
        ? `No development store called ${named}.`
        : 'No development store yet. Run storeware store create <name>.',
    );
  }
  return store;
}

async function storeList(): Promise<void> {
  const creds = await credentials();
  const stores = await listDevelopmentStores(creds);
  if (has('json')) return json(stores);
  if (stores.length === 0) out('No development stores yet. Run storeware store create <name>.');
  for (const store of stores) out(`  ${store.handle}  ${store.name}`);
}

async function storeCreate(): Promise<void> {
  const creds = await credentials();
  const name = positional(0);
  if (!name) throw new Error(usageLine('store.create'));
  const store = await createDevelopmentStore(creds, name);
  if (has('json')) return json(store);
  out(
    `Made ${store.name} (${store.handle}). It never opens, and it takes test payments only, where no money moves.`,
  );
}

async function storeSeed(): Promise<void> {
  const creds = await credentials();
  const store = await devStore(creds);
  const seeded = await seedDevelopmentStore(creds, store.id);
  if (has('json')) return json(seeded);
  out(
    seeded.alreadySeeded
      ? `${store.handle} already has its sample data.`
      : `Added ${seeded.products} products and ${seeded.customers} customers to ${store.handle}.`,
  );
}

async function storeTestOrder(): Promise<void> {
  const creds = await credentials();
  // Read before anything is asked of the API, so a mistyped outcome
  // places no order.
  const pay = payFlag(flag('pay'), has('pay'));
  const store = await devStore(creds);
  const order = await createTestOrder(creds, store.id, has('paid'), pay);
  if (has('json')) return json(order);
  for (const line of describeTestOrder(store.handle, order)) out(line);
}

const MARK = { pass: 'pass', warn: 'warn', fail: 'FAIL', skipped: 'skip' } as const;

async function appPreflight(): Promise<void> {
  const creds = await credentials();
  const slug = await slugHere();
  const report = await runPreflight(
    creds,
    slug,
    flag('store') ? { storeId: (await devStore(creds)).id } : {},
  );
  if (has('json')) return json(report);
  out('');
  if (!report.storeId) {
    out(`  ${slug} is not installed on a development store, so only the manifest was read.`);
    out('  Run storeware app dev first, then preflight again.');
    out('');
  }
  for (const check of report.checks) {
    out(`  ${MARK[check.status].padEnd(5)} ${check.name.padEnd(19)} ${check.detail ?? ''}`);
  }
  out('');
  out(
    report.passed
      ? '  Nothing failed. A review runs these same checks.'
      : '  Something failed. Fix it and run preflight again: a review runs these same checks.',
  );
  if (!report.passed) process.exitCode = 1;
}

async function appSubmit(): Promise<void> {
  const creds = await credentials();
  const slug = await slugHere();
  const sent = await submitListing(creds, slug);
  if (has('json')) return json(sent);
  out(
    sent.state === 'published'
      ? `Listing version ${sent.version} of ${slug} is published. It needed no reviewer.`
      : `Listing version ${sent.version} of ${slug} is waiting for a reviewer.`,
  );
  if (typeof sent.queuePosition === 'number') out(`  Place in the queue: ${sent.queuePosition}.`);
  out(`  Follow it at ${creds.adminUrl.replace(/\/$/, '')}/developer/${slug}/review`);
}

async function mcp(): Promise<void> {
  await serveMcp(storewareVersions()['@storeware/cli'] ?? '0.0.0', workingDirectory());
}

type Handler = () => Promise<void>;

/** A theme command, given the arguments as the theme commands take them. */
const theme =
  (id: keyof typeof THEME_COMMANDS): Handler =>
  () =>
    THEME_COMMANDS[id](args);

/** What each command in `./commands` does. A command without one fails the type check. */
export const HANDLERS = {
  login,
  logout,
  whoami,
  init,
  validate,
  mcp,
  'app.dev': appDev,
  'app.preflight': appPreflight,
  'app.submit': appSubmit,
  'app.deploy': apply,
  'app.releases': appReleases,
  'app.rollback': appRollback,
  'app.logs': appLogs,
  'webhook.trigger': webhookTrigger,
  'store.list': storeList,
  'store.create': storeCreate,
  'store.seed': storeSeed,
  'store.test-order': storeTestOrder,
  'theme.init': theme('theme.init'),
  'theme.validate': theme('theme.validate'),
  'theme.pull': theme('theme.pull'),
  'theme.push': theme('theme.push'),
  'theme.preview': theme('theme.preview'),
  'theme.publish': theme('theme.publish'),
} satisfies Record<CommandId, Handler>;

/** The usage for a group's word: the theme commands for `theme`, everything otherwise. */
function groupUsage(word: string): string {
  return word === 'theme' ? THEME_USAGE : USAGE;
}

/** `storeware help [command]`: one command, one group, or every command. */
function help(words: readonly string[]): void {
  const named = findCommand(words);
  if (named && named.length === words.length) {
    out(commandHelp(named.command));
  } else if (words.length === 1 && isGroupWord(words[0])) {
    out(groupUsage(words[0]!));
  } else {
    out(USAGE);
    if (words.length > 0) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  // Applied before any command reads config, so --api works on the first run
  // with nothing stored.
  if (flag('api')) process.env.STOREWARE_API_URL = flag('api');
  if (flag('admin')) process.env.STOREWARE_ADMIN_URL = flag('admin');

  if (found) {
    if (!has('help')) return HANDLERS[found.command.id]();
    out(commandHelp(found.command));
    return;
  }

  if (verb === 'help') return help(args.positionals);

  if (verb !== undefined && isGroupWord(verb)) {
    out(groupUsage(verb));
    if (subcommand !== undefined && subcommand !== 'help') process.exitCode = 1;
    return;
  }

  out(USAGE);
  if (verb && verb !== '--help') process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Manifest, theme and auth errors are the developer's to fix and already
  // read well. An API error is worth showing plainly. Anything else is ours,
  // and the stack is the useful part.
  if (
    error instanceof ManifestError ||
    error instanceof ThemeError ||
    error instanceof NotAuthenticatedError ||
    error instanceof LoginError ||
    error instanceof DevError ||
    error instanceof CloudflaredError ||
    error instanceof HostingError
  ) {
    err(error.message);
  } else if (error instanceof ApiError) {
    err(error.message);
    if (error.requiredScopes) err(`Your role needs: ${error.requiredScopes.join(', ')}`);
  } else if (error instanceof Error) {
    err(error.stack ?? error.message);
  } else {
    err(String(error));
  }
  process.exitCode = 1;
});
