import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FUNCTION_KINDS,
  FUNCTION_SCHEMAS,
  MAX_FUNCTION_OUTPUT_BYTES,
} from '@storeware/plugin-sdk/functions';
import { parseManifest } from '@storeware/plugin-sdk/manifest';
import { fetchFunctionInputs } from './api';
import {
  chooseDevStore,
  cpuNote,
  failed,
  findFunction,
  FunctionError,
  functionRunner,
  inputProblems,
  outputProblems,
  sampleInput,
  summarise,
  type FunctionRunner,
  type RunResult,
} from './functions';
import { bundleHostedApp } from './hosting';

/**
 * `storeware function`: a checkout function run here the way Storeware runs
 * it, so what a developer sees on their machine is what a basket would get.
 *
 * The runner tests bundle real code with the same esbuild call `app deploy`
 * makes and run it in the same worker the command uses. A stand-in for either
 * would test the stand-in.
 */

describe('the sample input', () => {
  it.each(FUNCTION_KINDS)('is one a %s function is handed', (kind) => {
    expect(FUNCTION_SCHEMAS[kind].input.safeParse(sampleInput(kind)).success).toBe(true);
    expect(inputProblems(kind, sampleInput(kind))).toEqual([]);
  });

  it('has two lines going somewhere, and what each kind is handed besides', () => {
    for (const kind of FUNCTION_KINDS) {
      const input = sampleInput(kind) as { lines: unknown[]; destination: unknown };
      expect(input.lines).toHaveLength(2);
      expect(input.destination).not.toBeNull();
    }
    expect((sampleInput('discount') as { delivery: unknown }).delivery).not.toBeNull();
    expect((sampleInput('delivery_rates') as { options: unknown[] }).options.length).toBe(3);
    expect((sampleInput('payment_methods') as { methods: string[] }).methods).toEqual([
      'card',
      'on_account',
      'crypto',
    ]);
  });

  it('adds up: the subtotal is the lines’ total', () => {
    const input = sampleInput('discount') as {
      lines: { quantity: number; unitPrice: number }[];
      subtotal: number;
    };
    expect(input.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0)).toBe(input.subtotal);
  });

  it('says what is wrong with an input a kind is not handed', () => {
    const { options: _options, ...withoutOptions } = sampleInput('delivery_rates') as Record<
      string,
      unknown
    >;
    expect(inputProblems('delivery_rates', withoutOptions)).toEqual([
      expect.stringMatching(/^options: /),
    ]);
  });
});

describe('finding a function in the manifest', () => {
  const manifest = parseManifest(`
[app]
slug = "bulk"
name = "Bulk"
url = "https://bulk.storewareapps.com/"

[oauth]
scopes = ["checkout:read"]

[runtime]

[[functions]]
kind = "discount"
handle = "volume_discount"
name = "Volume discount"

[[functions]]
kind = "cart_validation"
handle = "packs_of_six"
name = "Packs of six"
`);

  it('takes the kind from the manifest', () => {
    expect(findFunction(manifest, 'packs_of_six')).toEqual({
      kind: 'cart_validation',
      handle: 'packs_of_six',
      name: 'Packs of six',
    });
  });

  it('names the ones there are when the handle is not one', () => {
    expect(() => findFunction(manifest, 'volume')).toThrow(
      'No function called volume. This app has: volume_discount, packs_of_six.',
    );
  });

  it('says how to add one to an app with none', () => {
    const none = parseManifest(`
[app]
slug = "bulk"
name = "Bulk"
url = "https://bulk.storewareapps.com/"

[oauth]
scopes = ["checkout:read"]

[runtime]
`);
    expect(() => findFunction(none, 'volume_discount')).toThrow(/\[\[functions\]\]/);
  });
});

