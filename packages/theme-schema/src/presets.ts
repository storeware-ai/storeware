/**
 * The looks a band comes in, as points in a small space.
 *
 * A `hero` had exactly one appearance, and so did every other band. Which is
 * the other half of why two generated shops looked alike: the art direction
 * decides how the page is set, and this decides what a band actually does with
 * its picture and its words.
 *
 * ## Why this is a table of axes and not a table of looks
 *
 * The obvious shape is one CSS block per preset. Forty preset names across ten
 * bands is forty blocks of hand-written CSS, and the fortieth is always the one
 * nobody keeps in step: `gallery.mosaic` and `products.masonry` are the same
 * idea and would drift apart the first time one of them was adjusted.
 *
 * So a preset is a NAME FOR A PAIR. Seven layouts and three emphases is ten
 * rule groups in `globals.css`, every preset is a point in that space, and two
 * bands that mean the same thing get the same rules by construction rather than
 * by somebody remembering.
 *
 * ## The default of every band maps to null
 *
 * Null, not an empty object. The renderer emits no attribute at all for it, so
 * a band nobody has re-presetted produces the markup it has always produced --
 * same element, same classes, nothing added. That is what makes this shippable
 * without touching a single existing shop, and `sections.test.tsx` asserts it.
 */

/** How a band arranges its children, and what it leads with. */
export interface PresetAxes {
  readonly layout:
    | 'stack'
    | 'split'
    | 'overlay'
    | 'grid'
    | 'rail'
    | 'marquee'
    | 'mosaic'
    | 'bento'
    | 'chips'
    | 'index'
    | 'poster'
    | 'bleed'
    | 'sticky'
    | 'offset'
    /*
     * The theme round's own (2026-10-20). Each is a value no rule before it
     * matched, so a band that takes one meets only the rules written for it:
     * the older layouts style every list in their band, and a collage or a
     * menu is a list that wants none of that.
     */
    | 'carousel'
    | 'menu'
    | 'masked'
    | 'pile'
    | 'strip';
  readonly emphasis: 'balanced' | 'type' | 'media';
}

/**
 * Every preset the platform draws, by band and then by name.
 *
 * The keys here are the `value` of each entry in a section's `presets` list.
 * `presets.test.ts` asserts the two agree in both directions, because a preset
 * offered with no entry here silently does nothing, and an entry here that no
 * band offers is CSS nobody can reach.
 */
