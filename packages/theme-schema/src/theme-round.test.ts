import { describe, expect, it } from 'vitest';
import { PRESETS, presetAttributes } from './presets';
import { SCHEME_IDS, schemeAttributes } from './schemes';
import {
  blueprintBlockFields,
  blueprintSectionFields,
  blueprintSectionTypes,
  dataPlanFor,
  generatableChoices,
  parseSection,
  sectionDefinition,
  sectionDefinitionViews,
  type LayoutSection,
} from './sections';

/**
 * The vocabulary the twelve signed-off themes need (phase C2), held to the
 * two promises that let it land without touching a shop or a generated look.
 *
 * Add-only, which `compatibility.test.ts` holds for the whole registry. And
 * offered to the editor at once but to no generator: a new band is never
 * generated, a new setting is not generatable, and a new look on a band the
 * model already fills is a choice the model is not shown. A look the model
 * was never told about is a look it picks blind, onto a live shop.
 */

const EVERYTHING = { media: true, product: true, collection: true, blog: true };
const NEW_BANDS = ['lookbook', 'collage', 'split_screen', 'collection_tabs'];

describe('the bands the themes draw', () => {
  it('are in the registry and never generated', () => {
    for (const type of NEW_BANDS) {
      expect(sectionDefinition(type), type).toBeDefined();
      expect(blueprintSectionTypes(EVERYTHING, 'home')).not.toContain(type);
    }
  });

  it('parse with their blocks', () => {
    const band = parseSection({
      type: 'lookbook',
      id: 'look01',
      heading: 'After dark',
      image: '6f1c2b52-8a3f-4d6e-9b1a-2c3d4e5f6a7b',
      blocks: [
        { type: 'spot', id: 'spot01', product: 'wool-coat', x: 49, y: 54 },
        { type: 'spot', id: 'spot02', product: 'scarf', x: 140, y: 20 },
      ],
    });

    // A spot past the edge of the picture is one spot lost, not the band.
    expect(band?.blocks).toEqual([
      { type: 'spot', id: 'spot01', product: 'wool-coat', x: 49, y: 54 },
    ]);
  });

  it('ask for the products a lookbook pins, once each', () => {
    const plan = dataPlanFor([
      {
        type: 'lookbook',
        blocks: [
          { type: 'spot', product: 'wool-coat' },
          { type: 'spot', product: 'scarf' },
          { type: 'spot' },
        ],
      },
      { type: 'featured_product', product: 'scarf' },
    ]);

    expect(plan.productHandles.sort()).toEqual(['scarf', 'wool-coat']);
  });

  it('ask for each tab’s collection at the band’s depth, and the titles', () => {
    const plan = dataPlanFor([
      { type: 'collection_tabs', first: 'tableware', third: 'linen', limit: 6 },
    ] satisfies LayoutSection[]);

    expect(plan.collections).toBe(true);
    expect(plan.collectionHandles).toEqual([
      { handle: 'tableware', limit: 6 },
      { handle: 'linen', limit: 6 },
    ]);
  });
});

describe('a look the editor offers and the model is not shown', () => {
  const HELD = {
    products: ['carousel', 'marquee', 'menu', 'stack'],
    collection_products: ['bento', 'menu', 'stack'],
    image_with_text: ['masked'],
  };

  it('is a preset the platform draws and the editor lists', () => {
    const views = new Map(sectionDefinitionViews().map((view) => [view.type, view]));
    for (const [type, values] of Object.entries(HELD)) {
      const offered = views
        .get(type)!
        .settings.find((setting) => setting.name === 'preset')!
        .choices!.map((choice) => choice.value);
      for (const value of values) {
        expect(offered, `${type}.${value}`).toContain(value);
        expect(PRESETS[type]?.[value], `${type}.${value}`).toBeTruthy();
      }
    }
  });

  it('reaches no generator', () => {
    const preset = blueprintSectionFields(EVERYTHING, 'home').find(
      (setting) => setting.name === 'preset',
    )!;
    const values = preset.choices!.map((choice) => choice.value);

    // `marquee` too: offered before this only by two bands the generator may
    // never place, and now by the product grid, which it may.
    for (const value of ['carousel', 'menu', 'masked', 'scatter', 'marquee']) {
      expect(values).not.toContain(value);
    }
    // And the schema the union is checked by agrees with the list it shows.
    expect(preset.schema.parse('carousel')).toBeUndefined();
    expect(preset.schema.parse('mosaic')).toBe('mosaic');
  });

  it('is narrowed one band at a time too', () => {
    const products = sectionDefinition('products')!.settings.find(
      (setting) => setting.name === 'preset',
    )!;
    const narrowed = generatableChoices(products);

    expect(narrowed.choices!.map((choice) => choice.value)).toEqual([
      'grid',
      'rail',
      'mosaic',
      'list',
      'bento',
      'index',
      'offset',
    ]);
    // A field with nothing held is handed back as it was.
    const align = sectionDefinition('hero')!.settings.find((setting) => setting.name === 'align')!;
    expect(generatableChoices(align)).toBe(align);
  });

  it('draws the band it promises', () => {
    expect(presetAttributes('products', 'carousel')).toEqual({
      'data-sw-layout': 'carousel',
      'data-sw-emphasis': 'media',
    });
    expect(presetAttributes('collage', 'scatter')).toEqual({});
    expect(presetAttributes('collage', 'strip')).toEqual({
      'data-sw-layout': 'strip',
      'data-sw-emphasis': 'media',
    });
  });
});

describe('a setting added for the themes', () => {
  it('is held back from the generators', () => {
    const offered = new Set([
      ...blueprintSectionFields(EVERYTHING, 'home').map((setting) => setting.name),
      ...blueprintBlockFields(EVERYTHING, 'home').map((setting) => setting.name),
    ]);

    for (const name of ['fit', 'shape', 'side', 'x', 'y', 'caption', 'scheme']) {
      expect(offered, name).not.toContain(name);
    }
  });

  it('sits on the bands the plan names', () => {
    const has = (type: string, name: string) =>
      sectionDefinition(type)!.settings.some((setting) => setting.name === name);

    for (const type of ['hero', 'manifesto']) expect(has(type, 'fit'), type).toBe(true);
    for (const type of ['image_with_text', 'gallery']) expect(has(type, 'shape'), type).toBe(true);
    for (const type of [
      'products',
      'collection_products',
      'collections',
      'collection_list',
      'gallery',
      'marquee',
    ]) {
      expect(has(type, 'scheme'), type).toBe(true);
    }
  });

  it('includes the second accent as a ground', () => {
    expect(SCHEME_IDS).toContain('accent2');
    expect(schemeAttributes('accent2')).toEqual({ 'data-sw-scheme': 'accent2' });
    expect(parseSection({ type: 'note', scheme: 'accent2' })?.scheme).toBe('accent2');
  });

  it('falls back to the plain picture for a shape this release does not know', () => {
    expect(parseSection({ type: 'gallery', shape: 'hexagon' })?.shape).toBeUndefined();
    expect(parseSection({ type: 'gallery', shape: 'arch' })?.shape).toBe('arch');
  });
});
