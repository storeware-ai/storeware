import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TEST_PAYMENT_OUTCOMES } from './api';
import { parseArgs, VALUED_FLAGS } from './args';
import {
  COMMANDS,
  GLOBAL_FLAGS,
  GROUPS,
  findCommand,
  flagLabel,
  manifestArgument,
  synopsis,
  type Command,
  type CommandFlag,
} from './commands';
import { commandHelp, THEME_USAGE, USAGE } from './help';

/**
 * The registry, held to what the CLI and the docs take from it.
 *
 * `commands.ts` is the one description of every command, so these are the
 * checks that it describes the commands the code actually has: one handler per
 * entry, every flag the code reads declared, every example runnable as
 * written, and nothing imported that the docs build could not follow.
 */

const commands: readonly Command[] = COMMANDS;
const globals: readonly CommandFlag[] = GLOBAL_FLAGS;
const pathsOf = (command: Command) => [command.path, ...(command.aliases ?? [])];

/** The CLI's own source, without its tests. */
const sources = readdirSync(new URL('.', import.meta.url))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => ({ file, source: readFileSync(new URL(file, import.meta.url), 'utf8') }));

/**
 * Every flag name the code reads.
 *
 * The handlers read flags in three ways: the entry point's own `flag('x')` and
 * `has('x')`, the theme commands' `args.flag('x')` and `args.has('x')`, and the
 * parsed map, `args.flags.get('x')`. A call on any other object (`seen.has`) is
 * not a flag, so a dot before the name is allowed only after `args`.
 */
function flagReads(source: string): string[] {
  const calls = /(?:^|[^\w.])(?:args\.)?(?:flag|has)\(\s*['"]([^'"]+)['"]\s*\)/g;
  const map = /\bargs\.flags\.get\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...source.matchAll(calls), ...source.matchAll(map)].map((match) => match[1]!);
}