export const PRESETS: Readonly<Record<string, Readonly<Record<string, PresetAxes | null>>>> = {
  hero: {
    classic: null,
    image_scrim: { layout: 'overlay', emphasis: 'media' },
    split: { layout: 'split', emphasis: 'balanced' },
    editorial: { layout: 'stack', emphasis: 'type' },
    /*
     * The picture as a poster and the heading set as its headline, from the
     * signed-off "Force seven" comp: taller than a scrim hero, square, the
     * words in white over a darkened photograph whatever the shop's colours.
     * Its own layout rather than `overlay`, because a tile band maps to
     * `overlay` too and a poster's headline size must not reach a tile. The one
     * band a transparent header may sit over; see `headerStyle` in core.
     */
    poster: { layout: 'poster', emphasis: 'type' },
    /*
     * A poster the whole width and height of the screen, the way a fashion
     * house opens: one photograph from edge to edge, the words low on it, the
     * header drawn over it. A poster in every other respect, so it shares the
     * poster's layout and with it the dark wash, the white words and the one
     * place a transparent header may sit; the `media` emphasis is what tells
     * the two apart, and it touches no other part of a hero.
     */
    cover: { layout: 'poster', emphasis: 'media' },
  },
  /*
   * Story panels: each tile a photograph the width of the screen with a line,
   * a heading, a sentence and a link on it, the way a fashion house's front
   * page runs. `panels` stacks them one under another; `spread` sets them two
   * to a row from edge to edge. Both share `bleed` with the gallery and the
   * picture beside words that reach the edge, and with it the page clip.
   */
  promo_pair: {
    tiles: null,
    panels: { layout: 'bleed', emphasis: 'media' },
    spread: { layout: 'bleed', emphasis: 'balanced' },
  },
  products: {
    grid: null,
    rail: { layout: 'rail', emphasis: 'media' },
    mosaic: { layout: 'mosaic', emphasis: 'media' },
    list: { layout: 'stack', emphasis: 'type' },
    /*
     * One product given a double tile and the rest around it, from the
     * signed-off "Force seven" comp. Its own layout rather than `mosaic`,
     * because a mosaic widens every fourth item along a row and a bento makes
     * the first one TALL, two rows deep, which is a different page: one lead
     * and a rack beside it rather than a rhythm.
     */
    bento: { layout: 'bento', emphasis: 'balanced' },
    /*
     * The whole catalogue as a ruled sheet of index cards, from the signed-off
     * "Grid reference" comp: cards flush against each other with a rule between
     * them, square, the price in the code face. Type emphasis, because an index
     * is titled like a document.
     */
    index: { layout: 'index', emphasis: 'type' },
    /*
     * Every other column dropped down the page, so a rack of products reads as
     * placed rather than tiled. A margin rather than a transform, so the band is
     * as tall as what it draws and nothing overlaps the band below.
     */
    offset: { layout: 'offset', emphasis: 'media' },
    /*
     * A row with buttons: snap points, and `::scroll-button` where the
     * browser has it, from the signed-off Primary comp. Its own layout rather
     * than `rail`, which every list in a band follows, because the buttons
     * and the snap belong to the product row alone.
     */
    carousel: { layout: 'carousel', emphasis: 'media' },
    /* Names and prices running past, the Force Seven and Drop ticker. */
    marquee: { layout: 'marquee', emphasis: 'type' },
    /* A priced list with dotted leaders, Counter's menu board. */
    menu: { layout: 'menu', emphasis: 'type' },
    /* One product to a row with its picture given room: `list` led by the picture. */
    stack: { layout: 'stack', emphasis: 'media' },
  },
  collections: {
    grid: null,
    rail: { layout: 'rail', emphasis: 'media' },
    tiles: { layout: 'overlay', emphasis: 'media' },
    /*
     * A row of small bordered names, the way an index or a map sheet lists its
     * sections, from the signed-off "Grid reference" comp. For a shop whose
     * ranges are words rather than pictures.
     */
    chips: { layout: 'chips', emphasis: 'balanced' },
  },
  collection_products: {
    grid: null,
    rail: { layout: 'rail', emphasis: 'media' },
    mosaic: { layout: 'mosaic', emphasis: 'media' },
    list: { layout: 'stack', emphasis: 'type' },
    index: { layout: 'index', emphasis: 'type' },
    offset: { layout: 'offset', emphasis: 'media' },
    bento: { layout: 'bento', emphasis: 'balanced' },
    menu: { layout: 'menu', emphasis: 'type' },
    stack: { layout: 'stack', emphasis: 'media' },
  },
  collection_list: {
    grid: null,
    rail: { layout: 'rail', emphasis: 'media' },
    tiles: { layout: 'overlay', emphasis: 'media' },
    chips: { layout: 'chips', emphasis: 'balanced' },
  },
  gallery: {
    grid: null,
    rail: { layout: 'rail', emphasis: 'media' },
    mosaic: { layout: 'mosaic', emphasis: 'media' },
    /* The row of pictures run to both edges of the screen, past the shop's column. */
    bleed: { layout: 'bleed', emphasis: 'media' },
    offset: { layout: 'offset', emphasis: 'media' },
  },
  testimonials: {
    grid: null,
    rail: { layout: 'rail', emphasis: 'balanced' },
    marquee: { layout: 'marquee', emphasis: 'type' },
  },
  logo_list: {
    grid: null,
    rail: { layout: 'rail', emphasis: 'media' },
    /*
     * The one a merchant asks for by name.
     *
     * "Create a client carousel" had no answer before this: `logo_list` was a
     * static grid and the nearest thing was a row of logos that did not move.
     * It needs no client component -- see the marquee rules in `globals.css`,
     * which duplicate the track in the server's own markup and translate it
     * with a keyframe. Zero bytes of JavaScript, and every logo still in the
     * document for a crawler and a shopping agent to read.
     */
    marquee: { layout: 'marquee', emphasis: 'media' },
  },
  image_with_text: {
    split: null,
    overlap: { layout: 'overlay', emphasis: 'balanced' },
    stacked: { layout: 'stack', emphasis: 'media' },
    /*
     * The picture runs to the edge of the screen on its own side while the
     * words keep to the shop's column, the way a magazine lets a photograph
     * leave the page. Follows the side the merchant put the picture on.
     */
    bleed: { layout: 'bleed', emphasis: 'media' },
    /*
     * The picture holds still beside words long enough to scroll past it. From
     * a tablet up; a phone stacks the two as it always did.
     */
    sticky: { layout: 'sticky', emphasis: 'balanced' },
    /* The picture cut to the band's shape on a block of the accent. */
    masked: { layout: 'masked', emphasis: 'media' },
  },
  multicolumn: {
    columns: null,
    numbered: { layout: 'grid', emphasis: 'type' },
    rail: { layout: 'rail', emphasis: 'balanced' },
  },
  faq: {
    list: null,
    two_column: { layout: 'grid', emphasis: 'type' },
    /* The heading held beside the questions as they scroll, set as a headline. */
    sticky: { layout: 'sticky', emphasis: 'type' },
  },
  article_list: {
    list: null,
    cards: { layout: 'grid', emphasis: 'balanced' },
    rail: { layout: 'rail', emphasis: 'media' },
  },
  blog_posts: {
    list: null,
    cards: { layout: 'grid', emphasis: 'balanced' },
    rail: { layout: 'rail', emphasis: 'media' },
  },
  banner: {
    strip: null,
    ticker: { layout: 'marquee', emphasis: 'type' },
  },
  /*
   * The collage's three arrangements. Scattered is the band's own drawing;
   * `pile` lays each picture over the last, and `strip` runs them across the
   * page edge to edge, overlapping a little.
   */
  collage: {
    scatter: null,
    stack: { layout: 'pile', emphasis: 'media' },
    strip: { layout: 'strip', emphasis: 'media' },
  },
};

/**
 * The attributes one band's chosen preset is worth.
 *
 * Empty for the default, for a band with no presets, and for a value this build
 * has never heard of. All three render the band exactly as it renders today,
 * which is the right answer to all three: the first by design, the second
 * because there is nothing to say, and the third because a layout written by a
 * later release should cost a variant rather than a page.
 */
export function presetAttributes(type: string, value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {};

  const axes = PRESETS[type]?.[value];
  if (!axes) return {};

  return { 'data-sw-layout': axes.layout, 'data-sw-emphasis': axes.emphasis };
}

/** Whether a band's chosen preset asks for the duplicated marquee track. */
export function isMarquee(type: string, value: unknown): boolean {
  return typeof value === 'string' && PRESETS[type]?.[value]?.layout === 'marquee';
}
