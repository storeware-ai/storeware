import { isSafeHref } from './href';
import {
  MAX_SECTIONS_PER_PAGE,
  PAGE_TYPES,
  sectionAllowedOn,
  sectionDefinition,
  type PageType,
} from './sections';

/**
 * Reading a theme somebody else wrote, strictly.
 *
 * ## Why the ordinary parser is not this
 *
 * `parseSection` is deliberately FORGIVING. Its parsers are `.passthrough()`,
 * an unreadable `select` falls back rather than dropping a band, and an
 * unrecognised section is skipped so the rest of a page survives. Every one of
 * those choices is right for the job it does, which is reading a layout a
 * merchant already owns, possibly written by a newer release than the one
 * reading it. Being strict there would mean a deploy losing a merchant's bands.
 *
 * None of it is right for ACCEPTING a file from somebody else. A forgiving
 * parser answers "what can I still draw", and the question here is "is this
 * whole thing something I am willing to put on a merchant's shop". Those have
 * different right answers, and the gap between them is not small: an undeclared
 * setting sails through `parseSection` entirely unvalidated. That is not
 * theoretical. The test for the link predicate in `href.test.ts` was first
 * written with the wrong field name and passed `javascript:alert(1)` straight
 * through, which is the hole demonstrating itself.
 *
 * ## Why this lives in the published package
 *
 * So an author checks the same rules the platform enforces, offline, before
 * listing anything. A copy of these rules in a tool would be wrong within a
 * release, and being wrong in the direction of "your valid theme is invalid" is
 * the more annoying failure while being wrong the other way is the dangerous
 * one. It is also genuinely useful to anybody else building on this format:
 * accepting a document written by a stranger is a problem the format creates
 * and should therefore answer.
 *
 * ## What it does NOT do
 *
 * It does not judge taste, and it does not read words. Whether a heading makes
 * a promise the merchant never made is not decidable here, and pretending
 * otherwise would put a machine's name on a judgement it did not make.
 */

export interface ThemeProblem {
  /** A dotted path into the file, so a message reads as an address. */
  at: string;
  /** What is wrong, in words the person who wrote the file can act on. */
  says: string;
}

/**
 * Bands a theme from somebody else may never carry, and why each is refused.
 *
 * ## `plugin_block` is the one that matters
 *
 * It is the only band in the vocabulary whose content is fetched at render from
 * a third party and injected as markup. The entire argument separating a theme
 * from a plugin is that an install is a COPY: uninstall does nothing, a
 * withdrawn listing does nothing, an author disappearing does nothing, and a
 * plugin cannot promise that because its blocks are live. A theme carrying a
 * `plugin_block` smuggles the plugin failure mode in through the vocabulary,
 * and the empty-handle case is worse than the named one: a `plugin_block` with
 * no handle renders EVERY installed app's markup, wherever the author put it.
 *
 * ## The rest are the platform refusing to accept what it refuses to generate
 *
 * Eight bands carry `neverGenerated`, and reading its declaration shows the
 * flag is not about difficulty. It says a band cannot be filled TRUTHFULLY by
 * somebody who does not know the shop: fabricated praise is a fake review
 * whoever typed it, a logo list asserts a relationship with a named third
 * party, a countdown counts to a date somebody invented. The platform will not
 * let its own model produce those about a shop it does not know.
 *
 * A theme author does not know the shop either. Allowing a listing to ship the
 * exact bands the generator is forbidden from producing would mean the rule is
 * about which of our systems is speaking rather than about the merchant, and
 * the merchant is the one whose name is on the page.
 *
 * Derived from the registry rather than listed, so a band added later joins on
 * its own declaration and nobody has to remember this exists. `plugin_block` is
 * named explicitly because its reason is different in kind.
 */
export const REFUSED_IN_A_LISTING = 'plugin_block';

/**
 * Every band whose content an app supplies when the page is drawn, refused
 * for the reason `plugin_block` is. `app_block` names one app and one of its
 * sections; it is just as live a link into somebody else's server.
 */
export const APP_BANDS: readonly string[] = [REFUSED_IN_A_LISTING, 'app_block'];

