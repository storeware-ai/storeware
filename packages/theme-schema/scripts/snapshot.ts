import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compatibilityBreaks, currentShape, type SchemaSnapshot } from '../src/compatibility';

/**
 * Writes the committed promise, or checks it.
 *
 * Two moves copied from `packages/graphql/scripts/write-schema.ts`, which solves
 * the same problem for the storefront's GraphQL SDL: a `--check` mode that exits
 * non-zero and prints the exact command to run, and the framing that the code is
 * the source of truth and the file is the mirror.
 *
 * One move deliberately NOT copied. The GraphQL check is string equality, so any
 * change fails it and the fix is always to regenerate. This one regenerates only
 * after `compatibilityBreaks` has agreed the change is a widening, so `--write`
 * cannot be used to wave a removal through. A removal has to be argued in the
 * code, by putting the thing back.
 */

const path = fileURLToPath(new URL('../schema.snapshot.json', import.meta.url));
const checking = process.argv.includes('--check');

const current = currentShape();
const serialised = `${JSON.stringify(current, null, 2)}\n`;

let pinned: SchemaSnapshot | null = null;
try {
  pinned = JSON.parse(readFileSync(path, 'utf8')) as SchemaSnapshot;
} catch {
  pinned = null;
}

if (pinned) {
  const breaks = compatibilityBreaks(pinned, current);

  if (breaks.length > 0) {
    process.stderr.write(
      `The theme schema takes something away that it promised to keep.\n\n` +
        breaks.map((one) => `  ${one.at}\n    ${one.says}\n`).join('\n') +
        `\nThe fix is to put it back, not to update the snapshot.\n`,
    );
    process.exit(1);
  }
}

if (checking) {
  if (readFileSync(path, 'utf8') === serialised) {
    process.stdout.write('the theme schema snapshot is current\n');
    process.exit(0);
  }

  process.stderr.write(
    'The theme schema has widened and the snapshot has not been updated.\n' +
      'Run: pnpm --filter @storeware/theme-schema snapshot\n',
  );
  process.exit(1);
}

writeFileSync(path, serialised);
process.stdout.write(`wrote ${path}\n`);
