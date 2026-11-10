import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MAX_SECTIONS_PER_PAGE,
  PAGE_TYPES,
  defaultTemplateFor,
  parseBlocks,
  parseSection,
  sectionAllowedOn,
  sectionDefinitionViews,
  themeTokensInput,
  type EditableToken,
  type FieldView,
  type LayoutSection,
  type PageType,
  type SectionDefinitionView,
} from '@storeware/theme-schema';
import {
  exportTheme,
  fetchThemeDraft,
  importTheme,
  listStores,
  mintPreview,
  publishTheme,
  type ImportReport,
  type StoreSummary,
} from './api';
import { requireCredentials, loadConfig, type Credentials } from './config';
import type { Args } from './args';
import type { CommandId } from './commands';

/**
 * The theme commands: a shop's look, on disk.
 *
 * ## Why this file can exist at all
 *
 * A theme on this platform is data rather than code. There is no template
 * language and no expression syntax, so a theme file is tokens, page templates
 * and block trees, and reading one is a parse rather than an evaluation. That
 * is what makes an offline `validate` possible: there is nothing in a theme
 * file whose meaning depends on a database.
 *
 * ## Why `validate` imports the platform's own parsers
 *
 * `@storeware/theme-schema` is the registry the server parses with, imported
 * here rather than described again. That is the whole reason it was extracted.
 * A CLI carrying its own copy of forty-five section definitions is a copy that
 * is wrong within a release: a section gains a setting on Tuesday, the merchant
 * uses it on Wednesday, and their theme file fails a check that no longer
 * matches anything the platform believes. Worse in the other direction, a copy
 * that is too permissive passes a file the shop then silently drops a third of.
 *
 * So the vocabulary is never restated here. `parseSection`, `sectionAllowedOn`
 * and `themeTokensInput` are the same functions the import route runs.
 *
 * ## The one thing that IS restated, and why that is defensible
 *
 * The envelope. `storeware`, `version`, `name`, `store`, `exportedAt`, `tokens`
 * and `templates` are checked by hand in `readEnvelope` below, because the
 * schema for them lives in `@storeware/core` beside the code that reads a
 * database, and this package must not depend on that.
 *
 * The trade is small in exactly the way the vocabulary's is not. The envelope
 * is eight fields and has changed once in the format's life; the vocabulary is
 * forty-five sections with several hundred settings between them and changes
 * most weeks. Restating seven fields is a paragraph. Restating the vocabulary
 * is the drift this package was extracted to end.
 *
 * The version is the part worth watching, so it is pinned as a constant with
 * its own note, and a file from a newer platform is refused rather than read
 * optimistically.
 *
 * ## Why there is no `storeware theme dev`
 *
 * A watch loop that re-uploaded the draft and refreshed a preview is the
 * obvious next command, and three things have to exist before it would work.
 * None of them is "we did not get to it".
 *
 * First, there is no live-reload channel. A shop page is server-rendered and
 * served from the edge, and nothing on it holds a connection open, so a
 * rebuilt draft has no way to tell an open tab to fetch itself again. A dev
 * loop without one is a loop that asks the merchant to press reload, which is
 * what they were doing anyway.
 *
 * Second, and this is the one that makes a naive implementation actively
 * harmful: minting a preview token RETIRES every earlier draft token. The rule
 * is deliberate and right -- a merchant opening the editor on a second machine
 * should not leave a working preview of their unpublished shop behind on the
 * first -- but it means a watch loop that minted on every save would invalidate
 * the URL the merchant is watching. The tab they are staring at would go blank
 * on each keystroke, and the cause would look like a broken shop rather than a
 * broken loop.
 *
 * Third, a preview token lives an hour. A design session does not, so the
 * session would outlive its own credential, and the CLI has no refresh: the
 * failure would arrive an hour in, halfway through an afternoon's work.
 *
 * What would have to exist first, in order: a preview channel the storefront
 * serves so a redraw does not need a new credential; a mint that renews a live
 * draft token rather than replacing it; and a refresh path in the CLI's
 * credential store. Until all three exist, `theme dev` is a loop that logs a
 * merchant out of their own preview. `pull`, `validate` and `push` are the loop
 * that works today, and each of them ends somewhere a person can look.
 */

const out = (text: string) => process.stdout.write(`${text}\n`);
const err = (text: string) => process.stderr.write(`${text}\n`);

/**
 * A theme problem the developer has to fix.
 *
 * Parallel to `ManifestError` and caught by the same top-level handler, so a
 * bad file prints a sentence rather than a stack. Anything that reaches the
 * handler as a plain `Error` is ours, and the stack is the useful part of it.
 */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

/**
 * The format version this CLI knows how to read.
 *
 * Pinned rather than imported, because the constant lives in core beside the
 * exporter. It is the one number in this file that can silently fall behind the
 * platform, which is why a file claiming a higher version is refused outright:
 * doing its best with a newer file means reporting a theme as valid when this
 * release cannot see half of what it says.
 *
 * Bumped when the file SHAPE changes, which has happened once, when art
 * direction was added. A new section type does not bump it.
 */
