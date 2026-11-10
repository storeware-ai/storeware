import { describe, expect, it } from 'vitest';
import { PRESETS, isMarquee, presetAttributes } from './presets';
import { SECTION_DEFINITIONS, sectionDefinition } from './sections';

/**
 * The registry and the preset table, held to each other.
 *
 * Two lists that have to agree and that fail differently when they do not. A
 * preset a band offers with no entry here reports a change and moves nothing --
 * the studio says it did the thing, the preview does not budge, and the
 * merchant concludes the feature is broken. An entry here that no band offers
 * is CSS nobody can reach, which is harmless and is still a line somebody will
 * later maintain for no reason.
 */

const OFFERED = SECTION_DEFINITIONS.filter(
  (section): section is (typeof SECTION_DEFINITIONS)[number] & { presets: { value: string }[] } =>
    'presets' in section && Array.isArray(section.presets),
);

describe('what a band offers and what the platform draws', () => {
  it('has axes for every preset a band offers', () => {
    const missing: string[] = [];

    for (const section of OFFERED) {
      for (const choice of section.presets) {
        if (!(choice.value in (PRESETS[section.type] ?? {}))) {
          missing.push(`${section.type}.${choice.value}`);
        }
      }
    }

    expect(missing, 'offered by a band and drawn by nothing').toEqual([]);
  });

  it('draws nothing a band does not offer', () => {
    const orphans: string[] = [];

    for (const [type, presets] of Object.entries(PRESETS)) {
      const offered = OFFERED.find((section) => section.type === type);
      for (const name of Object.keys(presets)) {
        if (!offered?.presets.some((choice) => choice.value === name)) {
          orphans.push(`${type}.${name}`);
        }
      }
    }

    expect(orphans, 'drawn by the platform and offered by nobody').toEqual([]);
  });

  /*
   * The promise that makes this shippable without touching a single shop.
   *
   * The first choice is the default, it maps to null, and null emits no
   * attribute -- so a band nobody has re-presetted renders the element it has
   * always rendered, with the classes it has always had, and nothing else.
   */
  it('makes the first choice of every band the one that changes nothing', () => {
    for (const section of OFFERED) {
      const first = section.presets[0]!.value;

      expect(PRESETS[section.type]?.[first], `${section.type}.${first}`).toBeNull();
      expect(presetAttributes(section.type, first)).toEqual({});
    }
  });

  it('makes that first choice the fallback the parser applies', () => {
    for (const section of OFFERED) {
      const preset = sectionDefinition(section.type)!.settings.find(
        (setting) => setting.name === 'preset',
      );

      expect(preset, section.type).toBeDefined();
      expect(preset!.kind).toBe('select');
      expect(preset!.fallback).toBe(section.presets[0]!.value);
    }
  });
});

describe('what reaches the markup', () => {
  it('names both axes for a preset that has them', () => {
    expect(presetAttributes('logo_list', 'marquee')).toEqual({
      'data-sw-layout': 'marquee',
      'data-sw-emphasis': 'media',
    });
  });

  /*
   * A layout written by a later release, or a theme file from a shop one
   * version ahead. The band renders in its default look rather than
   * disappearing, which is the same trade `field.select`'s `.catch` makes one
   * file over.
   */
  it('says nothing about a preset this build has never heard of', () => {
    expect(presetAttributes('hero', 'holographic')).toEqual({});
    expect(presetAttributes('note', 'anything')).toEqual({});
    expect(presetAttributes('hero', undefined)).toEqual({});
  });

  it('knows which presets want the duplicated track', () => {
    expect(isMarquee('logo_list', 'marquee')).toBe(true);
    expect(isMarquee('logo_list', 'grid')).toBe(false);
    expect(isMarquee('hero', 'split')).toBe(false);
  });
});

describe('the model is offered every band its presets, not the first band twice', () => {
  /*
   * The bug this pins was real and quiet. `blueprintSectionFields` deduped by
   * name and kept the first definition, so ten bands declaring `preset` handed
   * the model the hero's four values -- and a model picking `image_scrim` for a
   * gallery spent a turn on a layout the parser then refused.
   */
  it('answers the union of the choices across bands', async () => {
    const { blueprintSectionFields } = await import('./sections');
    const fields = blueprintSectionFields(
      { media: true, product: true, collection: true, blog: true },
      'home',
    );

    const preset = fields.find((setting) => setting.name === 'preset');
    const values = (preset?.choices ?? []).map((choice) => choice.value);

    // One only the hero offers, one only a gallery and a products band offer,
    // one only an image-with-text offers. First-wins answers the hero's list
    // and none of the rest.
    expect(values).toContain('image_scrim');
    expect(values).toContain('mosaic');
    expect(values).toContain('overlap');
  });

  /*
   * And the other half of the same rule, which the first version of the test
   * above got wrong. `logo_list` and `testimonials` are `neverGenerated`, so
   * their presets must NOT reach the model however the merging works -- a
   * marquee of fabricated testimonials is the failure that flag exists for, and
   * widening the union must not be the way round it.
   */
  it('still offers nothing from a band the generator may not place', async () => {
    const { blueprintSectionFields } = await import('./sections');
    const fields = blueprintSectionFields(
      { media: true, product: true, collection: true, blog: true },
      'home',
    );

    const values = (fields.find((setting) => setting.name === 'preset')?.choices ?? []).map(
      (choice) => choice.value,
    );

    // Offered only by `logo_list` and `testimonials`, both never generated.
    expect(values).not.toContain('marquee');
  });
});
