import {
  FIELD_KINDS,
  MAX_BODY,
  MAX_HEADING,
  MAX_SECTIONS_PER_PAGE,
  PAGE_TYPES,
  sectionDefinitionViews,
  type FieldView,
} from './sections';

/**
 * The promise this package makes, made executable.
 *
 * ## Why a promise is needed at all
 *
 * A theme is stored, not compiled. Every themed shop on the platform holds an
 * array of `{ type, ...settings }` in a database column, and every theme file an
 * agency ships is the same array on disk. Neither is re-read when this package
 * changes. So a rename here does not rename anything out there: it turns a band
 * a merchant placed into a band `parseSection` returns null for, and a band that
 * cannot be parsed is DROPPED from a page a shopper is looking at.
 *
 * The registry's own comment has said this since it was five section types
 * long -- "renaming one does not rename it there, it makes that shop's section
 * unparseable" -- and it has been enforced by nothing but whoever read the
 * comment. Once themes are authored outside this repository, the same edit
 * breaks other people's products at the same time, and they will not have read
 * the comment.
 *
 * ## The rule, in one line
 *
 * LOOSEN FREELY, TIGHTEN NEVER. Every check below is one direction of one
 * ratchet: the vocabulary may gain and may widen, and may never lose or narrow.
 *
 * ## What this is NOT
 *
 * Not a check that the registry is unchanged. A snapshot that fails on every
 * addition is a snapshot people regenerate without reading, which is worse than
 * none: it trains the reflex that the fix for a red test is `--write`. This one
 * is silent about additions and loud about exactly nine kinds of loss.
 *
 * The one place that reflex is still possible is `scripts/snapshot.ts`, which is
 * why the failure message names the edit to make rather than the command to run.
 */

export interface PinnedField {
  kind: string;
  /** Present when the field bounds its value. A `max` may rise and never fall. */
  max?: number;
  /** A `min` may fall and never rise, which is the same ratchet the other way. */
  min?: number;
  /** Present on `select` only. A choice may be added and never taken away. */
  choices?: string[];
}

export interface PinnedSection {
  pages: string[];
  settings: Record<string, PinnedField>;
  blocks?: { type: string; max: number; settings: Record<string, PinnedField> };
}

export interface SchemaSnapshot {
  /** Bumped only if the SHAPE of this file changes, never when the registry does. */
  snapshotVersion: number;
  maxHeading: number;
  maxBody: number;
  maxSectionsPerPage: number;
  pageTypes: string[];
  fieldKinds: string[];
  sections: Record<string, PinnedSection>;
}

export const SNAPSHOT_VERSION = 1;

function pinField(field: FieldView): PinnedField {
  return {
    kind: field.kind,
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.min === undefined ? {} : { min: field.min }),
    /*
     * Values only, never labels. A label is what a merchant reads in the editor
     * and is free to be rewritten in any release; the value is what is stored in
     * a shop's layout and is not.
     */
    ...(field.choices === undefined
      ? {}
      : { choices: field.choices.map((choice) => choice.value) }),
  };
}

function pinFields(fields: readonly FieldView[]): Record<string, PinnedField> {
  return Object.fromEntries(fields.map((field) => [field.name, pinField(field)]));
}

/**
 * The registry's public shape, right now.
 *
 * Built from `sectionDefinitionViews()` rather than from `SECTION_DEFINITIONS`
 * for one reason: the view is what actually crosses a boundary. It is what the
 * admin draws its controls from, what `/api/v1/section-definitions` serves, and
 * what a third-party tool will read. `presets` are already folded into it as a
 * `select` named `preset`, and `needs`, `jsonLd`, `requires` and `neverGenerated`
 * are deliberately absent -- those are behaviour, and behaviour is allowed to
 * change.
 */
export function currentShape(): SchemaSnapshot {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    maxHeading: MAX_HEADING,
    maxBody: MAX_BODY,
    maxSectionsPerPage: MAX_SECTIONS_PER_PAGE,
    pageTypes: [...PAGE_TYPES],
    fieldKinds: [...FIELD_KINDS],
    sections: Object.fromEntries(
      sectionDefinitionViews().map((section) => [
        section.type,
        {
          // Sorted, because `pages` is a set and a reordering is not a change.
          // Settings keep their declared order, because the editor draws them
          // in it, but the comparison below is by name and ignores order too.
          pages: [...section.pages].sort(),
          settings: pinFields(section.settings),
          ...(section.blocks === undefined
            ? {}
            : {
                blocks: {
                  type: section.blocks.type,
                  max: section.blocks.max,
                  settings: pinFields(section.blocks.settings),
                },
              }),
        },
      ]),
    ),
  };
}

export interface CompatibilityBreak {
  /** Dotted path to what was lost, so the message reads as an address. */
  at: string;
  /** What the promise was, in the words somebody has to act on. */
  says: string;
}

const widened = (was: number | undefined, now: number | undefined): boolean =>
  was === undefined || (now !== undefined && now >= was);

const relaxed = (was: number | undefined, now: number | undefined): boolean =>
  was === undefined || (now !== undefined && now <= was);

