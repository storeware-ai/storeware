import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compatibilityBreaks, currentShape, type SchemaSnapshot } from './compatibility';
import { SECTION_DEFINITIONS, parseSection, type SectionDefinition } from './sections';

/**
 * The promise, checked on every run.
 *
 * `schema.snapshot.json` is a committed file rather than a vitest snapshot, and
 * the distinction is the whole point. An inline snapshot invites `vitest -u`;
 * the fix for a failure here is never to update the file, it is to put back
 * whatever was taken away. A committed file also puts the diff in the pull
 * request where a person reads it, which is the same argument
 * `registry.test.ts` makes about the merchant tool order.
 *
 * The mutation tests below are the ones that matter. A ratchet nobody has seen
 * fail is a ratchet that might be comparing nothing, and this one is the only
 * thing standing between a rename and every themed shop losing a band.
 */

const pinned = JSON.parse(
  readFileSync(new URL('../schema.snapshot.json', import.meta.url), 'utf8'),
) as SchemaSnapshot;

/** A deep copy, so a mutation test cannot leak into the next one. */
const copy = (): SchemaSnapshot => JSON.parse(JSON.stringify(pinned)) as SchemaSnapshot;

describe('the schema keeps what it promised', () => {
  it('found the snapshot, so a missing file cannot pass by comparing nothing', () => {
    expect(Object.keys(pinned.sections).length).toBeGreaterThan(40);
    expect(pinned.pageTypes.length).toBeGreaterThan(0);
    expect(pinned.fieldKinds.length).toBeGreaterThan(0);
  });

  it('takes nothing away', () => {
    const breaks = compatibilityBreaks(pinned);

    expect(
      breaks.map((one) => `${one.at}: ${one.says}`),
      'the theme schema has removed or narrowed something a stored layout depends on',
    ).toEqual([]);
  });

  /*
   * The snapshot is allowed to lag behind an addition -- the ratchet is silent
   * about widening on purpose -- but not for long. `pnpm --filter
   * @storeware/theme-schema snapshot` regenerates it, and CI runs
   * `snapshot:check`, which is where a forgotten regeneration is caught.
   */
  it('has a snapshot that is still current', () => {
    const serialised = `${JSON.stringify(currentShape(), null, 2)}\n`;
    const onDisk = readFileSync(new URL('../schema.snapshot.json', import.meta.url), 'utf8');

    expect(
      onDisk === serialised,
      'the schema has widened; run: pnpm --filter @storeware/theme-schema snapshot',
    ).toBe(true);
  });
});

describe('the ratchet catches a loss', () => {
  it('a renamed or removed section type', () => {
    const was = copy();
    was.sections['a_band_that_shipped'] = { pages: ['home'], settings: {} };

    const breaks = compatibilityBreaks(was);
    expect(breaks.map((one) => one.at)).toContain('sections.a_band_that_shipped');
    expect(breaks[0]?.says).toContain('never renamed or removed');
  });

  it('a removed setting', () => {
    const was = copy();
    was.sections['hero']!.settings['a_setting_that_shipped'] = { kind: 'text', max: 120 };

    expect(compatibilityBreaks(was).map((one) => one.at)).toContain(
      'sections.hero.settings.a_setting_that_shipped',
    );
  });

  it('a setting whose kind changed under it', () => {
    const was = copy();
    was.sections['hero']!.settings['heading'] = { kind: 'number' };

    const breaks = compatibilityBreaks(was);
    expect(breaks.map((one) => one.at)).toContain('sections.hero.settings.heading.kind');
  });

  it('a lowered bound on a setting', () => {
    const was = copy();
    was.sections['hero']!.settings['heading'] = { kind: 'text', max: 100_000 };

    expect(compatibilityBreaks(was).map((one) => one.at)).toContain(
      'sections.hero.settings.heading.max',
    );
  });

  it('a raised minimum on a setting', () => {
    const was = copy();
    const products = was.sections['products']!.settings['limit']!;
    was.sections['products']!.settings['limit'] = { ...products, min: -1 };

    expect(compatibilityBreaks(was).map((one) => one.at)).toContain(
      'sections.products.settings.limit.min',
    );
  });

  it('a withdrawn select choice', () => {
    const was = copy();
    const hero = was.sections['hero']!.settings['preset'];
    expect(hero?.choices, 'the hero should still offer presets').toBeDefined();
    was.sections['hero']!.settings['preset'] = {
      ...hero!,
      choices: [...hero!.choices!, 'a_preset_that_shipped'],
    };

    expect(compatibilityBreaks(was).map((one) => one.at)).toContain(
      'sections.hero.settings.preset.choices.a_preset_that_shipped',
    );
  });

  /*
   * The rule with no comment behind it, and the one worth stating loudest.
   *
   * `sectionAllowedOn` is consulted by `parseTemplate` on every render AND by
   * theme import, so taking a page off a section's list does two things at
   * once: it deletes those bands from live pages, and it rejects theme files
   * that were valid when an agency wrote them.
   */
  it('a page taken off a section allow-list', () => {
    const was = copy();
    was.sections['hero']!.pages = [...was.sections['hero']!.pages, 'a_page_that_shipped'];

    const breaks = compatibilityBreaks(was);
    expect(breaks.map((one) => one.at)).toContain('sections.hero.pages.a_page_that_shipped');
    expect(breaks[0]?.says).toContain('theme import');
  });

  it('a lowered block maximum', () => {
    const was = copy();
    const faq = was.sections['faq']!.blocks!;
    was.sections['faq']!.blocks = { ...faq, max: faq.max + 10 };

    expect(compatibilityBreaks(was).map((one) => one.at)).toContain('sections.faq.blocks.max');
  });

  it('a section that stopped taking blocks', () => {
    const was = copy();
    was.sections['intro']!.blocks = { type: 'panel', max: 3, settings: {} };

    expect(compatibilityBreaks(was).map((one) => one.at)).toContain('sections.intro.blocks');
  });

  it('a removed page type and a removed field kind', () => {
    const was = copy();
    was.pageTypes = [...was.pageTypes, 'a_page_that_shipped'];
    was.fieldKinds = [...was.fieldKinds, 'a_kind_that_shipped'];

    const at = compatibilityBreaks(was).map((one) => one.at);
    expect(at).toContain('PAGE_TYPES.a_page_that_shipped');
    expect(at).toContain('FIELD_KINDS.a_kind_that_shipped');
  });

  it('a lowered global bound', () => {
    const was = copy();
    was.maxHeading = 1_000;
    was.maxBody = 1_000_000;
    was.maxSectionsPerPage = 40;

    const at = compatibilityBreaks(was).map((one) => one.at);
    expect(at).toContain('MAX_HEADING');
    expect(at).toContain('MAX_BODY');
    expect(at).toContain('MAX_SECTIONS_PER_PAGE');
  });
});

