import { Worker } from 'node:worker_threads';
import {
  FUNCTION_CPU_MS,
  FUNCTION_KINDS,
  FUNCTION_SCHEMAS,
  FUNCTION_WALL_MS,
  MAX_FUNCTION_OUTPUT_BYTES,
  type BasketInput,
  type FunctionKind,
} from '@storeware/plugin-sdk/functions';
import type { PluginManifest } from '@storeware/plugin-sdk/manifest';

/**
 * `storeware function`: a hosted app's checkout functions, run on this
 * machine the way Storeware runs them when a basket is priced.
 *
 * The code is bundled exactly as `app deploy` bundles it and loaded in a
 * worker thread, so a function that loops forever can be stopped at the wall
 * limit as production stops it, and the CLI is not the thing that hangs.
 * `fetch` throws in there, because a function has no network in production
 * either: finding that out here is cheaper than finding out from a checkout
 * that quietly carried on without it.
 *
 * CPU is measured and reported but never enforced. This machine is not the
 * one that runs the function, so a number near the limit is a warning, not a
 * verdict.
 */

export class FunctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionError';
  }
}

export interface DeclaredFunction {
  kind: FunctionKind;
  handle: string;
  name: string;
}

export function isFunctionKind(value: string | undefined): value is FunctionKind {
  return (FUNCTION_KINDS as readonly string[]).includes(value ?? '');
}

/** The function a manifest declares under this handle, or an error naming the ones it does. */
export function findFunction(manifest: PluginManifest, handle: string): DeclaredFunction {
  const declared = manifest.functions ?? [];
  const fn = declared.find((candidate) => candidate.handle === handle);
  if (fn) return { kind: fn.kind, handle: fn.handle, name: fn.name };
  throw new FunctionError(
    declared.length === 0
      ? `${manifest.app.slug} has no checkout functions. Add one under [[functions]] in storeware.app.toml.`
      : `No function called ${handle}. This app has: ${declared.map((f) => f.handle).join(', ')}.`,
  );
}

// ---------------------------------------------------------------------------
// Sample inputs
// ---------------------------------------------------------------------------

const BASKET: BasketInput = {
  storeId: 'store_sample',
  currency: 'GBP',
  lines: [
    {
      id: 'line_1',
      productId: 'prod_linen_shirt',
      variantId: 'var_linen_shirt_m',
      sku: 'LS-M-OAT',
      title: 'Linen shirt',
      variantTitle: 'M / Oat',
      quantity: 2,
      unitPrice: 4500,
      grams: 260,
      requiresShipping: true,
      metafields: {},
    },
    {
      id: 'line_2',
      productId: 'prod_canvas_tote',
      variantId: 'var_canvas_tote',
      sku: 'CT-NAT',
      title: 'Canvas tote',
      variantTitle: null,
      quantity: 1,
      unitPrice: 1800,
      grams: 180,
      requiresShipping: true,
      metafields: {},
    },
  ],
  subtotal: 2 * 4500 + 1800,
  buyer: {
    customerId: 'cust_sample',
    companyId: null,
    email: 'sam@example.com',
    metafields: {},
  },
  destination: { country: 'GB', region: 'ENG', postalCode: 'M1 1AE', city: 'Manchester' },
  discountCode: null,
  delivery: null,
  channel: 'web',
};

const STANDARD = { id: 'standard', type: 'shipping', title: 'Standard delivery', amount: 395 };

/**
 * A realistic input for each kind: two lines going to Manchester, with what
 * that kind is handed besides. Checked against the kind's own schema in
 * `functions.test.ts`, so a change to the schema shows up here first.
 */
export function sampleInput(kind: FunctionKind): unknown {
  switch (kind) {
    case 'discount':
      return { ...BASKET, delivery: STANDARD };
    case 'delivery_rates':
      return {
        ...BASKET,
        options: [
          { ...STANDARD, description: 'Two to four working days', carrier: 'Royal Mail' },
          {
            id: 'express',
            type: 'shipping',
            title: 'Express delivery',
            description: 'Next working day',
            carrier: 'DPD',
            amount: 895,
          },
          { id: 'pickup_studio', type: 'pickup', title: 'Collect from the studio', amount: 0 },
        ],
      };
    case 'payment_methods':
      return { ...BASKET, delivery: STANDARD, methods: ['card', 'on_account', 'crypto'] };
    case 'cart_validation':
      return { ...BASKET, delivery: STANDARD };
  }
}

