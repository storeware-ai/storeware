import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ManifestError,
  parseManifest,
  validateEvents,
  validateScopes,
} from '@storeware/plugin-sdk/manifest';
import { manifestJsonSchema } from '@storeware/plugin-sdk/manifest-schema';
import {
  fetchEvents,
  fetchScopes,
  listDevelopmentStores,
  runPreflight,
  triggerWebhook,
} from './api';
import { loadConfig, requireCredentials, type Credentials } from './config';

/**
 * `storeware mcp`: the docs and the developer's own app, as an MCP server on
 * stdio, for a coding agent (Claude Code, Codex, Cursor) working in an app's
 * folder.
 *
 *     claude mcp add storeware -- npx @storeware/cli mcp
 *
 * Seven tools. Four read: search the docs, read a page as Markdown, the
 * manifest's JSON Schema, and an operation from the API's OpenAPI document.
 * Three act, with the CLI's sign-in: `validate` the manifest in the folder,
 * run `preflight`, and `webhook_trigger` one signed event.
 *
 * The protocol is written out here (JSON-RPC, one message a line) rather than
 * taken from a package, for the reason the argument parser is: a dependency
 * ships in the binary, and the surface is four methods. Nothing but protocol
 * may reach stdout, so nothing here prints; a tool's answer is its text.
 */

export const DOCS_ORIGIN = 'https://storeware.ai';
const DOCS = `${DOCS_ORIGIN}/docs`;
/** The newest version this server speaks; a client asking for another gets its own back. */
const PROTOCOL_VERSION = '2025-06-18';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: 'string', description });

export const TOOLS: Tool[] = [
  {
    name: 'search_docs',
    description:
      'Search the Storeware developer docs. Returns matching pages with their Markdown address, for read_docs_page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Words to look for, such as "verify webhook" or "app bridge toast".'),
      },
      required: ['query'],
    },
  },
  {
    name: 'read_docs_page',
    description: 'Read one Storeware docs page as Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str(
          'The page, as /webhooks/verifying or https://storeware.ai/docs/webhooks/verifying(.md).',
        ),
      },
      required: ['path'],
    },
  },
  {
    name: 'manifest_schema',
    description:
      'The JSON Schema of storeware.app.toml, the manifest: every key, its type, its limits and what it does.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'api_operation',
    description:
      'Look up a call in the public REST API (OpenAPI), by operationId such as listProducts, or by words. Returns its method, path, parameters, body, answer and scopes.',
    inputSchema: {
      type: 'object',
      properties: { query: str('An operationId, a path such as /products, or words.') },
      required: ['query'],
    },
  },
  {
    name: 'validate',
    description:
      'Check the app manifest, storeware.app.toml in the working folder, and its scopes and events against the platform when signed in.',
    inputSchema: {
      type: 'object',
      properties: { manifest: str('Path to the manifest, when it is not ./storeware.app.toml.') },
    },
  },
  {
    name: 'preflight',
    description:
      'Run the checks a Storeware review runs against the app installed on a development store (storeware app dev installs it). Needs storeware login.',
    inputSchema: {
      type: 'object',
      properties: {
        app: str("The app's slug. The manifest's when not given."),
        store: str('A development store, by handle or id.'),
      },
    },
  },
  {
    name: 'webhook_trigger',
    description:
      'Send the running app one signed event from a development store, such as order.paid.v1, and say how it answered. Needs storeware login.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: str('The event, such as product.created.v1.'),
        app: str("The app's slug. The manifest's when not given."),
        store: str('A development store, by handle or id.'),
      },
      required: ['topic'],
    },
  },
];

interface Context {
  fetchImpl: typeof fetch;
  cwd: string;
  credentials: () => Promise<Credentials>;
}

class ToolError extends Error {}

const cache = new Map<string, Promise<string>>();

async function text(context: Context, url: string): Promise<string> {
  if (!cache.has(url)) {
    cache.set(
      url,
      (async () => {
        const response = await context.fetchImpl(url, { headers: { accept: 'text/markdown' } });
        if (!response.ok) throw new ToolError(`${url} answered ${response.status}.`);
        return response.text();
      })(),
    );
  }
  const pending = cache.get(url)!;
  pending.catch(() => cache.delete(url));
  return pending;
}

/** The pages `llms.txt` lists, scored by how many of the words each mentions. Pure. */
export function searchIndex(index: string, query: string, limit = 8): string[] {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (words.length === 0) return [];
  return index
    .split('\n')
    .filter((line) => line.startsWith('- ['))
    .map((line) => {
      const haystack = line.toLowerCase();
      const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
      return { line, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.line);
}

/** A docs page's Markdown address, only ever on the docs. Pure. */
export function docsMarkdownUrl(path: string): string {
  let page = path.trim();
  if (/^https?:\/\//.test(page)) {
    const url = new URL(page);
    if (url.origin !== DOCS_ORIGIN || !url.pathname.startsWith('/docs')) {
      throw new ToolError('Only pages on https://storeware.ai/docs can be read.');
    }
    page = url.pathname.slice('/docs'.length);
  }
  page = page.replace(/\.md$/, '').replace(/\/$/, '');
  if (!page.startsWith('/')) page = `/${page}`;
  if (page.includes('..')) throw new ToolError('That is not a docs page.');
  return `${DOCS}${page === '/' ? '/index' : page}.md`;
}

interface OpenApi {
  paths: Record<string, Record<string, { operationId?: string; summary?: string }>>;
  components?: { schemas?: Record<string, unknown> };
}

/** The operations matching a query, best first: an exact operationId, then a path, then words. Pure. */
export function findOperations(document: OpenApi, query: string): Record<string, unknown>[] {
  const all = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path,
      ...operation,
    })),
  );
  const exact = all.filter((op) => op.operationId?.toLowerCase() === query.toLowerCase());
  if (exact.length > 0) return exact;
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9/{}]+/)
    .filter(Boolean);
  return all
    .map((op) => {
      const haystack =
        `${op.operationId ?? ''} ${op.method} ${op.path} ${op.summary ?? ''}`.toLowerCase();
      return { op, score: words.filter((word) => haystack.includes(word)).length };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((hit) => hit.op);
}

async function manifestAt(context: Context, path?: string) {
  const file = resolve(context.cwd, path ?? 'storeware.app.toml');
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    throw new ToolError(`No manifest at ${file}. Run storeware init first.`);
  }
  return parseManifest(source);
}

