import {
  COMMANDS,
  GLOBAL_FLAGS,
  GROUPS,
  PASSTHROUGH_LABEL,
  argLabel,
  flagLabel,
  synopsis,
  type Command,
  type CommandId,
} from './commands';

/**
 * The CLI's help, laid out from `./commands`.
 *
 * Only the layout lives here: the headings, the line that points at `help`,
 * and the note on the environment. What a command does, what it takes and how
 * it is typed is read from the registry, so the help and the docs cannot say
 * different things.
 */

const PROGRAM = 'storeware';
const DOCS = 'https://storeware.ai/docs';

/** Where a long line is folded. */
const WIDTH = 100;

/** The widest first column; a longer entry puts its text on the next line. */
const COLUMN = 34;

type Row = readonly [string, string];

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function widthOf(rows: readonly Row[]): number {
  return Math.min(COLUMN, Math.max(0, ...rows.map(([first]) => first.length)));
}

/** Two columns, the second folded to fit, every row aligned to `left`. */
function table(rows: readonly Row[], left = widthOf(rows)): string[] {
  const indent = ' '.repeat(2 + left + 2);
  return rows.flatMap(([first, second]) => {
    const text = wrap(second, WIDTH - indent.length);
    if (first.length > left) return [`  ${first}`, ...text.map((line) => `${indent}${line}`)];
    return [
      `  ${first.padEnd(left)}  ${text[0] ?? ''}`,
      ...text.slice(1).map((line) => `${indent}${line}`),
    ];
  });
}

function listing(commands: readonly Command[]): Row[] {
  return commands.map((command) => [synopsis(command, PROGRAM, { flags: false }), command.summary]);
}

const globalRows: Row[] = GLOBAL_FLAGS.map((flag) => [flagLabel(flag), flag.description]);

/** Every command by group, then the flags every command takes. */
export const USAGE = (() => {
  const left = widthOf([...listing(COMMANDS), ...globalRows]);
  const sections = GROUPS.map((group) =>
    [group, ...table(listing(COMMANDS.filter((c) => c.group === group)), left)].join('\n'),
  );
  return `${[
    'storeware, for building Storeware apps',
    ...sections,
    ['Flags every command takes', ...table(globalRows, left)].join('\n'),
    `Run ${PROGRAM} help <command> for a command's arguments, flags and examples.`,
    [
      'Environment',
      '  STOREWARE_CLI_TOKEN, a CI token from the Developer page, deploys one app',
      '  with no login step. STOREWARE_TOKEN and STOREWARE_ORG still work for keys.',
    ].join('\n'),
  ].join('\n\n')}\n`;
})();

/** The theme commands alone, for `storeware theme` with nothing after it. */
export const THEME_USAGE = `${[
  "storeware theme, for a shop's look as a file",
  table(listing(COMMANDS.filter((c) => c.path[0] === 'theme'))).join('\n'),
  `Run ${PROGRAM} help theme <command> for its arguments, flags and examples.`,
].join('\n\n')}\n`;

/** How a command is typed, for one typed without what it needs. */
export function usageLine(id: CommandId): string {
  const command: Command = COMMANDS.find((candidate) => candidate.id === id)!;
  return `Usage: ${synopsis(command, PROGRAM)}`;
}

/** One command: how it is typed, what it takes, and examples. */
export function commandHelp(command: Command): string {
  const args: Row[] = command.args.map((arg) => [argLabel(arg), arg.description]);
  if (command.passthrough !== undefined) {
    args.push([`[${PASSTHROUGH_LABEL}]`, command.passthrough]);
  }
  const flags: Row[] = command.flags.map((flag) => [flagLabel(flag), flag.description]);
  const left = widthOf([...args, ...flags]);

  const sections = [
    `Usage: ${synopsis(command, PROGRAM)}`,
    wrap(command.summary, WIDTH).join('\n'),
  ];
  if (args.length > 0) sections.push(['Arguments', ...table(args, left)].join('\n'));
  if (flags.length > 0) sections.push(['Flags', ...table(flags, left)].join('\n'));
  if (command.examples.length > 0) {
    sections.push(
      ['Examples', ...command.examples.map((example) => `  ${PROGRAM} ${example}`)].join('\n'),
    );
  }

  const notes = [
    ...(command.aliases ?? []).map((alias) => `Also runs as ${[PROGRAM, ...alias].join(' ')}.`),
    ...(command.guide ? [`More in ${command.guide.title}: ${DOCS}${command.guide.path}`] : []),
  ];
  if (notes.length > 0) sections.push(notes.join('\n'));

  return `${sections.join('\n\n')}\n`;
}