// ---------------------------------------------------------------------------
// Reading what a function answered
// ---------------------------------------------------------------------------

/** A schema's complaints as lines a person reads: where, then what. */
function problemsOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.map(String).join('.');
    return where ? `${where}: ${issue.message}` : issue.message;
  });
}

/** Problems with an input, before anything runs. Empty when it is one this kind is given. */
export function inputProblems(kind: FunctionKind, input: unknown): string[] {
  const parsed = FUNCTION_SCHEMAS[kind].input.safeParse(input);
  return parsed.success ? [] : problemsOf(parsed.error);
}

/**
 * Why Storeware would not use this answer, or nothing when it would: too big,
 * not what the kind's schema allows, or, for delivery, an option the input
 * never named or one named twice, which the schema's own note rules out.
 */
export function outputProblems(kind: FunctionKind, input: unknown, output: unknown): string[] {
  let text: string | undefined;
  try {
    text = JSON.stringify(output);
  } catch {
    return ['The answer cannot be written as JSON.'];
  }
  if (text === undefined) return ['It answered nothing. Return an object.'];
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_FUNCTION_OUTPUT_BYTES) {
    return [
      `The answer is ${bytes} bytes as JSON, and may be at most ${MAX_FUNCTION_OUTPUT_BYTES}.`,
    ];
  }

  const parsed = FUNCTION_SCHEMAS[kind].output.safeParse(output);
  if (!parsed.success) return problemsOf(parsed.error);

  if (kind === 'delivery_rates') {
    const offered = new Set(
      ((input as { options?: { id: string }[] }).options ?? []).map((option) => option.id),
    );
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const option of (output as { options: { id: string }[] }).options) {
      if (!offered.has(option.id)) {
        problems.push(`options: ${option.id} is not an option the basket was offered`);
      }
      if (seen.has(option.id)) problems.push(`options: ${option.id} is there twice`);
      seen.add(option.id);
    }
    return problems;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export type RunOutcome = 'ok' | 'threw' | 'timeout' | 'invalid';

export interface RunResult {
  outcome: RunOutcome;
  /** What the function returned, when it returned at all. */
  output?: unknown;
  /** Why the answer is not used: the schema's problems, in plain words. */
  problems?: string[];
  /** What it threw, or why it was stopped. */
  error?: string;
  wallMs: number;
  /** Null where this Node cannot measure one thread's CPU. */
  cpuMs: number | null;
  /** Whether it used more CPU here than Storeware allows. Reported, never enforced. */
  overCpu: boolean;
  /** What it wrote with `console`, in order. */
  logs: string[];
}

/**
 * The worker's code. Plain CommonJS, because an `eval` worker is a script.
 *
 * It loads the bundle from a data URL, so no file is written anywhere, with
 * `fetch` already replaced: code that calls it at the top level fails here as
 * it would in production.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const noNetwork = () => {
  throw new Error('A checkout function has no network, so fetch is not available.');
};
globalThis.fetch = noNetwork;
globalThis.WebSocket = undefined;
let logs = [];
const show = (value) => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...values) => { logs.push(level + ': ' + values.map(show).join(' ')); };
}
const cpu = () => {
  if (typeof process.threadCpuUsage !== 'function') return null;
  const used = process.threadCpuUsage();
  return (used.user + used.system) / 1000;
};
const describe = (error) => (error instanceof Error ? (error.stack || error.message) : String(error));
const loaded = import('data:text/javascript;base64,' + workerData.bundle).then(
  (module) => ({ module }),
  (error) => ({ error: describe(error) }),
);
parentPort.on('message', async ({ handle, input }) => {
  const { module, error } = await loaded;
  if (error) return parentPort.postMessage({ kind: 'load', error });
  const fn = module.functions && module.functions[handle];
  if (typeof fn !== 'function') {
    return parentPort.postMessage({
      kind: 'load',
      error: module.functions
        ? 'The bundle exports functions, but not one called ' + handle + '.'
        : 'The bundle has no functions export. Add export const functions = { ' + handle + ' } to runtime.main.',
    });
  }
  logs = [];
  const cpuBefore = cpu();
  const started = performance.now();
  try {
    const output = await fn(input);
    const wallMs = performance.now() - started;
    const cpuAfter = cpu();
    const cpuMs = cpuBefore === null || cpuAfter === null ? null : cpuAfter - cpuBefore;
    // Storeware reads the answer as JSON, so it crosses back as JSON: what
    // JSON drops here, production never sees either.
    let json;
    try {
      json = JSON.stringify(output);
    } catch (error) {
      return parentPort.postMessage({
        kind: 'threw', error: 'The answer cannot be written as JSON: ' + describe(error),
        wallMs, cpuMs, logs,
      });
    }
    parentPort.postMessage({ kind: 'ran', json, wallMs, cpuMs, logs });
  } catch (error) {
    const wallMs = performance.now() - started;
    const cpuAfter = cpu();
    parentPort.postMessage({
      kind: 'threw', error: describe(error), wallMs,
      cpuMs: cpuBefore === null || cpuAfter === null ? null : cpuAfter - cpuBefore, logs,
    });
  }
});
`;

type WorkerReply =
  | { kind: 'load'; error: string }
  | { kind: 'ran'; json: string | undefined; wallMs: number; cpuMs: number | null; logs: string[] }
  | { kind: 'threw'; error: string; wallMs: number; cpuMs: number | null; logs: string[] };

/**
 * Time allowed for the reply to cross back from the worker, on top of the
 * wall limit. The worker times the call itself, so this only decides when a
 * function that never answers is stopped.
 */