async function storeFor(credentials: Credentials, named?: string) {
  const stores = await listDevelopmentStores(credentials);
  const store = named ? stores.find((s) => s.id === named || s.handle === named) : stores[0];
  if (!store) {
    throw new ToolError(
      named
        ? `No development store called ${named}.`
        : 'No development store yet. Run storeware app dev.',
    );
  }
  return store;
}

type Args = Record<string, unknown>;
const arg = (args: Args, name: string): string | undefined =>
  typeof args[name] === 'string' && args[name] !== '' ? (args[name] as string) : undefined;

const HANDLERS: Record<string, (context: Context, args: Args) => Promise<string>> = {
  async search_docs(context, args) {
    const hits = searchIndex(await text(context, `${DOCS}/llms.txt`), arg(args, 'query') ?? '');
    return hits.length > 0
      ? hits.join('\n')
      : 'No page matched. Try fewer or other words, or read https://storeware.ai/docs/llms.txt.';
  },
  async read_docs_page(context, args) {
    return text(context, docsMarkdownUrl(arg(args, 'path') ?? '/'));
  },
  async manifest_schema() {
    return JSON.stringify(manifestJsonSchema(), null, 2);
  },
  async api_operation(context, args) {
    const apiUrl = (await loadConfig()).apiUrl.replace(/\/$/, '');
    const document = JSON.parse(await text(context, `${apiUrl}/api/v1/openapi.json`)) as OpenApi;
    const found = findOperations(document, arg(args, 'query') ?? '');
    if (found.length === 0) return 'No operation matched.';
    // The schemas the operations name, so the answer can be read on its own.
    const named = new Set(
      [...JSON.stringify(found).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map(
        (match) => match[1]!,
      ),
    );
    const schemas = Object.fromEntries(
      [...named].map((name) => [name, document.components?.schemas?.[name]]),
    );
    return JSON.stringify({ operations: found, schemas }, null, 2);
  },
  async validate(context, args) {
    const manifest = await manifestAt(context, arg(args, 'manifest'));
    const config = await loadConfig();
    if (!config.token) {
      return `${manifest.app.slug}: the manifest is structurally valid. Sign in (storeware login) to check scopes and events too.`;
    }
    const credentials = requireCredentials(config);
    const [scopes, events] = await Promise.all([
      fetchScopes(credentials),
      fetchEvents(credentials),
    ]);
    validateScopes(
      manifest,
      scopes.map((scope) => scope.name),
    );
    validateEvents(manifest, events);
    return `${manifest.app.slug}: valid. Every scope exists and covers the events it asks for.`;
  },
  async preflight(context, args) {
    const credentials = await context.credentials();
    const slug = arg(args, 'app') ?? (await manifestAt(context)).app.slug;
    const named = arg(args, 'store');
    const report = await runPreflight(
      credentials,
      slug,
      named ? { storeId: (await storeFor(credentials, named)).id } : {},
    );
    return JSON.stringify(report, null, 2);
  },
  async webhook_trigger(context, args) {
    const credentials = await context.credentials();
    const slug = arg(args, 'app') ?? (await manifestAt(context)).app.slug;
    const store = await storeFor(credentials, arg(args, 'store'));
    const sent = await triggerWebhook(credentials, slug, {
      topic: arg(args, 'topic') ?? '',
      storeId: store.id,
    });
    return JSON.stringify(sent, null, 2);
  },
};

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** One message in, the answer out, or null for a notification. */
export async function answer(
  message: RpcRequest,
  context: Context,
  version: string,
): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id ?? null, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: '2.0',
    id: message.id ?? null,
    error: { code, message: text },
  });
  if (message.id === undefined) return null;

  switch (message.method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'storeware', version },
        instructions:
          'Storeware developer docs and the app in this folder. Search or read the docs before guessing a field, scope, event or API path; validate the manifest after changing it; run preflight before submitting.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      const handler = HANDLERS[name];
      if (!handler) return fail(-32602, `No tool called ${name}.`);
      try {
        const body = await handler(context, (message.params?.arguments ?? {}) as Args);
        return reply({ content: [{ type: 'text', text: body }] });
      } catch (error) {
        // A tool that fails answers with what went wrong, for the agent to read.
        const words =
          error instanceof ToolError || error instanceof ManifestError || error instanceof Error
            ? error.message
            : String(error);
        return reply({ content: [{ type: 'text', text: words }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

/** Serves until stdin closes. */
export async function serveMcp(version: string, cwd: string): Promise<void> {
  const context: Context = {
    fetchImpl: fetch,
    cwd,
    credentials: async () => requireCredentials(await loadConfig()),
  };
  const lines = createInterface({ input: process.stdin });
  const pending: Promise<void>[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: RpcRequest;
    try {
      message = JSON.parse(line) as RpcRequest;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
      continue;
    }
    pending.push(
      answer(message, context, version).then((result) => {
        if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
      }),
    );
  }
  await Promise.all(pending);
}