/** Whether a value looks like a media id, which a listing may never carry raw. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StrictOptions {
  /**
   * Whether a `media` setting's value names something the file carries.
   *
   * Supplied by the caller rather than decided here, because what a valid
   * picture reference looks like is a property of the FILE FORMAT and this
   * module reads a template. Absent means no picture may be referenced at all,
   * which is the right default for a caller that has not thought about it.
   */
  readonly resolvesPicture?: (value: string) => boolean;
  /**
   * Whether bands the platform refuses to generate are refused here too.
   *
   * True for a listing written by somebody who does not know the shop. False
   * for a merchant's own export of their own shop, where a testimonial is a
   * real customer's words and a logo list is a relationship they actually have.
   * The distinction is who wrote the words, and only the caller knows.
   */
  readonly thirdParty?: boolean;
}

/**
 * Whether a picture reference is one this file can honour.
 *
 * A raw uuid is refused with a different sentence from a name that resolves to
 * nothing, because they are different mistakes: the first is a theme exported
 * from a shop and listed without its pictures, and the second is a typo or a
 * picture the author forgot to attach.
 */
function pictureProblems(
  value: unknown,
  at: string,
  what: 'band' | 'block',
  options: StrictOptions,
): ThemeProblem[] {
  if (typeof value !== 'string' || value.length === 0) {
    return [{ at, says: 'A picture is named by the theme it travels with.' }];
  }

  if (UUID.test(value)) {
    return [
      {
        at,
        says: 'That is a picture id from the shop this theme was exported from. It means nothing anywhere else, so the band would render with no picture. Carry the picture with the theme instead.',
      },
    ];
  }

  if (!options.resolvesPicture || !options.resolvesPicture(value)) {
    return [
      {
        at,
        says: `This ${what} asks for a picture called "${value}" and the theme does not carry one by that name.`,
      },
    ];
  }

  return [];
}

/**
 * One band, read strictly.
 *
 * Every problem is collected rather than thrown on the first, because the
 * person fixing a theme wants the whole list. A tool that reports one error per
 * run is a tool somebody runs twenty times.
 */