const MESSAGE_GRACE_MS = 100;
/** Loading the bundle is not the function's time: it happens once per isolate in production. */
const LOAD_ALLOWANCE_MS = 10_000;

export interface FunctionRunner {
  run(handle: string, kind: FunctionKind, input: unknown): Promise<RunResult>;
  close(): Promise<void>;
}

/**
 * Loads a bundle once and runs its functions, one call at a time.
 *
 * A call that outlives the wall limit is stopped by ending its worker, the
 * only way to stop code that never yields, and the next call gets a fresh
 * one. A bundle that cannot be loaded fails the first call with a
 * `FunctionError`, since nothing after it could run either.
 */
export function functionRunner(
  bundle: Uint8Array,
  options: { wallMs?: number; cpuMs?: number } = {},
): FunctionRunner {
  const wallLimit = options.wallMs ?? FUNCTION_WALL_MS;
  const cpuLimit = options.cpuMs ?? FUNCTION_CPU_MS;
  const encoded = Buffer.from(bundle).toString('base64');
  let worker: Worker | null = null;
  let loaded = false;

  const start = () =>
    new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { bundle: encoded },
      // The function's own output is collected through `console` above; this
      // keeps anything else it writes off the CLI's stdout, which `--json` owns.
      stdout: true,
      stderr: true,
    });

  const call = (current: Worker, message: unknown, limit: number) =>
    new Promise<WorkerReply | 'timeout' | { crashed: string }>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), limit);
      const done = (value: WorkerReply | { crashed: string }) => {
        clearTimeout(timer);
        current.off('message', onMessage);
        current.off('error', onError);
        resolve(value);
      };
      const onMessage = (reply: WorkerReply) => done(reply);
      const onError = (error: Error) => done({ crashed: error.stack ?? error.message });
      current.on('message', onMessage);
      current.on('error', onError);
      current.postMessage(message);
    });

  return {
    async run(handle, kind, input) {
      if (!worker) {
        // A fresh worker loads the bundle again, so its first call gets the
        // load allowance even after an earlier worker was stopped.
        worker = start();
        loaded = false;
      }
      const current = worker;
      const limit = wallLimit + MESSAGE_GRACE_MS + (loaded ? 0 : LOAD_ALLOWANCE_MS);
      const reply = await call(current, { handle, input }, limit);

      if (reply === 'timeout' || 'crashed' in reply) {
        worker = null;
        await current.terminate();
        return {
          outcome: reply === 'timeout' ? 'timeout' : 'threw',
          error:
            reply === 'timeout'
              ? `It did not answer within ${wallLimit} ms, so it was stopped.`
              : reply.crashed,
          wallMs: reply === 'timeout' ? limit : 0,
          cpuMs: null,
          overCpu: false,
          logs: [],
        };
      }
      if (reply.kind === 'load') {
        worker = null;
        await current.terminate();
        throw new FunctionError(`Could not run the bundle in Node: ${reply.error}`);
      }
      loaded = true;

      const timing = {
        wallMs: Math.round(reply.wallMs * 10) / 10,
        cpuMs: reply.cpuMs === null ? null : Math.round(reply.cpuMs * 10) / 10,
        overCpu: reply.cpuMs !== null && reply.cpuMs > cpuLimit,
        logs: reply.logs,
      };
      if (reply.kind === 'threw') return { outcome: 'threw', error: reply.error, ...timing };
      const output: unknown = reply.json === undefined ? undefined : JSON.parse(reply.json);
      if (reply.wallMs > wallLimit) {
        return {
          outcome: 'timeout',
          output,
          error: `It took ${Math.round(reply.wallMs)} ms, and Storeware stops a function at ${wallLimit} ms.`,
          ...timing,
        };
      }
      const problems = outputProblems(kind, input, output);
      if (problems.length > 0) return { outcome: 'invalid', output, problems, ...timing };
      return { outcome: 'ok', output, ...timing };
    },
    async close() {
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}

// ---------------------------------------------------------------------------
// Saying what happened
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What an answer amounts to, in a few words: "2 discounts", "refused: Sold in packs of 6". */
export function summarise(kind: FunctionKind, result: RunResult): string {
  if (result.outcome === 'threw') return `threw: ${firstLine(result.error)}`;
  if (result.outcome === 'timeout') return firstLine(result.error);
  if (result.outcome === 'invalid') {
    return `answer not used: ${result.problems?.[0] ?? 'it is not what this kind answers'}`;
  }
  switch (kind) {
    case 'discount': {
      const discounts = (result.output as { discounts: { title: string }[] }).discounts;
      return discounts.length === 0
        ? 'no discount'
        : `${plural(discounts.length, 'discount', 'discounts')}: ${discounts.map((d) => d.title).join(', ')}`;
    }
    case 'delivery_rates': {
      const options = (result.output as { options: { id: string }[] }).options;
      return `${plural(options.length, 'option', 'options')}${options.length ? `: ${options.map((o) => o.id).join(', ')}` : ''}`;
    }
    case 'payment_methods': {
      const methods = (result.output as { methods: string[] }).methods;
      return `${plural(methods.length, 'way to pay', 'ways to pay')}${methods.length ? `: ${methods.join(', ')}` : ''}`;
    }
    case 'cart_validation': {
      const errors = (result.output as { errors: { message: string }[] }).errors;
      return errors.length === 0
        ? 'accepted'
        : `refused: ${errors.map((e) => e.message).join('; ')}`;
    }
  }
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n')[0] ?? '';
}

/** Whether a run should end the command with a non-zero exit code. */
export function failed(result: RunResult): boolean {
  return result.outcome !== 'ok';
}

/** The CPU line, with the warning when it went over. */
export function cpuNote(result: RunResult, limit = FUNCTION_CPU_MS): string | null {
  if (result.cpuMs === null) return null;
  return result.overCpu
    ? `It used ${result.cpuMs} ms of CPU here, and Storeware stops a function at ${limit} ms. This machine is not Storeware's, so treat it as a warning.`
    : `${result.cpuMs} ms of CPU, of the ${limit} ms allowed.`;
}

// ---------------------------------------------------------------------------
// Development stores
// ---------------------------------------------------------------------------

/**
 * Which development store to read baskets from: the one named, the one
 * `app dev` last used for this app, or the only one. With several and none of
 * those, the person chooses, because baskets from the wrong shop would look
 * like a function that does nothing.
 */
export function chooseDevStore<T extends { id: string; handle: string }>(
  stores: readonly T[],
  named: string | undefined,
  remembered: string | undefined,
): T {
  if (named) {
    const match = stores.find((store) => store.id === named || store.handle === named);
    if (!match) throw new FunctionError(`No development store called ${named}.`);
    return match;
  }
  const kept = stores.find((store) => store.id === remembered);
  if (kept) return kept;
  if (stores.length === 1) return stores[0]!;
  if (stores.length === 0) {
    throw new FunctionError('No development store yet. Run storeware app dev to make one.');
  }
  throw new FunctionError(
    `You have ${stores.length} development stores. Choose one with --store: ${stores.map((s) => s.handle).join(', ')}.`,
  );
}
