import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOME,
  MAX_BODY,
  MAX_HEADING,
  FIELD_KINDS,
  MAX_SECTIONS_PER_PAGE,
  PAGE_TYPES,
  SECTION_DEFINITIONS,
  SECTION_TYPES,
  dataPlanFor,
  defaultTemplateFor,
  parseSection,
  sectionAllowedOn,
  sectionDefinitionViews,
  sectionCarriesHeading,
  sectionsAvailableOn,
  templateCarriesHeading,
  type LayoutSection,
} from './sections';
import { sectionsFor, sectionsForRow } from './layout';

/**
 * The registry, and the parsing that hangs off it.
 *
 * Most of what is asserted here is not "does it work" but "does it fail the way
 * a shopper can live with". A layout column is merchant data that reaches a
 * page nobody is watching, so the interesting cases are all the malformed ones,
 * and the property being pinned is that none of them is worse than a missing
 * band.
 */

describe('the vocabulary', () => {
  it('keeps the five section types that shops already have stored', () => {
    // Not a list to update when a section is added. These five names are in the
    // `layout` column of every themed shop on the platform, and renaming one
    // does not rename it there: it makes that shop's section unparseable, which
    // presents as a band vanishing from a live storefront.
    expect(SECTION_TYPES).toEqual(
      expect.arrayContaining(['intro', 'assistant', 'products', 'collections', 'note']),
    );
  });

  it('derives its type list from the definitions rather than restating it', () => {
    expect([...SECTION_TYPES]).toEqual(SECTION_DEFINITIONS.map((section) => section.type));
  });

  it('gives every section merchant-facing copy', () => {
    // The editor renders this. A section with no words is a checkbox a merchant
    // cannot make a decision about.
    for (const section of SECTION_DEFINITIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.hint.length).toBeGreaterThan(0);
    }
  });

  it('places every section on at least one real page type', () => {
    for (const section of SECTION_DEFINITIONS) {
      expect(section.pages.length).toBeGreaterThan(0);
      for (const page of section.pages) expect(PAGE_TYPES).toContain(page);
    }
  });

  it('offers the home page everything the home page used to have', () => {
    const available = sectionsAvailableOn('home').map((section) => section.type);

    for (const section of DEFAULT_HOME) expect(available).toContain(section.type);
  });

  it('keeps the shop heading off pages that already have one', () => {
    // Two `h1`s naming the shop is a worse document than one, and a product
    // page's `h1` is the product.
    expect(sectionAllowedOn('intro', 'home')).toBe(true);
    expect(sectionAllowedOn('intro', 'product')).toBe(false);
  });

  it('does not recognise a section nothing builds', () => {
    expect(sectionAllowedOn('carousel_of_doom', 'home')).toBe(false);
  });
});