describe('the ratchet is silent about widening', () => {
  it('says nothing about a new section, setting, choice or page', () => {
    const was = copy();

    // Everything a release is allowed to do, done at once against the pin.
    delete was.sections['marquee'];
    delete was.sections['hero']!.settings['kicker'];
    was.sections['hero']!.pages = ['home'];
    was.sections['hero']!.settings['heading'] = { kind: 'text', max: 10 };
    was.maxSectionsPerPage = 2;
    was.pageTypes = ['home'];
    was.fieldKinds = ['text'];

    expect(compatibilityBreaks(was)).toEqual([]);
  });
});

/**
 * The parsers keep what they do not know.
 *
 * A parser that strips unknown settings looks identical from the outside until
 * an older deploy reads a layout a newer one wrote and hands it back shorter --
 * silently deleting settings on the merchant's next save.
 *
 * Asserted by parsing, where it used to be asserted by finding `.passthrough()`
 * and `.catch(undefined)` in the source text. The text is a means, and zod 4
 * spells the same promise `z.looseObject`, so a source check would fail a
 * faithful rewrite and pass a broken one. What the merchant depends on is that
 * the key comes back, and that is what is checked.
 */
describe('the parsers stay open', () => {
  // Widened from the registry's literal types, so a search can ask about `blocks`.
  const definitions: readonly SectionDefinition[] = SECTION_DEFINITIONS;
  const withBlocks = definitions.find((definition) => definition.blocks)!;
  const withSelect = definitions.find((definition) =>
    definition.settings.some((setting) => setting.kind === 'select'),
  )!;

  it('keeps a setting it does not know, on a band and on a block', () => {
    const read = parseSection({
      type: withBlocks.type,
      id: 'band01',
      settingFromTheFuture: 'kept',
      blocks: [{ type: withBlocks.blocks!.type, id: 'block01', blockSettingFromTheFuture: 'kept' }],
    });

    expect(read).toMatchObject({ settingFromTheFuture: 'kept' });
    expect(read?.blocks?.[0]).toMatchObject({ blockSettingFromTheFuture: 'kept' });
  });

  it('catches an unreadable choice rather than dropping the band', () => {
    // Scoped to `select` on purpose: a media id or a URL that does not parse is
    // not decoration and still drops its band.
    const select = withSelect.settings.find((setting) => setting.kind === 'select')!;
    const read = parseSection({
      type: withSelect.type,
      id: 'band01',
      [select.name]: 'no-such-choice',
    });

    expect(read).not.toBeNull();
    expect(read?.[select.name as keyof typeof read]).toBeUndefined();
  });
});
