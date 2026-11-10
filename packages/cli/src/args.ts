import { valuedFlags } from './commands';

/**
 * argv, split once rather than scanned per lookup.
 *
 * Hand-rolled for the reason the CLI's own header gives: a dependency here
 * would ship in the published binary, and the surface is a dozen flags.
 *
 * ## Why the flags that take a value are declared
 *
 * The first version of this guessed. A flag consumed the token after it unless
 * that token itself began with `--`, which is right for `--slug foo` and wrong
 * for every boolean flag followed by a filename:
 *
 *     storeware theme push --publish my-theme.json
 *
 * read as `publish = "my-theme.json"` with no positional left, so the command
 * pushed the wrong file or none at all. The heuristic cannot tell the two
 * apart, because the difference is not in the tokens: it is in which flags are
 * switches, and only a declaration can say that.
 *
 * So the flags that take a value are declared, and the parser takes the next
 * token only for those. A name in the set takes the next token; a name outside
 * it is a switch and never swallows anything. They are declared once, in
 * `./commands`, where every flag has a `value` placeholder or none: the same
 * line that prints `--store <handle>` in the help is the line that tells this
 * parser `store` takes a value. The set is global rather than per command
 * because `--api` and `--admin` are, and because one name must parse the same
 * way everywhere; `commands.test.ts` holds that no flag is declared both ways.
 *
 * An unknown flag is treated as a switch, which is the safe direction: the
 * token after it survives as a positional, so a mistyped flag loses the flag
 * rather than the filename.
 */

export interface Args {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
  /** The value of a flag, or undefined when it was absent or passed bare. */
  flag(name: string): string | undefined;
  has(name: string): boolean;
  positional(index: number): string | undefined;
}

/**
 * Every flag on this CLI that is followed by a value, read from `./commands`.
 *
 * Notably absent, and deliberately: `publish`, `yes`, `force` and `help`. They
 * are switches, so the token after one is a positional.
 */
export const VALUED_FLAGS: ReadonlySet<string> = new Set(valuedFlags());

export function parseArgs(
  argv: readonly string[],
  valued: ReadonlySet<string> = VALUED_FLAGS,
): Args {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    // `--name=Autumn` is the escape hatch for a value that looks like a flag,
    // and for the reader who does not know which names are in the set above.
    // Requiring the `=` past index 2 keeps `--=x` from declaring a nameless
    // flag.
    const equals = token.indexOf('=');
    if (equals > 2) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }

    const name = token.slice(2);
    const next = argv[i + 1];

    if (!valued.has(name) || next === undefined || next.startsWith('--')) {
      flags.set(name, true);
      continue;
    }

    flags.set(name, next);
    i += 1;
  }

  return {
    flags,
    positionals,
    flag(name) {
      const value = flags.get(name);
      return typeof value === 'string' ? value : undefined;
    },
    has(name) {
      return flags.has(name);
    },
    positional(index) {
      return positionals[index];
    },
  };
}