function strictSection(
  section: unknown,
  at: string,
  page: PageType,
  options: StrictOptions,
): ThemeProblem[] {
  const problems: ThemeProblem[] = [];

  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return [{ at, says: 'A band is an object with a `type` and its settings.' }];
  }

  const raw = section as Record<string, unknown>;
  const type = raw['type'];

  if (typeof type !== 'string') {
    return [{ at, says: 'A band says what kind it is in a `type` field.' }];
  }

  const definition = sectionDefinition(type);
  if (!definition) {
    return [
      {
        at: `${at}.type`,
        says: `There is no band called "${type}". A forgiving reader would drop it and draw the rest of the page; a listing is refused instead, because a theme missing a third of itself is not what the author meant to publish.`,
      },
    ];
  }

  if (APP_BANDS.includes(type)) {
    problems.push({
      at: `${at}.type`,
      says: "An app band cannot travel in a theme. Its content is fetched from a third party every time the page renders, so it would be a live link into somebody else's server rather than a copy the merchant owns.",
    });
  }

  /*
   * `else if`, because an app band also carries `neverGenerated` and reporting
   * both would give one field two refusals. The first reason is the specific
   * one and the second adds nothing to it; a list of problems is read by
   * somebody fixing them, and a repeated address teaches them to skim.
   */
  if (!APP_BANDS.includes(type) && options.thirdParty !== false && definition.neverGenerated) {
    problems.push({
      at: `${at}.type`,
      says: `A "${definition.label}" band cannot travel in a theme, because filling it truthfully needs a fact about the shop that the author of a theme does not have. The platform refuses to generate one for the same reason.`,
    });
  }

  if (!sectionAllowedOn(type, page)) {
    problems.push({
      at: `${at}.type`,
      says: `A "${definition.label}" band does not belong on a ${page} page.`,
    });
  }

  /*
   * The strictness this module exists for.
   *
   * `parseSection` hands an undeclared setting back untouched, so a value
   * nothing validates is stored in a merchant's layout forever. Nothing renders
   * one today, which is why this is a refusal rather than a vulnerability, but
   * "nothing renders it today" is a property of today's renderer and not of the
   * file. A listing is refused instead.
   */
  const declared = new Set<string>(['type', 'id', 'blocks']);
  for (const setting of definition.settings) declared.add(setting.name);

  for (const key of Object.keys(raw)) {
    if (declared.has(key)) continue;
    problems.push({
      at: `${at}.${key}`,
      says: `A "${definition.label}" band has no setting called "${key}". Nothing would read it, and nothing would check it either.`,
    });
  }

  for (const setting of definition.settings) {
    const value = raw[setting.name];
    if (value === undefined) continue;

    /*
     * A picture is judged on the file's terms, not the registry's.
     *
     * `field.media` declares `z.string().guid()`, because in a STORED layout a
     * picture is a media row's id. In a FILE it is the name of a picture the
     * file carries, and remapping the one to the other is what an import does.
     * Running the stored-shape schema over a file value would reject every
     * legitimate theme and accept only the foreign uuids this refuses.
     *
     * This is the one place the two shapes genuinely differ, which is why it is
     * the one exception rather than a general escape hatch.
     */
    if (setting.kind === 'media') {
      problems.push(...pictureProblems(value, `${at}.${setting.name}`, 'band', options));
      continue;
    }

    const parsed = setting.schema.safeParse(value);
    if (!parsed.success) {
      problems.push({
        at: `${at}.${setting.name}`,
        says: parsed.error.issues[0]?.message ?? 'That is not a value this setting accepts.',
      });
      continue;
    }

    if (setting.kind === 'url' && typeof value === 'string' && !isSafeHref(value)) {
      problems.push({
        at: `${at}.${setting.name}`,
        says: 'A link may be a path, an anchor, an https address or a mailto address, and nothing else.',
      });
    }
  }

  const blocks = raw['blocks'];
  if (blocks !== undefined) {
    if (!definition.blocks) {
      problems.push({
        at: `${at}.blocks`,
        says: `A "${definition.label}" band does not take blocks.`,
      });
    } else if (!Array.isArray(blocks)) {
      problems.push({ at: `${at}.blocks`, says: 'Blocks are a list.' });
    } else {
      if (blocks.length > definition.blocks.max) {
        problems.push({
          at: `${at}.blocks`,
          says: `A "${definition.label}" band holds at most ${definition.blocks.max} of these, and this one has ${blocks.length}. A forgiving reader drops the tail; a listing is refused, so the author decides which to lose rather than the parser.`,
        });
      }

      const blockDeclared = new Set<string>(['type', 'id']);
      for (const setting of definition.blocks.settings) blockDeclared.add(setting.name);

      blocks.forEach((block, index) => {
        const where = `${at}.blocks[${index}]`;
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
          problems.push({ at: where, says: 'A block is an object.' });
          return;
        }

        const row = block as Record<string, unknown>;
        for (const key of Object.keys(row)) {
          if (blockDeclared.has(key)) continue;
          problems.push({ at: `${where}.${key}`, says: `A block has no setting called "${key}".` });
        }

        for (const setting of definition.blocks!.settings) {
          const value = row[setting.name];
          if (value === undefined) continue;

          if (setting.kind === 'media') {
            problems.push(...pictureProblems(value, `${where}.${setting.name}`, 'block', options));
            continue;
          }

          const parsed = setting.schema.safeParse(value);
          if (!parsed.success) {
            problems.push({
              at: `${where}.${setting.name}`,
              says: parsed.error.issues[0]?.message ?? 'That is not a value this setting accepts.',
            });
            continue;
          }

          if (setting.kind === 'url' && typeof value === 'string' && !isSafeHref(value)) {
            problems.push({
              at: `${where}.${setting.name}`,
              says: 'A link may be a path, an anchor, an https address or a mailto address, and nothing else.',
            });
          }
        }
      });
    }
  }

  return problems;
}

/**
 * Every page of a theme, read strictly. Empty means it may be listed.
 *
 * Takes the templates as they sit in the file rather than a parsed layout,
 * because the whole point is to judge what was written rather than what
 * survived a forgiving read.
 */
export function strictTemplates(
  templates: Record<string, unknown>,
  options: StrictOptions = {},
): ThemeProblem[] {
  const problems: ThemeProblem[] = [];
  const pages = new Set<string>(PAGE_TYPES);

  for (const [page, value] of Object.entries(templates)) {
    if (!pages.has(page)) {
      problems.push({
        at: `templates.${page}`,
        says: `There is no page called "${page}". A template stored against one would be data nothing reads.`,
      });
      continue;
    }

    if (!Array.isArray(value)) {
      problems.push({ at: `templates.${page}`, says: 'A page is a list of bands.' });
      continue;
    }

    if (value.length > MAX_SECTIONS_PER_PAGE) {
      problems.push({
        at: `templates.${page}`,
        says: `A page holds at most ${MAX_SECTIONS_PER_PAGE} bands and this one has ${value.length}. Anything past the limit is dropped on import, so a listing is refused rather than published as a page the author never saw.`,
      });
    }

    value.forEach((section, index) => {
      problems.push(
        ...strictSection(section, `templates.${page}[${index}]`, page as PageType, options),
      );
    });
  }

  return problems;
}