function fieldBreaks(
  where: string,
  pinned: Record<string, PinnedField>,
  current: Record<string, PinnedField>,
): CompatibilityBreak[] {
  const breaks: CompatibilityBreak[] = [];

  for (const [name, was] of Object.entries(pinned)) {
    const now = current[name];

    if (!now) {
      breaks.push({
        at: `${where}.${name}`,
        says: 'A setting is never removed. Every stored value for it is still in shops and in theme files; put the field back. Every setting is optional, so an unused one costs nothing.',
      });
      continue;
    }

    if (now.kind !== was.kind) {
      breaks.push({
        at: `${where}.${name}.kind`,
        says: `A setting's kind never changes (${was.kind} became ${now.kind}). Every value stored under the old kind fails the new parser, and a setting that fails takes its whole band off the page. Add a new setting instead.`,
      });
    }

    if (!widened(was.max, now.max)) {
      breaks.push({
        at: `${where}.${name}.max`,
        says: `A bound only ever rises (${String(was.max)} became ${String(now.max)}). Loosen freely, tighten never: shops that used the room would lose the setting, and with it the band.`,
      });
    }

    if (!relaxed(was.min, now.min)) {
      breaks.push({
        at: `${where}.${name}.min`,
        says: `A minimum only ever falls (${String(was.min)} became ${String(now.min)}). Raising one invalidates values already stored below it.`,
      });
    }

    if (was.choices) {
      const has = new Set(now.choices ?? []);
      for (const choice of was.choices) {
        if (!has.has(choice)) {
          breaks.push({
            at: `${where}.${name}.choices.${choice}`,
            says: `A choice is never withdrawn. A shop that picked "${choice}" falls back to the default -- silently, because an unreadable select is caught rather than dropped -- so the band quietly changes shape on deploy.`,
          });
        }
      }
    }
  }

  return breaks;
}

/**
 * Everything the current registry takes away from what was promised.
 *
 * Empty is the passing answer. Nothing here objects to an addition: a new
 * section, a new setting, a new choice, a raised bound and a new page on a
 * section's allow-list all return nothing at all.
 */
export function compatibilityBreaks(
  pinned: SchemaSnapshot,
  current: SchemaSnapshot = currentShape(),
): CompatibilityBreak[] {
  const breaks: CompatibilityBreak[] = [];

  if (!widened(pinned.maxHeading, current.maxHeading)) {
    breaks.push({
      at: 'MAX_HEADING',
      says: `A bound only ever rises (${pinned.maxHeading} became ${current.maxHeading}).`,
    });
  }
  if (!widened(pinned.maxBody, current.maxBody)) {
    breaks.push({
      at: 'MAX_BODY',
      says: `A bound only ever rises (${pinned.maxBody} became ${current.maxBody}).`,
    });
  }
  if (!widened(pinned.maxSectionsPerPage, current.maxSectionsPerPage)) {
    breaks.push({
      at: 'MAX_SECTIONS_PER_PAGE',
      says: `A page's capacity only ever rises (${pinned.maxSectionsPerPage} became ${current.maxSectionsPerPage}). Lowering it truncates pages merchants have already built.`,
    });
  }

  for (const page of pinned.pageTypes) {
    if (!current.pageTypes.includes(page)) {
      breaks.push({
        at: `PAGE_TYPES.${page}`,
        says: `A page type is never removed. Every layout keyed by "${page}" becomes unreadable, and a template nothing reads is a template silently discarded on the merchant's next save.`,
      });
    }
  }

  for (const kind of pinned.fieldKinds) {
    if (!current.fieldKinds.includes(kind)) {
      breaks.push({
        at: `FIELD_KINDS.${kind}`,
        says: `A field kind is never removed. Every setting declared with "${kind}" loses its parser, and a setting that cannot parse takes its band off the page.`,
      });
    }
  }

  for (const [type, was] of Object.entries(pinned.sections)) {
    const now = current.sections[type];

    if (!now) {
      breaks.push({
        at: `sections.${type}`,
        says: `A section type is never renamed or removed. It is stored by name in the layout column of every shop that placed one, and renaming it here does not rename it there -- it makes that band unparseable, so it disappears from a live page.`,
      });
      continue;
    }

    for (const page of was.pages) {
      if (!now.pages.includes(page)) {
        breaks.push({
          at: `sections.${type}.pages.${page}`,
          says: `A section never loses a page it was allowed on. "${type}" bands already sit on ${page} pages, and both the parser and theme import consult this list -- so removing it deletes those bands and rejects theme files that were valid when they were written.`,
        });
      }
    }

    breaks.push(...fieldBreaks(`sections.${type}.settings`, was.settings, now.settings));

    if (was.blocks) {
      if (!now.blocks) {
        breaks.push({
          at: `sections.${type}.blocks`,
          says: 'A section never stops taking blocks. Every block a merchant placed inside it would be stripped on the next save.',
        });
      } else {
        if (now.blocks.type !== was.blocks.type) {
          breaks.push({
            at: `sections.${type}.blocks.type`,
            says: `A block type is never renamed (${was.blocks.type} became ${now.blocks.type}). Stored blocks carry the old name and stop parsing.`,
          });
        }
        if (!widened(was.blocks.max, now.blocks.max)) {
          breaks.push({
            at: `sections.${type}.blocks.max`,
            says: `A block count only ever rises (${was.blocks.max} became ${now.blocks.max}). Over the maximum the tail is dropped, so a merchant loses the questions they wrote at the bottom of a band.`,
          });
        }
        breaks.push(
          ...fieldBreaks(
            `sections.${type}.blocks.settings`,
            was.blocks.settings,
            now.blocks.settings,
          ),
        );
      }
    }
  }

  return breaks;
}