describe('what Storeware would not use', () => {
  const basket = sampleInput('delivery_rates');

  it('takes an answer its kind allows', () => {
    expect(
      outputProblems('discount', sampleInput('discount'), {
        discounts: [{ title: 'Bulk order, 10% off', target: 'order', value: { percent: 10 } }],
      }),
    ).toEqual([]);
  });

  it('says where the schema refused, and why', () => {
    const problems = outputProblems('discount', sampleInput('discount'), {
      discounts: [{ title: 'Too much', target: 'order', value: { percent: 150 } }],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/^discounts\.0\.value/);
  });

  it('refuses nothing at all', () => {
    expect(outputProblems('discount', sampleInput('discount'), undefined)).toEqual([
      'It answered nothing. Return an object.',
    ]);
  });

  it('refuses a delivery option the basket was never offered, or one offered twice', () => {
    expect(outputProblems('delivery_rates', basket, { options: [{ id: 'teleport' }] })).toEqual([
      'options: teleport is not an option the basket was offered',
    ]);
    expect(
      outputProblems('delivery_rates', basket, { options: [{ id: 'express' }, { id: 'express' }] }),
    ).toEqual(['options: express is there twice']);
    expect(
      outputProblems('delivery_rates', basket, {
        options: [{ id: 'express', amount: 0 }, { id: 'standard' }],
      }),
    ).toEqual([]);
  });

  it('refuses an answer too big to keep', () => {
    const errors = Array.from({ length: 5 }, () => ({
      message: 'x'.repeat(200),
      lineId: 'y'.repeat(200),
    }));
    // Within the schema, so only the size can refuse it: pad it past the limit.
    const big = { errors, padding: 'z'.repeat(MAX_FUNCTION_OUTPUT_BYTES) };
    expect(outputProblems('cart_validation', sampleInput('cart_validation'), big)[0]).toMatch(
      /bytes as JSON, and may be at most/,
    );
  });
});

describe('running the bundle', () => {
  const CODE = `
declare const process: { threadCpuUsage?: () => { user: number; system: number } };
// Spins for this much of the thread's own CPU, so a busy machine cannot make it use less.
const cpu = () => { const used = process.threadCpuUsage?.(); return used ? (used.user + used.system) / 1000 : Date.now(); };
const spin = (ms: number) => { const until = cpu() + ms; while (cpu() < until) {} };
export const functions = {
  volume_discount: (input: { lines: { id: string; quantity: number }[] }) => {
    console.log('lines', input.lines.length);
    const count = input.lines.reduce((sum, line) => sum + line.quantity, 0);
    return {
      discounts:
        count >= 3
          ? [{ title: 'Three or more, 10% off', target: 'order', value: { percent: 10 } }]
          : [],
    };
  },
  packs_of_six: (input: { lines: { id: string; quantity: number }[] }) => ({
    errors: input.lines
      .filter((line) => line.quantity % 6 !== 0)
      .map((line) => ({ message: 'Sold in packs of 6', lineId: line.id })),
  }),
  throws: () => { throw new Error('no stock table'); },
  calls_out: async () => {
    await fetch('https://rates.example/api');
    return { discounts: [] };
  },
  loops: () => { for (;;) {} },
  waits: () => new Promise((done) => setTimeout(() => done({ discounts: [] }), 2000)),
  greedy: () => { spin(40); return { discounts: [] }; },
  wrong: () => ({ discounts: [{ title: '', target: 'everything', value: { percent: 10 } }] }),
  bigint: () => ({ discounts: [], count: 1n }),
};
export default { fetch: () => new Response('ok') };
`;

  let runner: FunctionRunner;
  let bundle: Uint8Array;

  function app(files: Record<string, string>): string {
    const folder = mkdtempSync(join(tmpdir(), 'storeware-functions-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
    return folder;
  }

  beforeAll(async () => {
    bundle = (await bundleHostedApp(app({ 'src/worker.ts': CODE }), 'src/worker.ts')).bytes;
    // A short wall limit and a small CPU budget, so the stopping is quick to see.
    runner = functionRunner(bundle, { wallMs: 150, cpuMs: 20 });
  });

  afterAll(async () => {
    await runner.close();
  });

  it('runs a function on the sample and checks its answer', async () => {
    const result = await runner.run('volume_discount', 'discount', sampleInput('discount'));
    expect(result.outcome).toBe('ok');
    expect(result.output).toEqual({
      discounts: [{ title: 'Three or more, 10% off', target: 'order', value: { percent: 10 } }],
    });
    expect(result.logs).toEqual(['log: lines 2']);
    expect(summarise('discount', result)).toBe('1 discount: Three or more, 10% off');
    expect(failed(result)).toBe(false);
  });

  it('says a refused basket in the shopper’s words', async () => {
    const result = await runner.run('packs_of_six', 'cart_validation', sampleInput('discount'));
    expect(result.outcome).toBe('ok');
    expect(summarise('cart_validation', result)).toBe(
      'refused: Sold in packs of 6; Sold in packs of 6',
    );
  });

  it('reports a throw, which fails the command', async () => {
    const result = await runner.run('throws', 'discount', sampleInput('discount'));
    expect(result.outcome).toBe('threw');
    expect(summarise('discount', result)).toBe('threw: Error: no stock table');
    expect(failed(result)).toBe(true);
  });

  it('has no network, as in production', async () => {
    const result = await runner.run('calls_out', 'discount', sampleInput('discount'));
    expect(result.outcome).toBe('threw');
    expect(result.error).toMatch(/has no network/);
  });

  it('stops a function that never yields at the wall limit, and runs the next one fresh', async () => {
    const result = await runner.run('loops', 'discount', sampleInput('discount'));
    expect(result.outcome).toBe('timeout');
    expect(result.error).toBe('It did not answer within 150 ms, so it was stopped.');
    expect(failed(result)).toBe(true);

    const after = await runner.run('volume_discount', 'discount', sampleInput('discount'));
    expect(after.outcome).toBe('ok');
  });

  it('stops one that waits past the wall limit', async () => {
    const result = await runner.run('waits', 'discount', sampleInput('discount'));
    expect(result.outcome).toBe('timeout');
  });

  it('reports CPU over the limit without stopping it', async () => {
    // A wall limit far off, so only the CPU can be over on a busy machine.
    const roomy = functionRunner(bundle, { wallMs: 10_000, cpuMs: 20 });
    try {
      const result = await roomy.run('greedy', 'discount', sampleInput('discount'));
      expect(result.outcome).toBe('ok');
      if (result.cpuMs === null) return; // A Node that cannot measure one thread's CPU.
      expect(result.overCpu).toBe(true);
      expect(cpuNote(result, 20)).toMatch(/Storeware stops a function at 20 ms/);
    } finally {
      await roomy.close();
    }
  });

  it('says what is wrong with an answer the schema refuses', async () => {
    const result = await runner.run('wrong', 'discount', sampleInput('discount'));
    expect(result.outcome).toBe('invalid');
    expect(result.problems?.some((p) => p.startsWith('discounts.0.title'))).toBe(true);
    expect(summarise('discount', result)).toMatch(/^answer not used: discounts\.0\./);
    expect(failed(result)).toBe(true);
  });

  it('reports an answer that cannot be JSON as a throw', async () => {
    const result = await runner.run('bigint', 'discount', sampleInput('discount'));
    expect(result.outcome).toBe('threw');
    expect(result.error).toMatch(/cannot be written as JSON/);
  });

  it('names a handle the bundle does not export', async () => {
    const other = functionRunner(bundle);
    await expect(other.run('missing', 'discount', sampleInput('discount'))).rejects.toThrow(
      'not one called missing',
    );
    await other.close();
  });

  it('says how to export functions from a bundle that has none', async () => {
    const plain = await bundleHostedApp(
      app({ 'src/worker.ts': `export default { fetch: () => new Response('ok') };\n` }),
      'src/worker.ts',
    );
    const other = functionRunner(plain.bytes);
    await expect(other.run('volume_discount', 'discount', {})).rejects.toThrow(FunctionError);
    await other.close();
  });
});

describe('a few words for each answer', () => {
  const ok = (output: unknown): RunResult => ({
    outcome: 'ok',
    output,
    wallMs: 1,
    cpuMs: 1,
    overCpu: false,
    logs: [],
  });

  it('counts what came back', () => {
    expect(summarise('discount', ok({ discounts: [] }))).toBe('no discount');
    expect(
      summarise('delivery_rates', ok({ options: [{ id: 'standard' }, { id: 'express' }] })),
    ).toBe('2 options: standard, express');
    expect(summarise('payment_methods', ok({ methods: ['card'] }))).toBe('1 way to pay: card');
    expect(summarise('cart_validation', ok({ errors: [] }))).toBe('accepted');
  });

  it('reads the CPU within the limit as a plain fact', () => {
    expect(cpuNote(ok({}), 25)).toBe('1 ms of CPU, of the 25 ms allowed.');
    expect(cpuNote({ ...ok({}), cpuMs: null })).toBeNull();
  });
});

describe('choosing the development store to replay', () => {
  const one = { id: 'st_1', handle: 'bulk-dev' };
  const two = { id: 'st_2', handle: 'other-dev' };

  it('takes the one named, by handle or id', () => {
    expect(chooseDevStore([one, two], 'other-dev', undefined)).toBe(two);
    expect(chooseDevStore([one, two], 'st_1', 'st_2')).toBe(one);
    expect(() => chooseDevStore([one, two], 'nope', undefined)).toThrow(
      'No development store called nope.',
    );
  });

  it('takes the one app dev used, then the only one', () => {
    expect(chooseDevStore([one, two], undefined, 'st_2')).toBe(two);
    expect(chooseDevStore([one], undefined, undefined)).toBe(one);
  });

  it('asks the person to choose among several, by name', () => {
    expect(() => chooseDevStore([one, two], undefined, undefined)).toThrow(
      'You have 2 development stores. Choose one with --store: bulk-dev, other-dev.',
    );
    expect(() => chooseDevStore([], undefined, undefined)).toThrow(/No development store yet/);
  });
});

describe('fetching the baskets to replay', () => {
  const credentials = {
    apiUrl: 'https://api.example.test',
    adminUrl: 'https://admin.example.test',
    token: 'swd_test',
    organizationId: '',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the development store for one function’s inputs, and reads them out of data', async () => {
    const asked: URL[] = [];
    const data = {
      kind: 'discount',
      inputs: [{ sessionId: 'cs_1', at: '2026-11-10T09:00:00.000Z', input: { lines: [] } }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(new URL(url));
        return new Response(JSON.stringify({ data }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const found = await fetchFunctionInputs(credentials, 'st 1', {
      app: 'bulk',
      handle: 'volume_discount',
      limit: 20,
    });
    expect(asked[0]!.pathname).toBe('/api/v1/developer/dev-stores/st%201/function-inputs');
    expect(Object.fromEntries(asked[0]!.searchParams)).toEqual({
      app: 'bulk',
      handle: 'volume_discount',
      limit: '20',
    });
    expect(found).toEqual(data);
  });
});