/** A command line as a shell splits it, for the quoted examples. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
}

describe('the command registry', () => {
  it('names each command once, by an id that is its path', () => {
    const ids = commands.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of commands) expect(command.id).toBe(command.path.join('.'));

    const typed = commands.flatMap(pathsOf).map((path) => path.join(' '));
    expect(new Set(typed).size).toBe(typed.length);
  });

  it('finds every command, and every alias, by the words that name it', () => {
    for (const command of commands) {
      for (const path of pathsOf(command)) {
        expect(findCommand([...path, 'more'])?.command.id).toBe(command.id);
        expect(findCommand([...path, 'more'])?.length).toBe(path.length);
      }
    }
    expect(findCommand(['theme', '--help'])).toBeUndefined();
    expect(findCommand([])).toBeUndefined();
  });

  it('reads the manifest from the argument that names it, and never from a version or a topic', () => {
    const at = (words: string[]) => manifestArgument(findCommand(words)!.command);
    expect(at(['validate'])).toBe(0);
    expect(at(['app', 'deploy'])).toBe(0);
    expect(at(['app', 'releases'])).toBe(0);
    // `app rollback 3` and `webhook trigger order.paid.v1` once looked for a
    // manifest called `3` and one called `order.paid.v1`.
    expect(at(['app', 'rollback'])).toBe(-1);
    expect(at(['webhook', 'trigger'])).toBe(-1);
  });

  it('puts every command in a group, and every group has one', () => {
    for (const group of GROUPS) {
      expect(commands.some((command) => command.group === group)).toBe(true);
    }
  });

  it('imports nothing, so the docs build can read it by path', () => {
    const source = readFileSync(new URL('./commands.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s[^;]*?\sfrom\s+['"]/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

describe('the code and the registry agree', () => {
  it('has one handler for every command, and none for a command it does not list', async () => {
    const argv = process.argv;
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    process.argv = [argv[0]!, 'storeware', 'help'];
    try {
      const entry = await import('./index');
      expect(Object.keys(entry.HANDLERS).sort()).toEqual(commands.map((c) => c.id).sort());
      expect(written.join('')).toBe(`${USAGE}\n`);
    } finally {
      process.argv = argv;
      write.mockRestore();
    }
  });

  it('declares every flag the code reads', () => {
    const declared = new Set([...globals, ...commands.flatMap((c) => c.flags)].map((f) => f.name));
    const read = sources.flatMap(({ file, source }) =>
      flagReads(source).map((name) => ({ file, name })),
    );

    // Not vacuous: the scan sees the reads every kind of handler makes.
    for (const name of ['api', 'store', 'pay', 'paid', 'publish', 'yes', 'force', 'help']) {
      expect(read.map((r) => r.name)).toContain(name);
    }
    expect(read.filter((r) => !declared.has(r.name))).toEqual([]);
  });

  it('sees a flag read in each way the handlers read one', () => {
    expect(flagReads("flag('a'); has('b'); args.flag('c'); args.has('d')")).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(flagReads("const v = args.flags.get('e');")).toEqual(['e']);
    expect(flagReads("seen.has('x'); GROUPS.has(verb)")).toEqual([]);
  });

  it('parses one flag name the same way on every command', () => {
    const byName = new Map<string, Set<boolean>>();
    for (const f of [...globals, ...commands.flatMap((c) => c.flags)]) {
      byName.set(f.name, (byName.get(f.name) ?? new Set()).add(f.value !== undefined));
    }
    expect([...byName].filter(([, kinds]) => kinds.size > 1).map(([name]) => name)).toEqual([]);
  });

  it('gives the parser every flag with a value, and keeps the switches switches', () => {
    for (const f of [...globals, ...commands.flatMap((c) => c.flags)]) {
      expect(VALUED_FLAGS.has(f.name), f.name).toBe(f.value !== undefined);
    }
    // The case that made the parser need a declared list at all.
    expect(parseArgs(['--publish', 'my-theme.json']).positional(0)).toBe('my-theme.json');
    expect(parseArgs(['--pay', 'decline', '--store', 'dev']).flag('pay')).toBe('decline');
  });

  it('names every test payment ending on --pay', () => {
    const pay = commands
      .find((c) => c.id === 'store.test-order')!
      .flags.find((f) => f.name === 'pay')!;
    for (const outcome of TEST_PAYMENT_OUTCOMES) expect(pay.description).toContain(outcome);
  });
});

describe('every example', () => {
  const examples = commands.flatMap((command) =>
    command.examples.map((example) => [command.id, example, command] as const),
  );

  it.each(examples)('%s: %s runs as written', (_id, example, command) => {
    const typed = words(example);
    const separator = typed.indexOf('--');
    const before = separator === -1 ? typed : typed.slice(0, separator);
    if (separator !== -1) expect(command.passthrough).toBeDefined();

    const named = findCommand(before);
    expect(named?.command.id).toBe(command.id);

    const args = parseArgs(before.slice(named!.length));
    const own = new Map([...globals, ...command.flags].map((f) => [f.name, f]));
    for (const [name, value] of args.flags) {
      expect(own.has(name), `--${name}`).toBe(true);
      expect(typeof value === 'string', `--${name} takes a value`).toBe(
        own.get(name)!.value !== undefined,
      );
    }
    expect(args.positionals.length).toBeLessThanOrEqual(command.args.length);
    expect(args.positionals.length).toBeGreaterThanOrEqual(
      command.args.filter((arg) => arg.required).length,
    );
  });
});

describe('the help', () => {
  it('names every command in the usage, and every theme command in the theme usage', () => {
    for (const command of commands) {
      expect(USAGE).toContain(synopsis(command, 'storeware', { flags: false }));
      if (command.path[0] === 'theme') {
        expect(THEME_USAGE).toContain(synopsis(command, 'storeware', { flags: false }));
      }
    }
    for (const f of globals) expect(USAGE).toContain(flagLabel(f));
  });

  it.each(commands.map((command) => [command.id, command] as const))(
    '%s has a page of its own',
    (_id, command) => {
      const help = commandHelp(command);
      expect(help).toContain(`Usage: ${synopsis(command, 'storeware')}`);
      for (const f of command.flags) expect(help).toContain(flagLabel(f));
      for (const example of command.examples) expect(help).toContain(`storeware ${example}`);
    },
  );

  it('reads as storeware.ai copy, in one sentence a command', () => {
    const text = [
      ...globals.map((f) => f.description),
      ...commands.flatMap((c) => [
        c.summary,
        c.passthrough ?? '',
        ...c.args.map((a) => a.description),
        ...c.flags.map((f) => f.description),
      ]),
    ];
    for (const line of text) {
      expect(line).not.toMatch(/[\u2014\u2013]| - |!/);
      // The docs escape `<` and `>` for MDX, which inside backticks would show.
      expect(line).not.toMatch(/`[^`]*[<>][^`]*`/);
    }
    for (const command of commands) {
      expect(command.summary).toMatch(/^[A-Z][\s\S]*\.$/);
      expect(command.summary).not.toMatch(/\.\s/);
    }
  });

  it('links each guide inside the docs, relative to their root', () => {
    for (const command of commands) {
      if (command.guide) expect(command.guide.path).toMatch(/^\/(?!docs\/)[a-z-]/);
    }
  });
});