describe('the definitions as JSON', () => {
  const names = (type: string) =>
    sectionDefinitionViews()
      .find((view) => view.type === type)
      ?.settings.map((setting) => setting.name) ?? [];

  it('describes each section by the settings it actually accepts', () => {
    // This is what the admin draws its form from. If `products` stopped
    // reporting `limit`, the "how many to show" box would silently disappear.
    expect(names('products')).toContain('limit');
    expect(names('products')).not.toContain('body');
    expect(names('note')).toContain('body');
    expect(names('note')).not.toContain('limit');
  });

  it('gives every setting a kind the editor can draw a control for', () => {
    for (const view of sectionDefinitionViews()) {
      for (const setting of [...view.settings, ...(view.blocks?.settings ?? [])]) {
        expect(FIELD_KINDS, `${view.type}.${setting.name}`).toContain(setting.kind);
        expect(setting.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('offers choices for every select and for nothing else', () => {
    // A select with no choices is a dropdown with nothing in it, which the
    // editor would render as an unusable control rather than as an error.
    for (const view of sectionDefinitionViews()) {
      for (const setting of [...view.settings, ...(view.blocks?.settings ?? [])]) {
        expect(Array.isArray(setting.choices), `${view.type}.${setting.name}`).toBe(
          setting.kind === 'select',
        );
      }
    }
  });

  it('tells the editor the narrowest picture a hero spreads across the page', () => {
    // Advice rather than a bound: the fourth P8 contact sheet found generation
    // refusing a 320 pixel poster while a merchant could still upload one. The
    // editor warns from this, and generation reads the same number.
    const picture = (type: string) =>
      sectionDefinitionViews()
        .find((view) => view.type === type)
        ?.settings.find((setting) => setting.kind === 'media');

    expect(picture('hero')?.narrowest).toBe(512);
    expect(picture('image_with_text')?.narrowest).toBeUndefined();
  });

  it('describes the blocks a section takes', () => {
    const faq = sectionDefinitionViews().find((view) => view.type === 'faq');

    expect(faq?.blocks?.type).toBe('question');
    expect(faq?.blocks?.max).toBeGreaterThan(1);
    expect(faq?.blocks?.settings.map((setting) => setting.name)).toEqual(['question', 'answer']);
  });

  it('survives being serialised, because that is the only way it travels', () => {
    expect(() => JSON.stringify(sectionDefinitionViews())).not.toThrow();
    expect(JSON.parse(JSON.stringify(sectionDefinitionViews()))).toEqual(sectionDefinitionViews());
  });
});

describe('parsing one section', () => {
  it('accepts a bare section with no settings', () => {
    expect(parseSection({ type: 'intro' })).toEqual({ type: 'intro' });
  });

  it('keeps the settings a section declares', () => {
    expect(parseSection({ type: 'products', heading: 'New in', limit: 8 })).toEqual({
      type: 'products',
      heading: 'New in',
      limit: 8,
    });
  });

  it('carries through a setting it has no name for', () => {
    // Forward compatibility, and it is not decorative. The admin posts the whole
    // layout rather than a move instruction, so an older deploy that stripped
    // unknown settings would delete a newer deploy's work on the next save.
    expect(parseSection({ type: 'note', heading: 'Hi', alignment: 'centre' })).toMatchObject({
      alignment: 'centre',
    });
  });

  it.each([
    ['an unknown type', { type: 'liquid' }],
    ['no type at all', { heading: 'orphan' }],
    ['a non-string type', { type: 7 }],
    ['null', null],
    ['a string', 'products'],
    ['an array', []],
    ['a heading past the cap', { type: 'intro', heading: 'x'.repeat(MAX_HEADING + 1) }],
    ['a body past the cap', { type: 'note', body: 'x'.repeat(MAX_BODY + 1) }],
    ['a limit of zero', { type: 'products', limit: 0 }],
    ['a fractional limit', { type: 'products', limit: 2.5 }],
  ])('refuses %s', (_case, value) => {
    expect(parseSection(value)).toBeNull();
  });
});

describe('parsing blocks', () => {
  it('keeps the blocks a section declares', () => {
    const faq = parseSection({
      type: 'faq',
      heading: 'Questions',
      blocks: [
        { type: 'question', question: 'Do you ship abroad?', answer: 'Yes.' },
        { type: 'question', question: 'How long?', answer: 'Three days.' },
      ],
    });

    expect(faq?.blocks).toHaveLength(2);
    expect(faq?.blocks?.[0]).toMatchObject({ question: 'Do you ship abroad?' });
  });

  it('drops one unreadable block instead of the whole band', () => {
    // Same discipline as the section list. A merchant who wrote six questions
    // and whose fourth has a field a later release removed should lose that
    // question, not the band.
    const faq = parseSection({
      type: 'faq',
      blocks: [{ type: 'question', question: 'Kept' }, { type: 'slide' }, null, 'nonsense'],
    });

    expect(faq?.blocks).toHaveLength(1);
  });

  it('drops the tail past the section maximum rather than refusing the lot', () => {
    const gallery = parseSection({
      type: 'gallery',
      blocks: Array.from({ length: 30 }, () => ({ type: 'image', alt: 'A picture' })),
    });

    expect(gallery?.blocks).toHaveLength(12);
  });

  it('leaves blocks off a section that does not take them', () => {
    // Not merely ignored: absent, so a stored `blocks` key on a `note` cannot
    // reach a renderer that has no idea what to do with it.
    expect(parseSection({ type: 'note', blocks: [{ type: 'question' }] })).toEqual({
      type: 'note',
    });
  });

  it('leaves blocks off a section that declares them but has none', () => {
    expect(parseSection({ type: 'faq', heading: 'Questions' })).toEqual({
      type: 'faq',
      heading: 'Questions',
    });
  });
});

describe('resolving a page', () => {
  it('falls back to the three bands the home page always had', () => {
    expect(sectionsFor({}, 'home')).toEqual(DEFAULT_HOME);
  });

  it('gives most pages nothing, which means the built-in page', () => {
    // The safety of widening PAGE_TYPES in one go. A product page with no
    // template is the product page that shipped, so nothing about any shop
    // changes until a merchant places a section.
    //
    // The exceptions are the pages whose built-in content has BECOME a
    // template. For those, "nothing" would mean an empty page rather than the
    // page that shipped, so the default is the bands the route used to render
    // inline -- which is the same guarantee said a different way.
    //
    // And one deliberate change, made on 2026-09-29: a product page ends with
    // its related products unless the merchant arranged it otherwise. Pinned
    // here so it stays a decision rather than drift.
    const composed = ['home', 'article', 'collection', 'page', 'blog', 'product'];

    for (const page of PAGE_TYPES) {
      if (composed.includes(page)) continue;
      expect(sectionsFor({}, page)).toEqual([]);
    }
    expect(sectionsFor({}, 'product')).toEqual([{ type: 'related_products' }]);
  });

  /*
   * The compatibility promise for the category page, stated as a list.
   *
   * A collection page is the biggest organic surface most shops have, and it
   * became a template in order to let a merchant put a hero above the grid. The
   * cost of getting the default wrong is every category page on the platform
   * changing shape on deploy, so the order is pinned rather than described.
   */
  it('gives a category page the two bands its route used to render inline', () => {
    expect(sectionsFor({}, 'collection').map((band) => band.type)).toEqual([
      'collection_header',
      'collection_products',
    ]);
  });

  it('gives every composed page exactly what its route used to render', () => {
    expect(sectionsFor({}, 'page').map((band) => band.type)).toEqual(['page_body']);
    expect(sectionsFor({}, 'blog').map((band) => band.type)).toEqual(['article_list']);
  });

  /*
   * And the pages that are deliberately still not templates.
   *
   * The cart is the funnel, and the product page's own warning -- "one mis-click
   * from a shop that cannot sell anything" -- applies to it with more force. The
   * account page is behind a session, is never shared-cached, and has nothing a
   * merchant merchandises. A template stored against either is data nothing
   * reads, which is exactly what it was before any of this.
   */
  it('leaves the cart and the account page alone', () => {
    expect(sectionsFor({}, 'cart')).toEqual([]);
    expect(sectionsFor({}, 'account')).toEqual([]);
  });

  it('gives a post its own body', () => {
    // The one exception, and it exists so `article_body` has somewhere to be.
    // A post's writing is the one piece of built-in content a merchant might
    // reasonably want to move, so the route renders a template rather than the
    // body, and the default template is exactly that body. Output unchanged.
    expect(sectionsFor({}, 'article')).toEqual([{ type: 'article_body' }]);
  });

  it.each([
    ['a null layout value', { home: null }],
    ['a string', { home: 'intro' }],
    ['an object', { home: { type: 'intro' } }],
    ['an empty array', { home: [] }],
    ['an array of nothing usable', { home: [null, 3, 'intro', {}] }],
  ])('renders the default rather than throwing for %s', (_case, layout) => {
    expect(sectionsFor(layout as Record<string, unknown>, 'home')).toEqual(DEFAULT_HOME);
  });

  it('drops one bad section instead of resetting the whole page', () => {
    // The behaviour that changed, and the reason it changed is rollback. A
    // deploy that no longer knows about a section a merchant placed last week
    // should lose that band. Resetting to the platform default would present as
    // every themed shop on the platform reverting at once.
    const sections = sectionsFor(
      { home: [{ type: 'note', heading: 'Kept' }, { type: 'from_the_future' }] },
      'home',
    );

    expect(sections).toEqual([{ type: 'note', heading: 'Kept' }]);
  });

  it('drops a section that is not allowed on the page it was stored against', () => {
    expect(sectionsFor({ product: [{ type: 'intro' }, { type: 'note' }] }, 'product')).toEqual([
      { type: 'note' },
    ]);
  });

  it('caps a page that somehow holds forty sections', () => {
    const forty = Array.from({ length: 40 }, () => ({ type: 'note' as const }));

    expect(sectionsFor({ home: forty }, 'home')).toHaveLength(MAX_SECTIONS_PER_PAGE);
  });

  it('reads one page without disturbing another', () => {
    const layout = { home: [{ type: 'note' }], product: [{ type: 'products', limit: 4 }] };

    expect(sectionsFor(layout, 'home')).toEqual([{ type: 'note' }]);
    expect(sectionsFor(layout, 'product')).toEqual([{ type: 'products', limit: 4 }]);
  });

  it('hands back a default nobody can edit from under the next caller', () => {
    const first = defaultTemplateFor('home');
    first[0]!.heading = 'mutated';

    expect(defaultTemplateFor('home')[0]?.heading).toBeUndefined();
  });
});

describe('what a page has to fetch', () => {
  const plan = (sections: LayoutSection[]) => dataPlanFor(sections);

  it('asks for nothing when nothing on the page needs anything', () => {
    expect(plan([{ type: 'intro' }, { type: 'note' }])).toEqual({
      productLimit: 0,
      collections: false,
      productHandles: [],
      collectionHandles: [],
      articleLimit: 0,
      reviewLimit: 0,
      relatedLimit: 0,
      styledLimit: 0,
      thisCollectionLimit: 0,
      thisBlogLimit: 0,
      pluginBlocks: false,
      appSections: [],
      thisCollectionBlocks: false,
      mediaIds: [],
    });
  });

  it('asks for each app section a band names, once, and none for a band that names none', () => {
    const sections: LayoutSection[] = [
      { type: 'app_block', app: 'size-guide', section: 'chart' },
      { type: 'app_block', app: 'size-guide', section: 'chart', heading: 'Again' },
      { type: 'app_block', app: 'reviews-app', section: 'summary' },
      { type: 'app_block', app: 'size-guide' },
      { type: 'app_block' },
    ];

    expect(plan(sections).appSections).toEqual([
      { app: 'size-guide', section: 'chart' },
      { app: 'reviews-app', section: 'summary' },
    ]);
    expect(plan([{ type: 'plugin_block' }]).appSections).toEqual([]);
  });

  it("reads apps' markup for the collection's header only where that band is", () => {
    // The header band drew it with an async child of its own until 2026-10-18,
    // which read the slot only once everything else on the page had loaded.
    expect(plan([{ type: 'collection_header' }]).thisCollectionBlocks).toBe(true);
    expect(plan([{ type: 'collection_products' }]).thisCollectionBlocks).toBe(false);
  });

  it('asks the blog index for as many posts as its band says', () => {
    /*
     * `article_list` declared a "how many" from the day it was written and
     * nothing read it, so the route asked for the fetch's own default and a
     * merchant choosing any number between 1 and 48 always got twelve. The
     * limit travels through the plan rather than being applied in the renderer,
     * because the index is paginated with a keyset cursor and a band showing
     * twelve of twenty fetched would strand eight posts between pages.
     */
    expect(plan([{ type: 'article_list', limit: 4 }]).thisBlogLimit).toBe(4);
    // The fallback is twelve, and so is `DEFAULT_ARTICLE_LIMIT`, which is what
    // keeps a shop that has set nothing fetching exactly what it fetched before.
    expect(plan([{ type: 'article_list' }]).thisBlogLimit).toBe(12);
    // The largest of them, like every other limit on this plan.
    expect(
      plan([
        { type: 'article_list', limit: 4 },
        { type: 'article_list', limit: 30 },
      ]).thisBlogLimit,
    ).toBe(30);
  });

  /*
   * The category page's own limit, which behaves like `reviewLimit` rather than
   * like `collectionHandles`: a number, because the band means "this one" and
   * the page knows which collection it is. One template serves every category
   * in a shop, which is the difference between arranging a category page once
   * and arranging four hundred of them.
   */
  it('sizes the grid on a category page from the band rather than from a default', () => {
    expect(plan([{ type: 'collection_products', limit: 12 }]).thisCollectionLimit).toBe(12);
    expect(plan([{ type: 'collection_products' }]).thisCollectionLimit).toBe(24);
    expect(plan([{ type: 'intro' }]).thisCollectionLimit).toBe(0);
  });

  /*
   * A look, like the related band: a number, because the band means "this
   * product" and only the product page knows which. One more piece than the
   * limit is drawn (the product itself), and that is the read's business.
   */
  it('asks for the look of the product a styled-with band sits under', () => {
    expect(plan([{ type: 'styled_with' }]).styledLimit).toBe(3);
    expect(
      plan([
        { type: 'styled_with', limit: 2 },
        { type: 'styled_with', limit: 5 },
      ]).styledLimit,
    ).toBe(5);
    expect(plan([{ type: 'related_products' }]).styledLimit).toBe(0);
  });

  it('fetches the photograph a category grid sets among its cards with the rest', () => {
    const feature = '22222222-2222-4222-8222-222222222222';
    expect(plan([{ type: 'collection_products', feature }]).mediaIds).toEqual([feature]);
  });

  it('takes the largest limit rather than the sum', () => {
    // The whole point of the plan. Two product bands are one query for the
    // larger of them, not two queries, and not a query for their total.
    expect(
      plan([
        { type: 'products', limit: 4 },
        { type: 'products', limit: 12 },
      ]),
    ).toMatchObject({ productLimit: 12, collections: false });
  });

  it('uses the default limit for a band that did not name one', () => {
    expect(plan([{ type: 'products' }]).productLimit).toBe(24);
  });

  it('ignores a limit that is not a number', () => {
    expect(plan([{ type: 'products', limit: 'lots' as unknown as number }]).productLimit).toBe(24);
  });

  it('asks for collections once however many bands want them', () => {
    expect(plan([{ type: 'collections' }, { type: 'collections', limit: 4 }])).toMatchObject({
      productLimit: 0,
      collections: true,
    });
  });

  it('ignores a section type it does not recognise', () => {
    expect(plan([{ type: 'from_the_future' }])).toMatchObject({
      productLimit: 0,
      collections: false,
    });
  });

  it('reproduces what the home page fetched before the plan existed', () => {
    expect(plan(DEFAULT_HOME)).toMatchObject({ productLimit: 24, collections: false });
  });

  it('names each featured product once however many bands feature it', () => {
    expect(
      plan([
        { type: 'featured_product', product: 'anorak' },
        { type: 'featured_product', product: 'anorak' },
        { type: 'featured_product', product: 'boots' },
      ]).productHandles,
    ).toEqual(['anorak', 'boots']);
  });

  it('asks for nothing when a featured band names no product', () => {
    // A hero a merchant dropped on the page and has not filled in yet. It must
    // cost no query, or an unfinished page is a slow one.
    expect(plan([{ type: 'featured_product' }]).productHandles).toEqual([]);
    expect(plan([{ type: 'featured_collection' }]).collectionHandles).toEqual([]);
  });

  it('reads one collection at the deeper of two depths asked of it', () => {
    expect(
      plan([
        { type: 'featured_collection', collection: 'outerwear', limit: 4 },
        { type: 'featured_collection', collection: 'outerwear', limit: 10 },
      ]).collectionHandles,
    ).toEqual([{ handle: 'outerwear', limit: 10 }]);
  });

  it('keeps two different collections apart', () => {
    expect(
      plan([
        { type: 'featured_collection', collection: 'outerwear', limit: 4 },
        { type: 'featured_collection', collection: 'footwear', limit: 6 },
      ]).collectionHandles,
    ).toEqual([
      { handle: 'outerwear', limit: 4 },
      { handle: 'footwear', limit: 6 },
    ]);
  });

  it('collects every picture on the page, from the field kinds', () => {
    // Not declared per section: found by walking the definitions for fields of
    // kind `media`. A band added next year names its picture something else and
    // this collects it without being told.
    const HERO = '11111111-1111-4111-8111-111111111111';
    const SHOT = '22222222-2222-4222-8222-222222222222';

    expect(
      plan([
        { type: 'hero', image: HERO },
        { type: 'note', body: 'No picture here.' },
        { type: 'image_with_text', image: SHOT },
      ]).mediaIds,
    ).toEqual([HERO, SHOT]);
  });

  it('collects pictures out of blocks as well as settings', () => {
    const ONE = '33333333-3333-4333-8333-333333333333';
    const TWO = '44444444-4444-4444-8444-444444444444';

    const gallery = parseSection({
      type: 'gallery',
      blocks: [
        { type: 'image', image: ONE },
        { type: 'image', image: TWO },
      ],
    });

    // A gallery of twelve under a hero is thirteen ids and one query. If block
    // pictures were missed, each would fall back to its own read at render.
    expect(plan([gallery!]).mediaIds).toEqual([ONE, TWO]);
  });

  it('names one picture once however many bands use it', () => {
    const LOGO = '55555555-5555-4555-8555-555555555555';

    expect(
      plan([
        { type: 'hero', image: LOGO },
        { type: 'image_with_text', image: LOGO },
      ]).mediaIds,
    ).toEqual([LOGO]);
  });

  it('takes the largest limit any blog band asked for', () => {
    expect(
      plan([
        { type: 'blog_posts', limit: 3 },
        { type: 'blog_posts', limit: 6 },
      ]).articleLimit,
    ).toBe(6);
  });
});

describe('a row that carries its own bands', () => {
  /*
   * The primitive per-page composition rests on, and the three layers it
   * resolves: this row, every row of its kind, the platform's default.
   *
   * Nothing calls it yet -- the column it reads is the landing-page work -- and
   * it is tested now rather than later because the arithmetic is the part that
   * has to be right before anything depends on it. A layering bug here would
   * present as one page in a shop rendering somebody else's template.
   */
  it('falls through to the page-type template when the row has none', () => {
    const layout = { page: [{ type: 'note', heading: 'Every page' }] };

    expect(sectionsForRow(layout, 'page', []).map((band) => band.type)).toEqual(['note']);
    expect(sectionsForRow(layout, 'page', undefined).map((band) => band.type)).toEqual(['note']);
  });

  it('falls all the way through to the platform default', () => {
    expect(sectionsForRow({}, 'page', []).map((band) => band.type)).toEqual(['page_body']);
  });

  /*
   * Wholesale, and this is the assertion that pins the decision rather than the
   * behaviour. Two section lists have no honest merge -- append, prepend and
   * match-by-id are three different answers and nothing in either list says
   * which -- and a merge would put two bands carrying the same `id` on one
   * page, which is what `id` exists to make impossible.
   */
  it('lets the row win whole rather than merging it with the template', () => {
    const layout = { page: [{ type: 'note' }, { type: 'faq' }] };
    const own = [{ type: 'hero' }];

    expect(sectionsForRow(layout, 'page', own).map((band) => band.type)).toEqual(['hero']);
  });

  it('falls through when the row holds nothing this release can draw', () => {
    // Not the same as empty, and it has to resolve the same way: a row naming a
    // band a rollback no longer knows should render its shop's template rather
    // than nothing at all.
    const layout = { page: [{ type: 'note' }] };

    expect(sectionsForRow(layout, 'page', [{ type: 'liquid' }]).map((b) => b.type)).toEqual([
      'note',
    ]);
  });

  it('drops a band the row is not allowed to carry', () => {
    // `reviews` is product-only. A row that named one would otherwise put a
    // band on a page whose renderer has nothing to give it.
    expect(
      sectionsForRow({}, 'page', [{ type: 'reviews' }, { type: 'note' }]).map((b) => b.type),
    ).toEqual(['note']);
  });
});

describe('which template supplies the page title', () => {
  /*
   * The bug this answers is quiet and total. `Sections` picks the `h1` from the
   * first `intro` or `hero` and renders none when there is neither -- so a page
   * composed of a banner and a product grid has no title at all, to a screen
   * reader and a crawler both. Survivable on `home`, where the default starts
   * with an `intro`; not survivable on a page a merchant composes from nothing.
   */
  it('recognises the bands that carry one', () => {
    expect(templateCarriesHeading([{ type: 'intro' }])).toBe(true);
    expect(templateCarriesHeading([{ type: 'products' }, { type: 'hero', heading: 'Kit' }])).toBe(
      true,
    );
  });

  it('says no for a template that has none, so the route renders its own', () => {
    expect(templateCarriesHeading([{ type: 'banner' }, { type: 'products' }])).toBe(false);
    expect(templateCarriesHeading([])).toBe(false);
  });

  /*
   * A collection page's title band. It was missing from the list, and
   * `DEFAULT_COLLECTION` is exactly `[collection_header, collection_products]`,
   * so every collection page on the default arrangement answered false here,
   * took the `h2` branch in the renderer, and shipped with no `h1` at all.
   */
  it('counts the band a collection page renders its title from', () => {
    expect(templateCarriesHeading([{ type: 'collection_header' }])).toBe(true);
  });

  /*
   * The case that made this predicate lie, and it is the ordinary intermediate
   * state rather than a corner: the editor writes `{ type }` on Add, so a hero
   * exists with no heading for as long as it takes somebody to type one. The
   * renderer draws a hero's title only when it has text, so answering on the
   * band TYPE told the route "the template has a title" while the hero rendered
   * none. The route then rendered none either.
   */
  it('does not count a hero nobody has typed into yet', () => {
    expect(templateCarriesHeading([{ type: 'hero' }])).toBe(false);
    expect(templateCarriesHeading([{ type: 'hero', heading: '   ' }])).toBe(false);
    expect(sectionCarriesHeading({ type: 'hero', heading: 'Kit for weather' })).toBe(true);
  });

  /*
   * Bands that appear on a page WITH a title but do not render it. Adding these
   * would suppress the fallback their routes already have and leave those pages
   * with no `h1` instead of one, which is the same defect in the other
   * direction.
   */
  it('does not count a band that merely sits on a titled page', () => {
    expect(templateCarriesHeading([{ type: 'page_body' }])).toBe(false);
    expect(templateCarriesHeading([{ type: 'article_list' }])).toBe(false);
  });
});

describe('the strip above every page', () => {
  it('holds a banner and nothing else', () => {
    expect(
      SECTION_DEFINITIONS.filter((definition) => sectionAllowedOn(definition.type, 'shop')).map(
        (definition) => definition.type,
      ),
    ).toEqual(['banner']);
  });

  it('is empty until a merchant puts something there', () => {
    expect(defaultTemplateFor('shop')).toEqual([]);
  });

  it('keeps a band welcome anywhere on the pages, not above all of them', () => {
    for (const page of PAGE_TYPES.filter((one) => one !== 'shop')) {
      expect(sectionAllowedOn('banner', page), page).toBe(true);
    }
    expect(sectionAllowedOn('rich_text', 'shop')).toBe(false);
  });
});