export const KNOWN_THEME_FILE_VERSION = 2;

export interface ThemeFile {
  storeware: 'theme';
  version: number;
  name?: string;
  store?: string;
  exportedAt?: string;
  tokens: Record<string, string>;
  art?: Record<string, unknown>;
  templates: Record<string, unknown[]>;
}

export interface ThemeProblem {
  /** A dotted address, so the message reads as a place in the file. */
  at: string;
  /** What is wrong, in the words somebody has to act on. */
  says: string;
}

export interface PageReading {
  page: string;
  /** Bands this CLI could read and that are allowed on the page. */
  read: number;
  /** Bands the file lists for it. */
  total: number;
}

export interface ThemeReport {
  version: number | null;
  name: string | null;
  /** The shop the file was exported from, when it says. */
  from: string | null;
  tokens: { kept: number; total: number };
  pages: PageReading[];
  /** Media ids the file carries, which travel only back to the shop that made it. */
  pictures: number;
  /** Art keys. Counted, never checked: the reader for them is not in this package. */
  art: number;
  errors: ThemeProblem[];
  warnings: ThemeProblem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The registry, indexed once. `sectionDefinitionViews` rebuilds its array per call. */
const VIEWS: ReadonlyMap<string, SectionDefinitionView> = new Map(
  sectionDefinitionViews().map((view) => [view.type, view]),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPageType = (value: string): value is PageType =>
  (PAGE_TYPES as readonly string[]).includes(value);

/**
 * The seven fields around the theme, checked by hand.
 *
 * Returns the file when it is one, or the reason it is not. A caller with a
 * reason has nothing further to say about the contents: a file that is not a
 * theme file has no bands to report on, and listing "home is not a page" under
 * "this is a package.json" helps nobody.
 */
/**
 * A string from a theme file, safe to write to a terminal.
 *
 * A theme file is an exchange format. Its own README has a section headed "What
 * travels between shops", so the person running `theme validate` is often not
 * the person who wrote the file, and every string in it is somebody else's
 * text arriving on this machine.
 *
 * Written raw, a name containing `ESC[2K` erases the line it is printed on. A
 * file can therefore scroll away the error lines above it and present a rejected
 * theme as a clean one, which turns the one command whose whole job is to tell
 * you the truth into the one that lies. Colour codes are the harmless version of
 * the same mechanism.
 *
 * The package's security argument -- nothing in a theme file executes -- is
 * about a renderer and says nothing about a terminal. So control characters are
 * replaced rather than stripped, because a name that silently loses characters
 * is its own small confusion, and the length is capped so one field cannot push
 * the rest of the report off the screen.
 */
function printable(value: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const tamed = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return tamed.length > max ? `${tamed.slice(0, max - 1)}\u2026` : tamed;
}

function readEnvelope(value: unknown): { file: ThemeFile } | { problem: ThemeProblem } {
  if (!isRecord(value)) {
    return {
      problem: {
        at: 'file',
        says: 'That is not a Storeware theme file. It is not even an object.',
      },
    };
  }

  if (value.storeware !== 'theme') {
    return {
      problem: {
        at: 'storeware',
        says: 'That is not a Storeware theme file. A theme file says `"storeware": "theme"` at the top.',
      },
    };
  }

  if (typeof value.version !== 'number' || !Number.isInteger(value.version)) {
    return { problem: { at: 'version', says: 'A theme file carries a whole-number version.' } };
  }

  if (value.version > KNOWN_THEME_FILE_VERSION) {
    return {
      problem: {
        at: 'version',
        says: `That theme was made by a newer version of Storeware (${value.version}). Update the CLI, or export it again from the shop it came from.`,
      },
    };
  }

  if (!isRecord(value.tokens)) {
    return {
      problem: { at: 'tokens', says: 'A theme file carries a `tokens` object, even an empty one.' },
    };
  }

  if (!isRecord(value.templates)) {
    return {
      problem: {
        at: 'templates',
        says: 'A theme file carries a `templates` object, keyed by page.',
      },
    };
  }

  /*
   * The three string bounds, which the first version of this left out.
   *
   * They are the whole risk of restating an envelope rather than importing its
   * schema, and the risk arrived immediately: a file with a 300-character
   * `name` passed `theme validate` and was refused by the server with one
   * opaque sentence naming no field, which is the worst of both. A copy that is
   * too permissive does not merely fail to catch things; it certifies them.
   *
   * Trimmed as well as bounded, because the server trims and a value that
   * differs after a round trip is a value somebody will eventually diff.
   */
  const bounded = (
    field: 'name' | 'store' | 'exportedAt',
    max: number,
  ): { value?: string } | { problem: ThemeProblem } => {
    const raw = value[field];
    if (raw === undefined) return {};
    if (typeof raw !== 'string') {
      return { problem: { at: field, says: `\`${field}\` is text when it is present at all.` } };
    }

    const trimmed = raw.trim();
    if (trimmed.length > max) {
      return {
        problem: {
          at: field,
          says: `\`${field}\` is at most ${max} characters and this one is ${trimmed.length}. The shop refuses the whole file over it, so it is worth shortening here.`,
        },
      };
    }

    return { value: trimmed };
  };

  const name = bounded('name', 200);
  const store = bounded('store', 64);
  const exportedAt = bounded('exportedAt', 40);

  for (const field of [name, store, exportedAt]) {
    if ('problem' in field) return { problem: field.problem };
  }

  return {
    file: {
      storeware: 'theme',
      version: value.version,
      ...('value' in name && name.value !== undefined ? { name: name.value } : {}),
      ...('value' in store && store.value !== undefined ? { store: store.value } : {}),
      ...('value' in exportedAt && exportedAt.value !== undefined
        ? { exportedAt: exportedAt.value }
        : {}),
      tokens: value.tokens as Record<string, string>,
      ...(isRecord(value.art) ? { art: value.art } : {}),
      templates: value.templates as Record<string, unknown[]>,
    },
  };
}

/**
 * Everything this CLI can say about a theme file without a network.
 *
 * Errors are things the platform will refuse or drop. Warnings are things it
 * will accept while quietly changing them, which is the category worth having:
 * a band over the page limit, a choice nothing has a branch for, a block that
 * does not parse. Each of those imports "successfully" and comes back looking
 * like a theme that was always that way.
 */
export function validateTheme(value: unknown): ThemeReport {
  const report: ThemeReport = {
    version: null,
    name: null,
    from: null,
    tokens: { kept: 0, total: 0 },
    pages: [],
    pictures: 0,
    art: 0,
    errors: [],
    warnings: [],
  };

  const envelope = readEnvelope(value);
  if ('problem' in envelope) {
    report.errors.push(envelope.problem);
    return report;
  }

  const file = envelope.file;
  report.version = file.version;
  // Tamed once, here, rather than at each of the places that print them. A
  // report is passed around and printed by more than one command.
  report.name = file.name === undefined ? null : printable(file.name);
  report.from = file.store === undefined ? null : printable(file.store);
  report.art = file.art ? Object.keys(file.art).length : 0;

  readTokens(file, report);
  readTemplates(file, report);

  return report;
}

/**
 * Tokens, one at a time.
 *
 * One at a time because that is how the import route reads them: a file with
 * one bad colour imports the other nine rather than none. Checking the whole
 * map at once would report a file as unusable when the shop would take almost
 * all of it.
 */
function readTokens(file: ThemeFile, report: ThemeReport): void {
  for (const [name, value] of Object.entries(file.tokens)) {
    report.tokens.total += 1;

    if (typeof value !== 'string') {
      report.errors.push({
        at: `tokens.${name}`,
        says: 'A token is a string: a colour, a length or a font name.',
      });
      continue;
    }

    const parsed = themeTokensInput.safeParse({ [name]: value });
    if (parsed.success) {
      report.tokens.kept += 1;
      continue;
    }

    // The platform's own sentence, not a rewrite of it. It already says either
    // "not a token a shop can set" or "not a value this can accept", and those
    // are the two things that can be wrong.
    report.errors.push({
      at: `tokens.${printable(name, 60)}`,
      // The platform's sentence interpolates the value the file supplied, so it
      // carries the file's text and is tamed like any other.
      says: printable(
        parsed.error.issues[0]?.message ?? 'That is not a value a shop can set.',
        200,
      ),
    });
  }
}

function readTemplates(file: ThemeFile, report: ThemeReport): void {
  for (const [page, bands] of Object.entries(file.templates)) {
    if (!Array.isArray(bands)) {
      report.errors.push({
        at: `templates.${page}`,
        says: 'A page is a list of bands, so this has to be an array.',
      });
      continue;
    }

    if (!isPageType(page)) {
      report.errors.push({
        at: `templates.${page}`,
        says: `${page} is not a page this platform arranges. Its ${bands.length} band${bands.length === 1 ? '' : 's'} will not be read. The pages are: ${PAGE_TYPES.join(', ')}.`,
      });
      continue;
    }

    /*
     * Over the limit is a warning rather than an error, and it is the one this
     * whole command earns its place with.
     *
     * The import route slices to `MAX_SECTIONS_PER_PAGE` before it counts
     * anything, so bands past the twelfth are neither placed nor skipped: they
     * are absent from both halves of a report whose entire purpose is that no
     * loss is silent. Nothing on the server will ever mention them.
     */
    if (bands.length > MAX_SECTIONS_PER_PAGE) {
      report.warnings.push({
        at: `templates.${page}`,
        says: `${bands.length} bands, and a page holds ${MAX_SECTIONS_PER_PAGE}. The last ${bands.length - MAX_SECTIONS_PER_PAGE} are dropped on import, and the import report does not count them.`,
      });
    }

    let read = 0;

    for (const [index, band] of bands.entries()) {
      const at = `templates.${page}[${index}]`;
      const parsed = parseSection(band);

      if (parsed === null) {
        report.errors.push(...whyUnreadable(band, at));
        continue;
      }

      if (!sectionAllowedOn(parsed.type, page)) {
        const view = VIEWS.get(parsed.type);
        report.errors.push({
          at,
          says: `${parsed.type} bands may not sit on a ${page} page, so this one is dropped. They are allowed on: ${view?.pages.join(', ') ?? 'no page'}.`,
        });
        continue;
      }

      /*
       * Past the limit, a band is counted nowhere.
       *
       * The import route slices to `MAX_SECTIONS_PER_PAGE` BEFORE it parses
       * anything, so a thirteenth band is never placed and never will be. This
       * count feeds the comparison in `importReportLines`, and counting one
       * here would report a disagreement between this CLI and the shop -- with
       * a message about release skew -- for a file that is simply too long. The
       * page-level warning above is where the truncation is said, once.
       *
       * Errors are still reported for those bands, which is the deliberate
       * exception: a theme file is a document somebody edits, and a broken band
       * at the bottom of a page becomes the platform's problem the moment they
       * delete one above it.
       */
      if (index >= MAX_SECTIONS_PER_PAGE) continue;

      read += 1;
      report.warnings.push(...whatChangesQuietly(band, parsed, at));
      report.pictures += picturesIn(band);
    }

    report.pages.push({ page, read, total: bands.length });
  }

  // Declared order rather than the file's, so two themes read the same way.
  report.pages.sort(
    (a, b) => PAGE_TYPES.indexOf(a.page as PageType) - PAGE_TYPES.indexOf(b.page as PageType),
  );
}

/**
 * Why one band did not parse, narrowed to the setting that did it.
 *
 * `parseSection` answers null for a whole band, which is right for a renderer
 * -- it drops one band rather than a page -- and useless to somebody holding
 * the file. So the setting is found by putting the band back together one field
 * at a time and asking the platform's own parser again. Every setting is
 * optional, so a band of nothing but its type parses; the first field that
 * breaks it is the answer.
 *
 * Slower than reading the schema directly and correct in a way that cannot
 * drift, which is the trade this whole file makes. A band has a handful of
 * settings and a person is waiting on a file, not a request.
 */
function whyUnreadable(band: unknown, at: string): ThemeProblem[] {
  if (!isRecord(band)) {
    return [{ at, says: 'A band is an object with a `type`, and this is not an object.' }];
  }

  const type = band.type;
  if (typeof type !== 'string') {
    return [{ at, says: 'A band names its `type`, and this one does not.' }];
  }

  const view = VIEWS.get(type);
  if (!view) {
    return [
      {
        at,
        says: `${type} is not a band this platform builds. If the shop is on a newer release than this CLI, updating may recognise it.`,
      },
    ];
  }

  // A known type whose bare form does not parse would mean the probe below
  // blames every setting in turn. Nothing in the registry can do that today,
  // and saying so is cheaper than a report full of false addresses.
  if (parseSection({ type }) === null) {
    return [{ at, says: `A bare ${type} band does not parse, which is a platform fault.` }];
  }

  const problems: ThemeProblem[] = [];

  for (const [name, value] of Object.entries(band)) {
    // `blocks` is parsed separately and drops its bad rows rather than failing,
    // so it can never be the reason a band did not parse.
    if (name === 'type' || name === 'blocks') continue;
    if (parseSection({ type, [name]: value }) !== null) continue;

    problems.push({ at: `${at}.${name}`, says: wants(view, name, value) });
  }

  return problems.length > 0
    ? problems
    : [{ at, says: `This ${type} band does not parse, and no single setting explains it.` }];
}

/** What one setting will take, said in the words of its own declaration. */
function wants(view: SectionDefinitionView, name: string, value: unknown): string {
  if (name === 'id') {
    return 'A band id is six to thirty-two lowercase letters and digits, or absent.';
  }

  const field = view.settings.find((setting) => setting.name === name);
  if (!field) {
    return `${JSON.stringify(value)} is not something ${view.type} accepts here.`;
  }

  return `${field.label} is a ${field.kind} setting${bounds(field)}, and ${JSON.stringify(value)} is not one.`;
}

function bounds(field: FieldView): string {
  if (field.choices) return ` (one of: ${field.choices.map((c) => c.value).join(', ')})`;
  if (field.min !== undefined && field.max !== undefined) return ` (${field.min} to ${field.max})`;
  if (field.max !== undefined) return ` (up to ${field.max})`;
  return '';
}

/**
 * What the platform will accept and then change.
 *
 * The dangerous category. Each of these imports without complaint and comes
 * back looking like a theme that was always that way, which is exactly the
 * failure the import report exists to prevent and cannot see.
 */
function whatChangesQuietly(band: unknown, parsed: LayoutSection, at: string): ThemeProblem[] {
  if (!isRecord(band)) return [];

  const view = VIEWS.get(parsed.type);
  if (!view) return [];

  const problems: ThemeProblem[] = [];

  for (const field of view.settings) {
    if (field.kind !== 'select' || !field.choices) continue;

    const value = band[field.name];
    if (typeof value !== 'string') continue;
    if (field.choices.some((choice) => choice.value === value)) continue;

    /*
     * A select that cannot be read falls back to absent rather than failing its
     * band, on purpose: a shop losing a whole hero because a preset was renamed
     * is strictly worse than that hero rendering in its default look. The
     * consequence is that this is invisible everywhere else, including in the
     * import report, so it is said here.
     */
    problems.push({
      at: `${at}.${field.name}`,
      says: `${JSON.stringify(value)} is not one of ${field.choices.map((c) => c.value).join(', ')}. The band keeps its default look instead, and nothing reports it.`,
    });
  }

  const blocks = band.blocks;
  if (Array.isArray(blocks) && blocks.length > 0) {
    if (!view.blocks) {
      problems.push({
        at: `${at}.blocks`,
        says: `${parsed.type} bands take no blocks, so all ${blocks.length} are dropped.`,
      });
    } else {
      const kept = parseBlocks(parsed.type, blocks).length;
      if (kept < blocks.length) {
        const over = blocks.length > view.blocks.max;
        problems.push({
          at: `${at}.blocks`,
          says: over
            ? `${blocks.length} blocks, and this band holds ${view.blocks.max}. ${blocks.length - kept} are dropped.`
            : `${blocks.length - kept} of ${blocks.length} blocks do not parse and are dropped.`,
        });
      }
    }
  }

  return problems;
}

/** Media ids in a band, counted the way the import route finds them: by shape. */
function picturesIn(band: unknown): number {
  if (!isRecord(band)) return 0;

  let found = 0;

  for (const [name, value] of Object.entries(band)) {
    if (name === 'blocks') continue;
    if (typeof value === 'string' && UUID.test(value)) found += 1;
  }

  if (Array.isArray(band.blocks)) {
    for (const block of band.blocks) {
      if (!isRecord(block)) continue;
      for (const value of Object.values(block)) {
        if (typeof value === 'string' && UUID.test(value)) found += 1;
      }
    }
  }

  return found;
}

/**
 * The report as lines, so what is printed can be tested without a terminal.
 *
 * Errors before warnings, and both before the summary, because a person reading
 * a failing command reads the top of it.
 */
export function reportLines(report: ThemeReport): string[] {
  const lines: string[] = [];

  for (const problem of report.errors) lines.push(`  error    ${problem.at}: ${problem.says}`);
  for (const problem of report.warnings) lines.push(`  warning  ${problem.at}: ${problem.says}`);
  if (lines.length > 0) lines.push('');

  if (report.version === null) return lines;

  lines.push(`  ${report.name ?? 'A theme'}, format version ${report.version}`);
  lines.push(`  tokens        ${report.tokens.kept} of ${report.tokens.total} settable`);

  for (const page of report.pages) {
    lines.push(
      `  ${page.page.padEnd(13)} ${page.read} of ${page.total} band${page.total === 1 ? '' : 's'}`,
    );
  }

  if (report.art > 0) {
    // Counted rather than checked. The reader for art direction lives with the
    // shop rather than in the theme vocabulary, so claiming to have validated
    // it would be a claim this command cannot make.
    lines.push(`  art           ${report.art} settings, read by the shop on import`);
  }

  if (report.pictures > 0) {
    lines.push(
      report.from
        ? // Not `report.from`, which is a store uuid rather than a name.
          // `exportTheme` writes `store: storeId`, so printing it gave a
          // merchant a line ending in a raw identifier that reads as a
          // corrupted field. The rule it states is the useful part, and the
          // shop it names is one the reader already knows: their own.
          `  pictures      ${report.pictures}, kept only on import back into the shop this came from`
        : `  pictures      ${report.pictures}, and this file does not say which shop they belong to, so they are dropped`,
    );
  }

  return lines;
}

/**
 * The four numbers an import answers with, all of them, every time.
 *
 * Printed in full rather than summarised, because the sum is the only thing
 * that makes the import honest: an import that quietly dropped a third of a
 * theme would look like a theme that was always like that.
 */
export function importReportLines(report: ImportReport, expected: number): string[] {
  const placed = Object.values(report.placed).reduce((total, count) => total + count, 0);
  const lines: string[] = [];

  for (const [page, count] of Object.entries(report.placed)) {
    lines.push(`  placed        ${count} on ${page}`);
  }
  if (placed === 0) lines.push('  placed        nothing');

  lines.push(`  skipped       ${report.skipped}`);
  lines.push(`  pictures      ${report.picturesDropped} dropped`);
  lines.push(`  tokens        ${report.tokensDropped} dropped`);

  /*
   * The comparison is worth more than either number alone.
   *
   * This CLI and the shop parse with the same package, but not necessarily the
   * same version of it: an installed CLI can be behind a deployed platform or
   * ahead of it. When the two counts differ, the file is fine and the two
   * readers disagree, and knowing which way round tells somebody whether to
   * update the CLI or wait for a deploy.
   */
  if (placed !== expected) {
    lines.push('');
    lines.push(
      placed < expected
        ? `  This CLI read ${expected} bands and the shop placed ${placed}. The shop is on an older release, or the file uses something it has not shipped yet.`
        : `  The shop placed ${placed} bands and this CLI only read ${expected}. Update the CLI: it does not know every band the shop does.`,
    );
  }

  return lines;
}

/**
 * The ten tokens a shop is coloured in, at their platform values.
 *
 * Copied from `@storeware/ui`'s light palette rather than imported, because the
 * CLI must not depend on the design system to write a starter file, and these
 * are a starting point rather than a contract: a theme that omits a token gets
 * the platform's own, so every line here exists to be edited or deleted.
 *
 * The drift risk is real and is closed by a test rather than by discipline.
 * `theme.test.ts` runs these through `themeTokensInput`, which is the allow-list
 * the server uses, so a tightened rule fails here before it reaches a merchant
 * scaffolding a theme.
 *
 * Every token but the second accent, which the platform has no value for: a
 * shop without one draws everything in the first, and a theme that wants one
 * adds both halves.
 */
const STARTER_TOKENS: Record<Exclude<EditableToken, 'accent2' | 'accent2Fg'>, string> = {
  bg: '#fbfbfa',
  surface: '#ffffff',
  fg: '#16150f',
  muted: '#6b6a63',
  line: '#e3e2dc',
  accent: '#16150f',
  accentFg: '#fbfbfa',
  radius: '10px',
  fontSans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontMono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

/**
 * A theme file that changes nothing.
 *
 * Seeded from the platform's own defaults on both halves: the tokens above, and
 * `defaultTemplateFor` for every page that renders something before a merchant
 * arranges anything. Importing it produces the shop that was already there.
 *
 * That is the point. A scaffold full of somebody else's design choices makes
 * the first diff unreadable, because it mixes what the merchant changed with
 * what the template arrived with. Starting from the shop as it is means the
 * first diff is the only diff.
 *
 * Pages whose default is empty are left out. An empty array would say "render
 * nothing on the product page", which is a decision, and the absence says
 * "render the page the storefront already renders", which is not.
 */
export function starterTheme(name = 'A new theme'): ThemeFile {
  const templates: Record<string, LayoutSection[]> = {};

  for (const page of PAGE_TYPES) {
    const bands = defaultTemplateFor(page);
    if (bands.length > 0) templates[page] = bands;
  }

  return {
    storeware: 'theme',
    version: KNOWN_THEME_FILE_VERSION,
    name,
    // No `store`, deliberately. The field means "exported from", and a
    // scaffolded file was not. Claiming a shop it did not come from would make
    // an import carry picture ids that resolve to nothing.
    tokens: { ...STARTER_TOKENS },
    templates,
  };
}

export function themeReadme(name: string): string {
  return `# ${name}

A Storeware theme. It is data rather than code: colours, page templates and the
bands each page is made of. There is no template language, nothing in the file
executes, and every value is either a name from the platform's vocabulary or a
string that has passed its allow-list.

## The loop

1. \`storeware theme validate\` reads the file with the platform's own parsers.
   No network, no shop, no account.
2. \`storeware theme push\` sends it to your shop's DRAFT. Your shoppers see
   nothing yet.
3. \`storeware theme preview\` prints a link that serves the draft.
4. \`storeware theme publish --yes\` makes the draft the shop.

\`storeware theme pull\` goes the other way and writes your shop's published look
to a file, which is how you keep a copy before an afternoon of changes.

## What travels between shops and what does not

Colours and layouts travel. Pictures do not: a picture is an id in one shop's
library and means nothing in another's, so an import into a different shop drops
them and tells you how many. A file imported back into the shop it came from
keeps them, which is what makes an export a usable backup.

Handles travel but may not resolve. \`featured_product: "anorak"\` is a real
product in the shop that exported it and probably nothing in the shop importing.
The band renders nothing rather than disappearing, so retyping a few handles is
the whole cost.

## Things worth knowing

A page holds twelve bands. Anything past the twelfth is dropped on import and is
not counted in what the shop reports back, which is why \`storeware theme
validate\` warns about it before you push.

A token a shop is not allowed to set is dropped, one at a time, so a file with
one bad colour still imports the other nine.

Importing never touches the published shop. Publishing is a separate command and
asks for \`--yes\`, because it is the only one a shopper can see.
`;
}

/**
 * Which shop a command acts on.
 *
 * Every theme endpoint is `/stores/{storeId}/...` and a store id is a uuid
 * nobody types, so `--store` takes a handle too and this resolves it. The list
 * is fetched even when an id was given, which is one extra request per command
 * and buys two things: an id that this account cannot reach fails here with a
 * sentence instead of a 403 further in, and every command can print the name of
 * the shop it is about to act on. That printout is most of what makes
 * `publish --yes` a confirmation rather than a ceremony.
 *
 * A single shop needs no flag. Several shops and no flag is refused rather than
 * guessed at, because the wrong guess here publishes a design to somebody's
 * live storefront.
 */
async function resolveStore(credentials: Credentials, named: string | undefined) {
  const stores = await listStores(credentials);

  if (stores.length === 0) {
    throw new ThemeError('This organisation has no shops yet. Create one in the admin first.');
  }

  if (named) {
    const found = stores.find((store) => store.id === named || store.handle === named);
    if (found) return found;

    throw new ThemeError(
      `No shop here is called ${named}. This organisation has: ${stores.map((s) => s.handle).join(', ')}.`,
    );
  }

  const only = stores[0];
  if (stores.length === 1 && only) return only;

  throw new ThemeError(
    `This organisation has ${stores.length} shops, so name one with --store: ${stores.map((s) => s.handle).join(', ')}.\n` +
      'Or save a default with `storeware login --store <handle>`.',
  );
}

/** Resolves credentials and a shop together, which every networked command needs. */
async function context(args: Args): Promise<{ credentials: Credentials; store: StoreSummary }> {
  const config = await loadConfig();
  const credentials = requireCredentials(config);
  const store = await resolveStore(credentials, args.flag('store') ?? config.storeId);

  return { credentials, store };
}

function themePath(args: Args, fallback = 'theme.json'): string {
  return resolve(process.cwd(), args.positional(0) ?? fallback);
}

async function readThemeFile(path: string): Promise<unknown> {
  let source: string;

  try {
    source = await readFile(path, 'utf8');
  } catch {
    throw new ThemeError(`No theme at ${path}. Run \`storeware theme init\` to start one.`);
  }

  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new ThemeError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** How many bands this CLI reads, which is what the shop's count is compared against. */
function bandsRead(report: ThemeReport): number {
  return report.pages.reduce((total, page) => total + page.read, 0);
}

async function init(args: Args): Promise<void> {
  const directory = resolve(process.cwd(), args.positional(0) ?? '.');
  const name = args.flag('name') ?? 'A new theme';

  const files: [string, string][] = [
    ['theme.json', `${JSON.stringify(starterTheme(name), null, 2)}\n`],
    ['README.md', themeReadme(name)],
  ];

  /*
   * The directory first, which this did not do and the plugin `init` beside it
   * always has.
   *
   * `storeware theme init my-theme` crashed with an ENOENT and a Node stack
   * trace, which is the exact failure `ThemeError` and the top-level catch
   * exist to prevent, on the first command anybody runs. `recursive` so that a
   * nested path works and so that an existing directory is not an error, which
   * is the same tolerance the never-overwrite loop below shows.
   */
  await mkdir(directory, { recursive: true });

  for (const [file, contents] of files) {
    const path = resolve(directory, file);
    // Never overwrite, on the same reasoning `storeware init` gives: running
    // this in an existing project should add what is missing, not silently
    // replace an afternoon of somebody's design.
    try {
      await readFile(path, 'utf8');
      out(`  skipped  ${file} (already exists)`);
    } catch {
      await writeFile(path, contents, 'utf8');
      out(`  created  ${file}`);
    }
  }

  out(
    `\nScaffolded ${name}. It is the shop as the platform ships it, so your first\n` +
      'change is the only change in the diff.\n\n' +
      "  storeware theme validate    read it with the platform's own parsers\n" +
      "  storeware theme push        send it to your shop's draft\n",
  );
}

async function validate(args: Args): Promise<void> {
  const path = themePath(args);
  const report = validateTheme(await readThemeFile(path));

  out('');
  for (const line of reportLines(report)) out(line);
  out('');

  if (report.errors.length > 0) {
    err(
      `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'} in ${path}. The shop would refuse or drop each one.`,
    );
    process.exitCode = 1;
    return;
  }

  out(
    report.warnings.length > 0
      ? `  ${path} imports, but not exactly as written. The warnings above say what changes.`
      : `  ${path} is a theme this platform reads whole.`,
  );
  out('');
}

async function pull(args: Args): Promise<void> {
  /*
   * The destination is decided and defended BEFORE anything is resolved, which
   * is the discipline `push` states three functions down: "a typo in a filename
   * costs no round trip". This did it the other way round, so `theme pull` onto
   * an existing file signed in and fetched the store list purely in order to
   * refuse.
   */
  const path = resolve(process.cwd(), args.flag('out') ?? args.positional(0) ?? 'theme.json');

  /*
   * Refuses to clobber, and the flag is named in the message.
   *
   * A pull that overwrote silently would be the one command in this group that
   * destroys work, and it would do it in the exact situation a person is most
   * likely to be in: pull, edit for an hour, pull again out of habit. The file
   * on disk is the only copy of those edits; the shop still has its own.
   */
  if (!args.has('force')) {
    try {
      await readFile(path, 'utf8');
      throw new ThemeError(
        `${path} already exists. Pass --force to replace it, or name another file.`,
      );
    } catch (error) {
      if (error instanceof ThemeError) throw error;
    }
  }

  const { credentials, store } = await context(args);
  const file = await exportTheme(credentials, store.id, args.flag('name'));
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  const report = validateTheme(file);

  out('');
  out(`  ${store.name} (${store.handle}) as it is published, written to ${path}`);
  out('');
  for (const line of reportLines(report)) out(line);
  out('');
}

async function push(args: Args): Promise<void> {
  // Read before anything is resolved, so a typo in a filename costs no round
  // trip and no half-written draft. `storeware apply` parses its manifest first
  // for the same reason.
  const path = themePath(args);
  const file = await readThemeFile(path);
  const report = validateTheme(file);

  if (args.has('publish')) {
    throw new ThemeError(
      'Pushing writes the draft and never the shop. Publishing is its own command:\n' +
        '  storeware theme push\n' +
        '  storeware theme preview\n' +
        '  storeware theme publish --yes',
    );
  }

  if (report.version === null) {
    // The envelope, and only the envelope. A file that is not a theme file is
    // refused here because the shop would refuse it too, and a round trip to be
    // told so helps nobody.
    for (const line of reportLines(report)) err(line);
    throw new ThemeError(`${path} is not a theme file this CLI can send.`);
  }

  /*
   * Everything else is printed and pushed anyway, which is the opposite of what
   * a strict CLI would do and is the right way round here.
   *
   * The theme vocabulary only ever loosens: a section type is never renamed or
   * removed and a bound never tightens, which is the promise
   * `@storeware/theme-schema` makes and checks on every test run. So a CLI
   * older than the platform will legitimately fail to read a band the shop
   * draws perfectly well. A CLI that refused on its own reading would block a
   * valid theme, and the only way through would be a --force flag whose real
   * meaning is "ignore the one check I added".
   *
   * So the local reading is a prediction, the shop's report is the truth, and
   * `importReportLines` compares them. When they disagree, that disagreement is
   * the most useful line in the output.
   */
  const local = reportLines(report);
  if (report.errors.length > 0 || report.warnings.length > 0) {
    out('');
    out('  What this CLI reads:');
    out('');
    for (const line of local) out(line);
  }

  const { credentials, store } = await context(args);
  const result = await importTheme(credentials, store.id, file);

  out('');
  out(`  Read into the draft of ${store.name} (${store.handle}). Shoppers see nothing yet.`);
  out('');
  for (const line of importReportLines(result, bandsRead(report))) out(line);
  out('');
  out('  storeware theme preview     look at it');
  out('  storeware theme publish     make it the shop');
  out('');
}

async function preview(args: Args): Promise<void> {
  const { credentials, store } = await context(args);
  const minted = await mintPreview(credentials, store.id);

  /*
   * Printed rather than opened.
   *
   * Opening a browser would be one line and it is the wrong line. A URL on
   * screen is a thing a person reads before they follow it, it works over ssh
   * and in CI, and it does not require this process to decide what a browser is
   * on somebody else's machine. The same reasoning keeps `apply` from opening
   * the admin after it registers a plugin.
   */
  out('');
  out(`  ${minted.previewUrl}`);
  out('');
  out(`  ${store.name} (${store.handle}), serving its draft. Expires ${minted.expiresAt}.`);
  out('  Minting this retired any earlier preview link for this draft.');
  out('');
}

async function publish(args: Args): Promise<void> {
  const { credentials, store } = await context(args);

  if (!args.has('yes')) {
    /*
     * The read that makes the flag mean something.
     *
     * A confirmation nobody can act on is a keystroke, not a check. So the
     * refusal costs one request and answers the question a person actually has
     * at that moment, which is "what is in the draft I am about to make live".
     */
    const draft = await fetchThemeDraft(credentials, store.id);

    out('');
    out(`  ${store.name} (${store.handle})`);
    out('');

    if (!draft.editing) {
      out('  There is no draft. The shop is already showing its published look.');
      out('');
      return;
    }

    for (const [page, bands] of Object.entries(draft.layout)) {
      if (Array.isArray(bands)) out(`  ${page.padEnd(13)} ${bands.length} bands`);
    }
    out(`  tokens        ${Object.keys(draft.tokens).length}`);
    out('');
    err('This is the only command a shopper can see. Pass --yes to publish it.');
    process.exitCode = 1;
    return;
  }

  const published = await publishTheme(credentials, store.id);

  out('');
  out(`  Published to ${store.name} (${store.handle}).`);
  out('');
  for (const [page, bands] of Object.entries(published.layout)) {
    if (Array.isArray(bands)) out(`  ${page.padEnd(13)} ${bands.length} bands`);
  }
  out(`  tokens        ${Object.keys(published.tokens).length}`);
  out('');
  out('  The look it replaced is kept. `storeware theme pull` writes the new one to a file.');
  out('');
}

/**
 * Each theme command, by its id in `./commands`, which is where its usage,
 * its help and its docs page are written. The CLI's entry point runs these
 * from the same table as every other command.
 */
export const THEME_COMMANDS = {
  'theme.init': init,
  'theme.validate': validate,
  'theme.pull': pull,
  'theme.push': push,
  'theme.preview': preview,
  'theme.publish': publish,
} satisfies Record<Extract<CommandId, `theme.${string}`>, (args: Args) => Promise<void>>;
