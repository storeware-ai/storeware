import { z } from 'zod';
import { isColour } from './css-values';
import { isSafeHref } from './href';
import { PICTURE_SHAPES, type PictureShape } from './shapes';

/**
 * The sections a merchant can put on a page, described once.
 *
 * The closed set is unchanged as a principle and this file does not weaken it.
 * A merchant chooses which sections appear, on which page, in what order, and
 * what they say; they never author markup. What changes is that the set is now
 * data rather than four hand-kept copies of a union.
 *
 * Before this file a new section type meant editing four places that could
 * silently disagree:
 *
 *   - `SECTION_TYPES` in `theme.ts`, which decides what parses
 *   - the `switch` in the storefront's home page, which decides what renders
 *   - `SECTION_LABELS` in the admin, which decides what a merchant sees
 *   - `readSections` in the admin, which decides what an AI proposal may say
 *
 * Three of those failing quietly is the interesting part. A type missing from
 * `SECTION_LABELS` renders a blank row on the confirm screen; a type missing
 * from the `switch` renders nothing at all. Both look like a shop with a
 * section that does not work rather than like a bug in a list.
 *
 * `blueprint-schema.ts` already had the right instinct: it imports
 * `layoutSectionInput` rather than restating it, "which is what makes an
 * unknown section type unrepresentable rather than merely discouraged". This is
 * that instinct applied to the other three.
 */

/**
 * The page types a merchant can arrange.
 *
 * `home` was the only one for a long time and the storage was always ready for
 * more: `store_themes.layout` is keyed by page type, `sectionsFor` takes the
 * key as an argument, and `updateStoreLayout` merges per key so writing one
 * page cannot clear another.
 *
 * The rest of this list is the set of pages the storefront actually has a route
 * for. A page type nobody can navigate to is a template nobody can see.
 */
export const PAGE_TYPES = [
  'home',
  'product',
  'collection',
  'page',
  'article',
  'blog',
  'search',
  'cart',
  'account',
  'not_found',
  /*
   * Not a page: the strip above the header on every page, since 2026-10-03.
   * A sale, a delivery promise, a notice, the way the leading shops open every
   * page with one line. Only a `banner` may sit here (see `ANY_PAGE`), and the
   * storefront draws the first one. Last, because the list is add-only and
   * stored layouts are keyed by these names.
   */
  'shop',
] as const;

export type PageType = (typeof PAGE_TYPES)[number];

/**
 * Every page, for the sections that are welcome anywhere.
 *
 * Not the shop-wide strip, which is not a page and holds one line: a band
 * welcome anywhere is welcome on every page, not above the header of all of
 * them at once.
 */
const ANY_PAGE: readonly PageType[] = PAGE_TYPES.filter((page) => page !== 'shop');

/**
 * Copy is text, and length is the only thing enforced about it.
 *
 * Carried over from `theme.ts` unchanged, including the reasoning. No pattern
 * and no character filter, because this is rendered as a text node by a server
 * component rather than interpolated into markup: React escapes it, so
 * `<script>` in a heading is a heading that says `<script>`.
 *
 * The direction a bound may move is one-way. `sectionsFor` falls back to a
 * default when nothing parses, so lowering one of these later would not show a
 * truncated heading on the shops that had used the room. Loosen freely,
 * tighten never.
 */
export const MAX_HEADING = 120;
export const MAX_BODY = 2000;

/**
 * The kinds of setting a section may have, and nothing else.
 *
 * A closed set for the same reason the section list is one, and the constraint
 * is concrete rather than philosophical: every kind here needs a control in the
 * editor and a resolver on the storefront. Adding a kind is two pieces of work
 * in two apps and a deliberate act. Adding a section that uses kinds which
 * already exist is neither, which is the whole point of separating them.
 *
 * `richtext` is the only one that can carry markup, and THIS PACKAGE DOES NOT
 * SANITISE IT. That is worth stating in capitals because the sentence here used
 * to say the opposite: it claimed the value "goes through the allow-list
 * sanitiser that CMS pages already use, in `../content/sanitise`". That was
 * true while this file lived inside the platform and false the moment it was
 * extracted, because the sanitiser is on the platform's WRITE path and there is
 * no such path in a package whose only dependency is zod. `parseSection` on a
 * `richtext` value containing a script tag returns the script tag.
 *
 * So sanitising is the host's obligation, not the schema's, and a renderer that
 * takes this package's word for it has an injection on a merchant's own domain.
 * The platform does it in `content/sanitise.ts` on the way in, which is the
 * right place: sanitising on write means it happens once per edit rather than
 * once per request, and a value that reaches the database is already safe.
 *
 * What the package DOES guarantee is narrower and still worth having: there is
 * no `html` kind and no `css` kind, so no setting exists whose declared purpose
 * is to carry code, and no value anywhere is evaluated. A theme file cannot
 * execute. It can carry markup a careless host then renders, which is a
 * different and much smaller problem than a template language.
 */
export const FIELD_KINDS = [
  'text',
  'richtext',
  'number',
  'boolean',
  'select',
  'colour',
  'media',
  'product',
  'collection',
  'blog',
  'url',
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldChoice {
  value: string;
  label: string;
  /**
   * Whether a generator may choose this value. Absent means yes.
   *
   * The choice-level twin of `FieldDefinition.generatable`, for a value added
   * to a list the model is already offered. Every band's `preset` is one
   * setting, so a new look for the product grid would otherwise reach the
   * model the moment it was declared, before any prompt says what it is for.
   * The editor offers every choice; the model is offered the ones without
   * this flag (`blueprintSectionFields`, and `modelField` in `packages/ai`).
   */
  readonly generatable?: boolean;
}

export interface FieldDefinition {
  readonly name: string;
  readonly kind: FieldKind;
  /** What the editor writes above the control. */
  readonly label: string;
  /** The sentence under it, when the label is not enough on its own. */
  readonly hint?: string;
  readonly choices?: readonly FieldChoice[];
  readonly min?: number;
  readonly max?: number;
  /**
   * For a picture, the narrowest one in pixels the band draws without
   * enlarging it past recognition.
   *
   * Advice, never a bound: a narrower picture is stored and drawn, the editor
   * says what it will look like, and generation will not choose one. Kept apart
   * from `min` because `min` is a validation bound the compatibility check holds
   * to only ever falling, and raising a piece of advice invalidates nothing.
   */
  readonly narrowest?: number;
  /** What the renderer uses when the merchant left it alone. */
  readonly fallback?: string | number | boolean;
  /**
   * Whether a generator may fill this in. Absent means yes.
   *
   * The generators build their schema from `blueprintSectionFields`, so a
   * setting added to the registry is offered to a model the moment it exists.
   * That is the right default for a heading or an alignment and the wrong one
   * for a setting whose meaning a prompt has not explained yet: `store_blueprint`
   * writes the LIVE theme during onboarding, so a knob it picks blind ships to a
   * shopper without anybody choosing it.
   *
   * So a new setting can land in the editor, in the file format and in the
   * renderer first, and be offered to a model in a later change that also
   * teaches it what the values mean. Flipping this is the deliberate second act.
   */
  readonly generatable?: boolean;
  readonly schema: z.ZodTypeAny;
}

/**
 * Every setting is optional, always.
 *
 * A required setting would mean a section that cannot be placed until it is
 * filled in, and the editor's whole shape is place-then-adjust: a merchant
 * drops a hero on the page and types into it, rather than filling a form and
 * being given a hero. It also means a stored section can never become invalid
 * because a later release wanted one more field.
 */
const field = {
  text(name: string, label: string, options: { hint?: string; max?: number } = {}) {
    const max = options.max ?? MAX_HEADING;
    return {
      name,
      kind: 'text',
      label,
      max,
      ...(options.hint ? { hint: options.hint } : {}),
      schema: z.string().trim().max(max).optional(),
    } as const satisfies FieldDefinition;
  },

  richtext(name: string, label: string, options: { hint?: string } = {}) {
    return {
      name,
      kind: 'richtext',
      label,
      max: MAX_BODY,
      ...(options.hint ? { hint: options.hint } : {}),
      schema: z.string().trim().max(MAX_BODY).optional(),
    } as const satisfies FieldDefinition;
  },

  number(
    name: string,
    label: string,
    options: { min: number; max: number; fallback: number; hint?: string },
  ) {
    return {
      name,
      kind: 'number',
      label,
      min: options.min,
      max: options.max,
      fallback: options.fallback,
      ...(options.hint ? { hint: options.hint } : {}),
      schema: z.number().int().min(options.min).max(options.max).optional(),
    } as const satisfies FieldDefinition;
  },

  boolean(name: string, label: string, options: { fallback: boolean; hint?: string }) {
    return {
      name,
      kind: 'boolean',
      label,
      fallback: options.fallback,
      ...(options.hint ? { hint: options.hint } : {}),
      schema: z.boolean().optional(),
    } as const satisfies FieldDefinition;
  },

  select(
    name: string,
    label: string,
    choices: readonly FieldChoice[],
    options: { fallback: string; hint?: string; generatable?: boolean },
  ) {
    const values = choices.map((choice) => choice.value);
    return {
      name,
      kind: 'select',
      label,
      choices,
      fallback: options.fallback,
      ...(options.hint ? { hint: options.hint } : {}),
      ...(options.generatable === undefined ? {} : { generatable: options.generatable }),
      /*
       * Refined rather than `z.enum`, so the choice list stays the single
       * declaration and a value nothing has a branch for cannot render.
       *
       * `.catch(undefined)` is what stops that costing the whole band, and the
       * distinction is worth stating because the two failures are not the same
       * size. A section object that fails to parse returns null from
       * `parseSection` and the band DISAPPEARS from the page. That was
       * defensible while every select was an alignment: a hero aligned to a
       * value nobody wrote CSS for is arguably a hero nobody meant.
       *
       * It stopped being defensible with presets. A preset is decoration, and
       * a shop losing its whole hero because a variant was renamed in a release
       * -- or because a theme file came from a shop one version ahead -- is
       * strictly worse than that hero rendering in its default look. So an
       * unreadable choice falls back to absent, the renderer's own lookup finds
       * no axes and emits no attribute, and the band renders the way it did
       * before anybody chose anything.
       *
       * Scoped to `select` alone. A media id or a URL that does not parse is
       * not decoration and still drops its band.
       */
      schema: z
        .string()
        .refine((value) => values.includes(value))
        .optional()
        .catch(undefined),
    } as const satisfies FieldDefinition;
  },

  /**
   * A picture the merchant uploaded, by media id.
   *
   * An id rather than a URL, so the storefront resolves it through the same
   * read that already returns intrinsic width and height. A stored URL would
   * mean a section that renders without those and shifts the page as it loads,
   * which is the one layout bug a shopper always notices.
   */
  media(name: string, label: string, options: { hint?: string; narrowest?: number } = {}) {
    return {
      name,
      kind: 'media',
      label,
      ...(options.hint ? { hint: options.hint } : {}),
      ...(options.narrowest === undefined ? {} : { narrowest: options.narrowest }),
      schema: z.string().guid().optional(),
    } as const satisfies FieldDefinition;
  },

  /**
   * A reference to something in the catalogue, by handle.
   *
   * By handle rather than by id, because handle is what the storefront's public
   * read path takes and an id read would be a new endpoint on the storefront
   * API for every kind of reference.
   *
   * The cost is real and worth writing down: renaming a product moves its
   * handle, and a section pointing at the old one stops resolving. It fails to
   * nothing rather than to an error, the same way a plugin block does, so the
   * band disappears rather than the page breaking. The proper fix is for the
   * editor to validate references on save and for renames to rewrite them, and
   * that belongs with the editor rather than ahead of it.
   */
  reference(name: string, kind: 'product' | 'collection' | 'blog', label: string, hint?: string) {
    return {
      name,
      kind,
      label,
      ...(hint ? { hint } : {}),
      schema: z
        .string()
        .trim()
        .max(200)
        .regex(/^[a-z0-9][a-z0-9\-/]*$/i)
        .optional(),
    } as const satisfies FieldDefinition;
  },

  url(name: string, label: string, options: { hint?: string } = {}) {
    return {
      name,
      kind: 'url',
      label,
      ...(options.hint ? { hint: options.hint } : {}),
      /*
       * Through the shared predicate rather than a regex of its own.
       *
       * The regex this replaced was a fourth spelling of one rule, and it was
       * the case-sensitive one. It also shared the protocol-relative hole with
       * the other three: `//evil.test` starts with a slash, so it read as a
       * same-origin path and was a fully qualified link to somebody else's
       * server. See `./href` for the whole argument.
       */
      schema: z.string().trim().max(2000).refine(isSafeHref).optional(),
    } as const satisfies FieldDefinition;
  },

  colour(name: string, label: string, options: { hint?: string } = {}) {
    return {
      name,
      kind: 'colour',
      label,
      ...(options.hint ? { hint: options.hint } : {}),
      // Validated by the same predicate the brand form uses, so a section
      // cannot accept a value the theme would have refused.
      schema: z
        .string()
        .trim()
        .refine((value) => isColour(value))
        .optional(),
    } as const satisfies FieldDefinition;
  },
} as const;

/**
 * A preset list, in the shape `SectionDefinition.presets` wants.
 *
 * The FIRST entry is the default and has to be the band's current appearance.
 * `presets.ts` maps it to null so it emits no attribute, and `presets.test.ts`
 * asserts the two lists agree, so getting the order wrong is a build failure
 * rather than a shop that quietly changed shape on deploy.
 */
const looks = (...choices: ([string, string] | [string, string, 'held'])[]) =>
  choices.map(([value, label, held]) => ({
    value,
    label,
    ...(held ? { generatable: false } : {}),
  }));

/**
 * A setting added for the theme round, offered to the editor at once and held
 * back from the generators until a prompt explains it. See
 * `FieldDefinition.generatable`.
 */
function held<T extends FieldDefinition>(definition: T): T {
  return { ...definition, generatable: false };
}

/** How fast a marquee runs. Named rather than numeric: seconds are not a choice. */
const SPEEDS: readonly FieldChoice[] = [
  { value: 'slow', label: 'Slow' },
  { value: 'steady', label: 'Steady' },
  { value: 'quick', label: 'Quick' },
];

/**
 * The small line above a heading.
 *
 * One field, one rule, and it is the highest ratio thing in this file: an
 * eyebrow above the title is on essentially every well-designed shop front and
 * was on none of these. It costs nothing else -- `text` is translatable by the
 * kind filter and generatable by the model schema, both without being told.
 *
 * Sixty characters. It is a label rather than a sentence, and a kicker long
 * enough to wrap is a subheading somebody put in the wrong place.
 */
const KICKER = field.text('kicker', 'Small line above the heading', { max: 60 });

/** The three settings the original five sections had, named once. */
const HEADING = field.text('heading', 'Heading');
const BODY = field.richtext('body', 'Text');
const LIMIT = field.number('limit', 'How many to show', { min: 1, max: 48, fallback: 24 });

/**
 * The ground one band sits on.
 *
 * The whole palette has always been one `:root` block, so a page was one colour
 * from the header to the footer however good the seven colours were. A shop that
 * goes from a paper hero to an inverted story band to an accent-flooded closer
 * reads as art directed; the same palette laid flat reads as a template. This is
 * the setting that buys that, and it buys it per band because rhythm is a
 * property of the sequence rather than of any one band.
 *
 * ## Five grounds, and every one of them already checked
 *
 * Each value reuses a pair `readPalette` verifies, which is what makes this safe
 * rather than a new way to ship unreadable text. `raised` is the surface, whose
 * pair with `fg` is checked. `tint` is the derived accent-soft, a twelfth of the
 * accent mixed into the page, so it sits beside `bg`. `inverse` swaps `fg` and
 * `bg`, and a contrast ratio is symmetric, so an inverted band is exactly as
 * legible as the page it inverts. `accent` is the accent with its own
 * foreground, which is the button pair. `base` is the page and emits nothing.
 *
 * A sixth ground mixing the accent into the ink was cut for precisely this
 * reason: nothing in the palette check covers it.
 *
 * Not generatable, on purpose. A model is never asked for grounds: a generated
 * direction gets them after the model, from its stance's rhythm, under rules
 * that keep a page paced rather than striped. See `withRhythm` in
 * packages/ai/src/looks/rhythm.ts.
 */
const SCHEME = field.select(
  'scheme',
  'The ground this band sits on',
  [
    { value: 'base', label: 'The page' },
    { value: 'raised', label: 'Raised, like a card' },
    { value: 'tint', label: 'A tint of your accent' },
    { value: 'inverse', label: 'Inverted' },
    { value: 'accent', label: 'Your accent' },
    /*
     * The second accent and its own foreground, a pair `readPalette` checks
     * whenever a palette carries one. A palette without one draws this as
     * `accent`, so the choice is never a band with no colours.
     */
    { value: 'accent2', label: 'Your second accent' },
  ],
  {
    fallback: 'base',
    hint: 'Anything but the page reaches the edges of the column and sets the band apart from the ones around it.',
    generatable: false,
  },
);

/**
 * A heading set to fill its band, line by line.
 *
 * The page writes how many characters the longest line holds
 * (`--sw-fit-chars`) and the stylesheet sizes the line from the face's own
 * measured advance, so a short word runs edge to edge in any face and a long
 * one comes down to fit. Off unless chosen, and off draws exactly what the band
 * drew before it existed. See "Type that fits" in `sections.css`.
 */
const FIT = held(
  field.boolean('fit', 'Fit the large words to the width', {
    fallback: false,
    hint: 'Each line set as wide as the band. For a few short words; a line break starts a new line.',
  }),
);

/**
 * The outline a picture is cut to.
 *
 * `plain` is the picture's own rectangle and emits nothing, so a band nobody
 * has shaped draws the picture it always drew. The rest are a mask or a radius
 * in the stylesheet, never a second picture, so a shape costs no bytes and
 * crops nothing a shopper cannot see by other means.
 */
const SHAPE_LABELS: Readonly<Record<PictureShape, string>> = {
  plain: 'As it is',
  arch: 'An arch',
  circle: 'A circle',
  pill: 'A pill',
  blob: 'A soft blob',
  ticket: 'A ticket with notched sides',
  torn: 'Torn paper',
};

const SHAPES: readonly FieldChoice[] = PICTURE_SHAPES.map((value) => ({
  value,
  label: SHAPE_LABELS[value],
}));

const SHAPE = field.select('shape', 'The shape of the picture', SHAPES, {
  fallback: 'plain',
  generatable: false,
});

/**
 * What a section needs fetched before it can render.
 *
 * Declared rather than fetched, which is the whole point. The storefront's home
 * page has always batched by reading the section list first and asking for the
 * largest limit any product band wanted, so that "a merchant who adds a second
 * product band does not double the queries". That batching was hand-written
 * against five known types and does not survive a wider vocabulary: twenty-six
 * components each fetching their own data is an N+1 on every page of every
 * shop, and it arrives as a gradual slowdown nobody can attribute to anything.
 *
 * So a section says what it needs and the renderer decides how to get it. The
 * coalescing below reproduces exactly what the home page did by hand, and
 * `dataPlanFor` is the only place that arithmetic now lives.
 */
export type DataNeed =
  | { resource: 'products'; limit: number }
  | { resource: 'collections' }
  | { resource: 'product'; handle: string }
  | { resource: 'collection'; handle: string; limit: number }
  | { resource: 'articles'; limit: number }
  /** Reviews of whatever product this page is about. */
  | { resource: 'reviews'; limit: number }
  /** What else a shopper looking at this product might want. */
  | { resource: 'related'; limit: number }
  /**
   * Products of whatever collection this page is about.
   *
   * A number rather than a handle, on exactly the terms `reviews` and `related`
   * already have: a `collection_products` band only exists on a collection
   * page, and that page knows which collection it is. One template therefore
   * serves every category in the shop, which is the whole point -- a merchant
   * arranges "a category page" once rather than four hundred times.
   */
  | { resource: 'thisCollection'; limit: number }
  /**
   * Posts of whatever blog index this page is about.
   *
   * The blog half of `thisCollection`, and added on 2026-09-12 for a reason
   * worth recording: `article_list` had declared a `limit` since it was written
   * and nothing read it. Its branch renders the posts the route resolved, and
   * the route asked for the fetch's own default, so a merchant could set "how
   * many" to any number between 1 and 48 and always get twelve.
   *
   * Slicing in the branch would have been the wrong fix twice over. The index is
   * paginated with a keyset cursor, so a band that showed twelve of twenty
   * fetched would strand eight posts between pages. And it would put the size of
   * a page in two places. This is the arrangement `PageSubject.collection`
   * already argues for: "the band declares the limit, the route reads
   * `plan.thisCollectionLimit` and asks for that many", so the registry stays
   * the single place a band says what it needs and the route stays the single
   * place a cursor is understood.
   */
  | { resource: 'thisBlog'; limit: number }
  /** Bands contributed by installed apps. */
  | { resource: 'pluginBlocks' }
  /**
   * One section one installed app offers, placed by the merchant in the page
   * editor: an `app_block` band names the app by its handle and the section
   * by the handle its manifest declares.
   */
  | { resource: 'appSection'; app: string; section: string }
  /**
   * What installed apps say at the top of the collection this page is about:
   * a size guide for a range, a note about a season. Page context like
   * `thisCollection`, so the band names no collection and the page says which.
   */
  | { resource: 'thisCollectionBlocks' }
  /**
   * The pieces the merchant paired with whatever product this page is about,
   * that product first. Page context like `reviews` and `related`.
   */
  | { resource: 'styledWith'; limit: number };

/** What one page render has to fetch, after every section has been asked. */
export interface DataPlan {
  /** The largest limit any product section asked for. Zero means fetch nothing. */
  productLimit: number;
  /** Whether any section on the page shows a collection list. */
  collections: boolean;
  /** Named products, deduped, for the bands that feature one. */
  productHandles: string[];
  /** Named collections and the largest limit asked of each. */
  collectionHandles: { handle: string; limit: number }[];
  /** The largest limit any blog band asked for. Zero means fetch nothing. */
  articleLimit: number;
  /**
   * The largest limit any reviews band asked for. Zero means fetch nothing.
   *
   * Resolved against whatever product the page is about rather than against a
   * handle a merchant typed, which is why it is a number here and not a list.
   * A `reviews` band only exists on a product page, and that page knows which
   * product it is.
   */
  reviewLimit: number;
  /** The largest limit any related band asked for. Same page-context rule. */
  relatedLimit: number;
  /** The most pieces any styled-with band asked for. Same page-context rule. */
  styledLimit: number;
  /** The largest limit any band asked of the collection this page is about. */
  thisCollectionLimit: number;
  /** And of the blog index it is about. Zero means the route's own default. */
  thisBlogLimit: number;
  /** Whether any band on the page shows an installed app's markup. */
  pluginBlocks: boolean;
  /** Each app section a band on the page names, deduped by app and handle. */
  appSections: { app: string; section: string }[];
  /** Whether a band draws apps' markup for the collection this page is about. */
  thisCollectionBlocks: boolean;
  /**
   * Every picture the page refers to, deduped.
   *
   * Collected from the field kinds rather than declared by each section, which
   * is the difference between one media read per page and one per picture. A
   * gallery of twelve images and a hero above it are thirteen ids and a single
   * query, and no section author has to remember to say so.
   */
  mediaIds: string[];
}

export interface SectionDefinition {
  readonly type: string;
  /** What a merchant is offered in the editor. */
  readonly label: string;
  /** The sentence under the label. Says what the section does, not what it is. */
  readonly hint: string;
  /**
   * The settings, as a flat list merged onto `{ type }`.
   *
   * Flat rather than nested under a `settings` key, and that is a compatibility
   * decision rather than a stylistic one. Every layout already stored on the
   * platform is an array of `{ type, heading?, body?, limit? }`. Nesting would
   * make all of them fail to parse, and a layout that fails to parse falls back
   * to the platform default, so the migration would present as every existing
   * shop's home page silently reverting on deploy.
   *
   * A list of described fields rather than a bare Zod object, because the
   * editor has to draw a control for each one and a schema alone cannot say
   * whether a string is a sentence, a URL or a product handle.
   */
  readonly settings: readonly FieldDefinition[];
  /** Where this section may be placed. */
  readonly pages: readonly PageType[];
  /**
   * The looks this band comes in, as a list of choices.
   *
   * Sugar over a `select` named `preset`: `DEFINITIONS` generates the field
   * from this, and from that point on it is an ordinary setting. Which is the
   * whole argument for doing it this way rather than adding a `preset` FIELD
   * KIND. `section-fields.tsx` already draws a `select` from its choices and
   * `modelField` already maps one to a `z.enum`, so a preset declared here gets
   * an editor control and a place in the AI schema with no change in either
   * app. A new kind would be, in this file's own words, "two pieces of work in
   * two apps and a deliberate act" -- for exactly the control that exists.
   *
   * Declared separately from `settings` rather than written out as a select in
   * each section, so `sectionDefinitionViews` can project it as a first-class
   * thing when the editor wants to draw a picker rather than a dropdown, and so
   * a test can assert every value here has CSS behind it.
   *
   * The FIRST entry is the default and must render exactly what the band
   * renders today. `presets.ts` maps it to no axes at all, so a band nobody has
   * re-presetted emits no attribute and its markup does not change.
   */
  readonly presets?: readonly FieldChoice[];
  /**
   * Repeatable children, for the sections that have them.
   *
   * Blocks are what stop the vocabulary exploding. Without them, "up to six
   * questions" is either six pairs of numbered settings — `question1`,
   * `answer1`, `question2` — or six near-identical section types, and both are
   * a merchant counting slots instead of adding a row.
   *
   * They live under a `blocks` key rather than flattened into the settings,
   * which is safe for the same reason the settings are flat: no layout stored
   * today has a `blocks` key, so nothing already written changes meaning.
   */
  readonly blocks?: BlockDefinition;
  /** What it needs fetched, given its own settings. */
  readonly needs?: (section: Record<string, unknown>) => DataNeed[];
  /**
   * What this band means, for the readers that cannot see it.
   *
   * The third projection of the same declaration, beside `needs` and
   * `requires`, and the one that pays for having no template language at all.
   *
   * A shop front is read by three audiences and only one of them has eyes. A
   * search crawler and a shopping agent read the HTML, and what they can do
   * with it depends entirely on whether the meaning survived the rendering. On
   * a platform where a merchant writes markup, it does not: a hand-built
   * accordion of questions is a pile of divs, and the only way to tell a
   * machine it is a list of answers is to ask the merchant to also write
   * structured data, which nobody does.
   *
   * Here the band already knows what it is. A `faq` is questions and answers
   * because the registry says so, so the same act that put it on the page can
   * emit the markup that says so, and neither the merchant nor the model that
   * wrote it had to know this existed.
   *
   * Returns null where there is nothing honest to say, which is most bands most
   * of the time. Two deliberate absences are worth naming. `testimonials` emits
   * nothing, because `Review` markup for quotes the merchant wrote themselves
   * is a self-serving review and search engines penalise exactly that.
   * `policy_badges` emits nothing, because `MerchantReturnPolicy` wants a
   * return window and a fee that the band does not carry, and filling them in
   * would be inventing a commitment on the merchant's behalf.
   */
  readonly jsonLd?: (section: Record<string, unknown>) => Record<string, unknown> | null;
  /**
   * Materials without which this band renders as nothing.
   *
   * The sibling of `needs`. That one says what to fetch for a section a
   * merchant placed; this one says what a shop must already own before the
   * generator may place it at all.
   *
   * The distinction it draws is between a band that merely looks better with a
   * picture and a band that *is* pictures. A hero with no image is a large
   * heading, which is a real design and a common one. A gallery with no images
   * is an empty frame, and a merchant shown one on a generated shop concludes
   * the generator is broken rather than that their media library is empty.
   *
   * Named in field kinds rather than in prose so the check stays mechanical:
   * the generator is handed what the shop has, and a section joins or does not
   * join on its own declaration.
   */
  readonly requires?: readonly FieldKind[];
  /**
   * Keeps this band away from the shop generator, whatever its settings allow.
   *
   * The mechanical rule below offers a section to the generator when every
   * setting it has is words or a number. That is necessary and not sufficient,
   * because "can a model type into this" and "has a model anything true to say
   * here" are different questions, and only the second one matters to a
   * merchant reading a generated shop.
   *
   * Three ways the answer is no even when the fields are fillable: the band is
   * about a shopper's history and a new shop has none, it is about installed
   * apps and a new shop has none, or filling it truthfully needs a fact nobody
   * has given us. The last is the prompt's own second rule — never invent a
   * commitment — and a countdown to a date a model chose is exactly that.
   */
  readonly neverGenerated?: true;
  /**
   * The server renders this band empty and the shopper's browser fills it in.
   *
   * Declared rather than inferred because nothing else in a definition can
   * tell: `recently_viewed` reads the shopper's own history from their
   * browser, so the page arrives with nothing where the band will be and
   * everything below it moves down when it draws. Above the fold that movement
   * is the layout shift Core Web Vitals counts, so the write path keeps such a
   * band below a phone's first screen (`performanceSafeSections` in core).
   */
  readonly rendersAfterLoad?: true;
}

export interface BlockDefinition {
  /** The block's own type name, unique within its section rather than globally. */
  readonly type: string;
  /** What the editor's add button says, without the verb. */
  readonly label: string;
  readonly settings: readonly FieldDefinition[];
  /**
   * How many a section may hold.
   *
   * Bounded for the same reason a page is bounded at twelve sections: past a
   * point it stops being a design decision and starts being a merchant who has
   * found a button. The bounds below are chosen per section from what the
   * layout can actually carry — four columns fit across a page, forty do not.
   */
  readonly max: number;
}

/** One repeatable child, as stored. Its own type plus whatever settings it carries. */
export interface LayoutBlock {
  type: string;
  /** Named on write, like a section, so its words can be translated. */
  id?: string | undefined;
  [setting: string]: unknown;
}

const ALIGNMENT = [
  { value: 'start', label: 'Left' },
  { value: 'centre', label: 'Centred' },
] as const;

const WIDTH = [
  { value: 'contained', label: 'Contained' },
  { value: 'full', label: 'Full width' },
] as const;

/**
 * Every section this platform builds.
 *
 * The first five are load-bearing by name: they are stored in the `layout`
 * column of every themed shop, and renaming one does not rename it there, it
 * makes that shop's section unparseable. The rest are new, and the shape of the
 * list is the argument for the whole approach — a section is a paragraph of
 * declaration, and the editor, the parser, the API and the AI generator all
 * read it rather than each keeping a version.
 *
 * Two rules held throughout. Nothing accepts markup except a `richtext` field,
 * which the HOST is responsible for sanitising on write -- see `FIELD_KINDS`
 * above, where the obligation and the reason it does not live here are set out.
 * And nothing that ships client JavaScript may be the only way to reach its
 * content, because a crawler and a shopping agent both read this markup and
 * neither runs script.
 *
 * A third rule decided what is *absent*, and it is the one worth stating.
 * Nothing appears in this list that the storefront cannot draw. A section a
 * merchant can place and that then renders nothing is worse than a section they
 * cannot place: the first looks like a shop that is broken, the second looks
 * like a platform that does not do that yet.
 *
 * So these were written and then taken out again, each waiting on something
 * real rather than on somebody getting round to it:
 *
 *   related_products   `product_relationships` is populated by the enrichment
 *                      graph, and nothing outside `packages/ai` reads it. Needs
 *                      a storefront read and a public route.
 *   recently_viewed    Lives in the shopper's own browser, so it needs a client
 *                      component and a story for what a crawler sees.
 *   contact_form       Needs a POST route that mails the support address, and a
 *                      rate limit, because a form that posts nowhere is a lie.
 *   countdown          Needs a client tick over server-rendered static text.
 *   article_body       Only means something once article pages render through a
 *                      template rather than through their own route.
 *   plugin_block       Wants the anchored slots and free placement to share one
 *                      renderer, which is its own piece of work.
 *   reviews            `publishedReviews` is keyed by product, so the band only
 *                      means anything on a product page, and product pages do
 *                      not render templates yet. See below.
 *
 * And one thing that is true of the whole list rather than of any entry.
 * `PAGE_TYPES` names ten pages and the model stores a template for each, but
 * only the home page *renders* one today. Wiring the other nine means each
 * route fetching its own sections and deciding what its built-in content
 * becomes, which is a route at a time rather than a flag. Until then a template
 * stored against `product` is data nothing reads, which is why the pages a
 * section declares are about where it *belongs* rather than about what is
 * currently drawn.
 */
export const SECTION_DEFINITIONS = [
  // The original five ----------------------------------------------------

  {
    type: 'intro',
    label: 'Your name and a line about the shop',
    hint: 'Leave the heading empty to use the shop name.',
    settings: [KICKER, HEADING, BODY, SCHEME],
    // Home only. An `h1` naming the shop belongs at the top of the shop, and a
    // second one on a product page is a worse document than none.
    pages: ['home'],
  },
  {
    type: 'assistant',
    label: 'The question box',
    hint: 'Where a shopper describes what they need. The heading is its placeholder text.',
    settings: [HEADING],
    // The pages where somebody is already looking for something and has not
    // found it. A shopper on a product page has found it.
    pages: ['home', 'search', 'collection', 'not_found'],
  },
  {
    type: 'products',
    label: 'A grid of products',
    // The catalogue as the shop lists it, which is by handle. This said "Newest
    // first", which it never was.
    hint: 'Everything for sale, A to Z.',
    settings: [KICKER, HEADING, LIMIT, SCHEME],
    presets: looks(
      ['grid', 'A grid'],
      ['rail', 'A row that scrolls sideways'],
      ['mosaic', 'Mixed sizes'],
      ['list', 'One per row'],
      ['bento', 'One large, the rest beside it'],
      ['index', 'A ruled index'],
      ['offset', 'Staggered columns'],
      /*
       * Four looks the twelve signed-off themes draw, added for the theme
       * round and held back from the generators (`FieldChoice.generatable`).
       * A carousel is a row with buttons, `::scroll-button` where the browser
       * has it and a row that scrolls where it does not. A marquee and a menu
       * draw the products as words: names and prices running past, or a
       * priced list with dotted leaders. A stack gives each product a row and
       * its picture room.
       */
      ['carousel', 'A row with buttons to move it', 'held'],
      ['marquee', 'Names and prices, scrolling', 'held'],
      ['menu', 'A priced list, like a menu', 'held'],
      ['stack', 'One per row, the picture large', 'held'],
    ),
    pages: ANY_PAGE,
    requires: ['product'],
    needs: (section) => [{ resource: 'products', limit: numberOr(section.limit, 24) }],
  },
  {
    type: 'collections',
    label: 'A grid of collections',
    hint: 'Useful for a shop with a few clear ranges.',
    settings: [
      KICKER,
      HEADING,
      /*
       * Its own limit rather than the shared `LIMIT`, whose fallback of 24
       * suits a product grid and never suited this band.
       *
       * `fallback` is documented as what the renderer uses when the merchant
       * left it alone, and the renderer has drawn twelve collection links since
       * this band was written while the editor printed 24 as the placeholder. A
       * merchant was shown one number and served another, and nothing could see
       * it: both sides read the field, so a check about whether a setting is
       * read at all passes either way.
       *
       * Twelve rather than moving the renderer to 24, because twelve is what
       * every shop has always been served and the registry is the half that was
       * wrong. No shop on the platform has a `collections` band stored, so
       * neither direction would have moved a page today; this one moves nothing
       * tomorrow either.
       */
      field.number('limit', 'How many to show', { min: 1, max: 48, fallback: 12 }),
      SCHEME,
    ],
    presets: looks(
      ['grid', 'A grid'],
      ['rail', 'A row that scrolls sideways'],
      ['tiles', 'Names over the pictures'],
      ['chips', 'A row of names'],
    ),
    pages: ANY_PAGE,
    requires: ['collection'],
    needs: () => [{ resource: 'collections' }],
  },
  {
    type: 'note',
    label: 'A band of text',
    hint: 'Delivery promise, returns, the story. Text only, and that is deliberate.',
    settings: [KICKER, HEADING, BODY, SCHEME],
    pages: ANY_PAGE,
  },

  // Content and layout ---------------------------------------------------

  {
    type: 'hero',
    label: 'A hero',
    hint: 'A picture, a large heading, and up to one button. The first thing a shopper sees.',
    settings: [
      KICKER,
      HEADING,
      field.text('subheading', 'Subheading', { max: 300 }),
      // 512 pixels: Kiln and Cloth's 600 pixel candlestick drawn as a 1280 pixel
      // poster met the bar in the third P8 contact sheet, and Editor Test Shop's
      // 320 pixel jacket showed its pixels.
      field.media('image', 'Background picture', { narrowest: 512 }),
      /*
       * A silent film over the picture, for a cover. Its address names the
       * `.mp4`; a `.webm` and a 720 pixel `-portrait.mp4` sit beside it, and
       * the band plays it only from the shop's own media host under the shop's
       * own id (`heroFilm` in core), so a merchant's typing cannot point a
       * shopper's browser anywhere else. The picture is still drawn and is what
       * a shopper sees first; the film starts after the page has loaded, and
       * never for a shopper who asked for less motion or less data.
       */
      held(
        field.url('video', 'A film over the picture', {
          hint: 'A short silent film from your own uploads. The picture shows first, and stays for anyone who asked for less motion.',
        }),
      ),
      field.text('ctaLabel', 'Button text', {
        max: 60,
        hint: 'Left empty with a link set, the button reads "Shop the range" in your shop\'s language.',
      }),
      field.url('ctaHref', 'Button link', {
        hint: 'A path like /collections/new, or a full https address.',
      }),
      field.select('align', 'Alignment', ALIGNMENT, { fallback: 'start' }),
      field.select('width', 'Width', WIDTH, { fallback: 'full' }),
      SCHEME,
      FIT,
    ],
    presets: looks(
      ['classic', 'A picture behind the words'],
      ['image_scrim', 'Full bleed, words over it'],
      ['split', 'Picture beside the words'],
      ['editorial', 'Words only, set large'],
      ['poster', 'The picture as a poster, the heading set huge'],
      ['cover', 'The picture across the whole screen, the words on it'],
    ),
    pages: ['home', 'collection', 'page', 'blog', 'search'],
  },
  {
    type: 'rich_text',
    label: 'Formatted text',
    hint: 'Headings, lists and links, unlike the plain band. Still no arbitrary markup.',
    settings: [
      KICKER,
      HEADING,
      field.richtext('body', 'Text'),
      field.select('align', 'Alignment', ALIGNMENT, { fallback: 'start' }),
      SCHEME,
    ],
    pages: ANY_PAGE,
  },
  {
    type: 'image_with_text',
    label: 'A picture beside text',
    hint: 'The usual way to explain one thing at a time.',
    settings: [
      KICKER,
      field.media('image', 'Picture'),
      HEADING,
      BODY,
      field.text('ctaLabel', 'Button text', { max: 60 }),
      field.url('ctaHref', 'Button link'),
      field.select(
        'imageSide',
        'Which side the picture sits on',
        [
          { value: 'start', label: 'Left' },
          { value: 'end', label: 'Right' },
        ],
        { fallback: 'start' },
      ),
      SCHEME,
      SHAPE,
    ],
    presets: looks(
      ['split', 'Side by side'],
      ['overlap', 'Words over the picture'],
      ['stacked', 'Picture above the words'],
      ['bleed', 'The picture to the edge of the screen'],
      ['sticky', 'The picture stays while the words scroll'],
      /*
       * The picture cut to a shape and set on a block of the accent, the
       * colour-block opening of the signed-off Primary comp. The shape is the
       * band's own (an arch when it has none), and the words sit on the accent
       * in its own foreground, the pair every button already uses.
       */
      ['masked', 'The picture in a shape on a block of colour', 'held'],
    ),
    pages: ANY_PAGE,
    requires: ['media'],
  },
  {
    type: 'multicolumn',
    label: 'Columns',
    hint: 'Two to four short blocks side by side. Delivery, returns, guarantee.',
    settings: [KICKER, HEADING, SCHEME],
    blocks: {
      type: 'column',
      label: 'column',
      max: 4,
      settings: [field.media('icon', 'Picture'), HEADING, BODY, field.url('href', 'Link')],
    },
    presets: looks(
      ['columns', 'Columns'],
      ['numbered', 'Numbered steps'],
      ['rail', 'A row that scrolls sideways'],
    ),
    pages: ANY_PAGE,
  },
  {
    type: 'gallery',
    label: 'A row of pictures',
    hint: 'Up to six. Each one can link somewhere.',
    settings: [KICKER, HEADING, SCHEME, SHAPE],
    blocks: {
      type: 'image',
      label: 'picture',
      max: 12,
      settings: [
        field.media('image', 'Picture'),
        field.text('alt', 'Description for a screen reader', { max: 300 }),
        field.url('href', 'Link'),
      ],
    },
    presets: looks(
      ['grid', 'A grid'],
      ['rail', 'A row that scrolls sideways'],
      ['mosaic', 'Mixed sizes'],
      ['bleed', 'Edge to edge'],
      ['offset', 'Staggered'],
    ),
    pages: ANY_PAGE,
    requires: ['media'],
  },
  {
    type: 'video',
    label: 'A video',
    hint: 'Linked rather than embedded, so no third party gets a script on your shop.',
    settings: [
      /*
       * Declared 2026-09-12, because the renderer had been reading one since
       * before this band was written and no merchant could set it. The mirror
       * image of the four bands that declared a kicker and drew none, and the
       * same loss: the platform's own markup was ready for words nobody could
       * type. Add-only, so no stored band changes and nothing renders
       * differently until a merchant fills it in.
       */
      KICKER,
      HEADING,
      field.media('poster', 'Still picture'),
      field.url('href', 'Where the video plays', {
        hint: 'The page on YouTube, Vimeo or your own site. Opens in a new tab.',
      }),
      BODY,
    ],
    pages: ANY_PAGE,
    // There is no video for the model to link to. `href` is where the video
    // plays and a generated one would be a guess at somebody else's URL, so the
    // band could only ever render a still with a dead link behind it.
    neverGenerated: true,
  },
  {
    type: 'banner',
    label: 'A strip',
    hint: 'One line across the page. A sale, a delivery cut-off, a notice.',
    settings: [
      KICKER,
      field.text('body', 'Text', { max: 300 }),
      field.url('href', 'Link'),
      field.colour('background', 'Background colour'),
      field.colour('foreground', 'Text colour'),
    ],
    presets: looks(['strip', 'A strip'], ['ticker', 'Scrolling continuously']),
    // And the shop-wide strip, above the header on every page.
    pages: [...ANY_PAGE, 'shop'],
  },
  {
    type: 'spacer',
    label: 'A gap',
    hint: 'Room between two bands that would otherwise crowd each other.',
    settings: [field.number('size', 'How much room', { min: 1, max: 8, fallback: 4 })],
    pages: ANY_PAGE,
  },
  {
    type: 'divider',
    label: 'A line',
    hint: 'A rule across the page.',
    settings: [],
    pages: ANY_PAGE,
  },

  // Commerce -------------------------------------------------------------

  {
    type: 'featured_product',
    label: 'One product',
    hint: 'A single product, given room.',
    settings: [
      KICKER,
      HEADING,
      field.reference(
        'product',
        'product',
        'Which product',
        'Its handle, as it appears in the address bar.',
      ),
      BODY,
      field.boolean('buyHere', 'Let shoppers buy from this band', { fallback: false }),
    ],
    pages: ANY_PAGE,
    requires: ['product'],
    needs: (section) =>
      typeof section.product === 'string' && section.product.length > 0
        ? [{ resource: 'product', handle: section.product }]
        : [],
  },
  {
    type: 'featured_collection',
    label: 'Products from one collection',
    hint: 'A grid drawn from a range you choose rather than from everything.',
    settings: [
      KICKER,
      HEADING,
      field.reference('collection', 'collection', 'Which collection'),
      field.number('limit', 'How many to show', { min: 1, max: 48, fallback: 8 }),
    ],
    pages: ANY_PAGE,
    requires: ['collection'],
    needs: (section) =>
      typeof section.collection === 'string' && section.collection.length > 0
        ? [
            {
              resource: 'collection',
              handle: section.collection,
              limit: numberOr(section.limit, 8),
            },
          ]
        : [],
  },
  {
    type: 'collection_list',
    label: 'Chosen collections',
    hint: 'Name the ranges you want shown, rather than showing all of them.',
    settings: [
      KICKER,
      HEADING,
      field.reference('first', 'collection', 'First collection'),
      field.reference('second', 'collection', 'Second collection'),
      field.reference('third', 'collection', 'Third collection'),
      field.reference('fourth', 'collection', 'Fourth collection'),
      SCHEME,
    ],
    presets: looks(
      ['grid', 'A grid'],
      ['rail', 'A row that scrolls sideways'],
      ['tiles', 'Names over the pictures'],
      ['chips', 'A row of names'],
    ),
    pages: ANY_PAGE,
    requires: ['collection'],
    needs: () => [{ resource: 'collections' }],
  },
  /*
   * Ranges side by side, each with its products listed under its name.
   *
   * From the signed-off "Layer by layer" comp, which lays a hill kit out as base
   * layer, mid layer and shell in three columns. Grouped by COLLECTION rather
   * than by product type, because a type is a label the catalogue import wrote
   * (the test shop has thirteen products and thirteen types) while a collection
   * is a grouping the merchant chose, which is what a column is.
   *
   * Each setting named rather than read in a loop, so the renderer reads
   * `section.first` and the registry check can see it does.
   *
   * Never generated, for now. Which ranges sit side by side is the merchant's
   * judgement about their own catalogue, and offering it would put three more
   * collection lists into the schema a merchant pays for on every call of a
   * round. A direction that wants it composes it deterministically.
   */
  {
    type: 'collection_columns',
    label: 'Collections side by side',
    hint: 'Two or three ranges in columns, each listing its products under its name.',
    settings: [
      KICKER,
      HEADING,
      field.reference('first', 'collection', 'First column'),
      field.reference('second', 'collection', 'Second column'),
      field.reference('third', 'collection', 'Third column'),
      field.number('limit', 'Products in each column', { min: 1, max: 8, fallback: 4 }),
    ],
    pages: ANY_PAGE,
    requires: ['collection'],
    neverGenerated: true,
    needs: (section) => [
      // The titles, which a column heads itself with.
      { resource: 'collections' },
      ...[section.first, section.second, section.third]
        .filter((handle): handle is string => typeof handle === 'string' && handle.length > 0)
        .map((handle) => ({
          resource: 'collection' as const,
          handle,
          limit: numberOr(section.limit, 4),
        })),
    ],
  },

  // Trust ----------------------------------------------------------------

  {
    type: 'faq',
    label: 'Questions and answers',
    hint: 'Up to six. Each opens on click and is readable with script off.',
    settings: [KICKER, HEADING, SCHEME],
    blocks: {
      type: 'question',
      label: 'question',
      max: 20,
      settings: [
        field.text('question', 'Question', { max: 300 }),
        field.richtext('answer', 'Answer'),
      ],
    },
    presets: looks(
      ['list', 'One after another'],
      ['two_column', 'Two columns'],
      ['sticky', 'The heading stays beside the questions'],
    ),
    pages: ANY_PAGE,
    jsonLd: (section) => {
      const blocks = Array.isArray(section.blocks) ? section.blocks : [];

      const answered = blocks.flatMap((block) => {
        const entry = block as Record<string, unknown>;
        const question = typeof entry.question === 'string' ? entry.question.trim() : '';
        const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
        // Both halves or neither. A `Question` with no `acceptedAnswer` is
        // invalid markup, and an entry a merchant has not finished writing is
        // exactly the one most likely to be missing its answer.
        if (question === '' || answer === '') return [];

        return [
          {
            '@type': 'Question',
            name: question,
            acceptedAnswer: { '@type': 'Answer', text: answer },
          },
        ];
      });

      if (answered.length === 0) return null;

      return { '@type': 'FAQPage', mainEntity: answered };
    },
  },
  {
    type: 'testimonials',
    label: 'What customers said',
    hint: 'Up to four quotes. Yours to write, unlike the reviews band.',
    settings: [KICKER, HEADING, SCHEME],
    blocks: {
      type: 'testimonial',
      label: 'quote',
      max: 12,
      settings: [
        field.text('quote', 'What they said', { max: 600 }),
        field.text('attribution', 'Who said it', { max: 120 }),
      ],
    },
    presets: looks(
      ['grid', 'A grid'],
      ['rail', 'A row that scrolls sideways'],
      ['marquee', 'Scrolling continuously'],
    ),
    pages: ANY_PAGE,
    // Quotes the merchant writes, says the hint, and that is the point. A model
    // filling this invents what a customer said, which is the prompt's first
    // rule broken in the one place a shopper is most entitled to rely on it.
    // Fabricated praise is a fake review whoever typed it.
    neverGenerated: true,
  },
  {
    type: 'logo_list',
    label: 'A row of logos',
    hint: 'Brands you stock, press you appeared in, badges you hold.',
    settings: [KICKER, HEADING],
    blocks: {
      type: 'logo',
      label: 'logo',
      max: 12,
      settings: [
        field.media('image', 'Logo'),
        field.text('alt', 'Whose logo this is', { max: 200 }),
        field.url('href', 'Link'),
      ],
    },
    presets: looks(
      ['grid', 'A grid'],
      ['rail', 'A row that scrolls sideways'],
      ['marquee', 'Scrolling continuously'],
    ),
    pages: ANY_PAGE,
    // A logo list asserts a relationship with a named third party. The model
    // has no way to know which brands a shop actually stocks or partners with,
    // and picking product photographs to stand in as logos states something
    // about other people's businesses that nobody checked.
    neverGenerated: true,
  },
  {
    type: 'policy_badges',
    label: 'Your promises',
    hint: 'Delivery, returns and contact, each linking to the policy that says so.',
    settings: [
      KICKER,
      HEADING,
      field.boolean('showShipping', 'Delivery', { fallback: true }),
      field.boolean('showReturns', 'Returns', { fallback: true }),
      field.boolean('showContact', 'Contact', { fallback: true }),
    ],
    pages: ANY_PAGE,
  },

  // Content marketing ----------------------------------------------------

  {
    type: 'blog_posts',
    label: 'Recent posts',
    hint: 'The latest from a blog you name.',
    settings: [
      KICKER,
      HEADING,
      field.reference('blog', 'blog', 'Which blog'),
      field.number('limit', 'How many', { min: 1, max: 12, fallback: 3 }),
    ],
    presets: looks(
      ['list', 'One after another'],
      ['cards', 'Cards'],
      ['rail', 'A row that scrolls sideways'],
    ),
    pages: ANY_PAGE,
    requires: ['blog'],
    needs: (section) => [{ resource: 'articles', limit: numberOr(section.limit, 3) }],
  },
  {
    type: 'article_body',
    label: 'The post itself',
    hint: 'Where the writing goes on a post. Move it, do not remove it.',
    settings: [],
    // The one section whose content is the page rather than something placed on
    // it. A post template without it is a post nobody can read.
    pages: ['article'],
  },
  {
    type: 'contact_form',
    label: 'A contact form',
    hint: 'Goes to your support address. Works without script, and is rate limited.',
    settings: [
      HEADING,
      BODY,
      field.text('buttonLabel', 'Button text', { max: 60 }),
      field.boolean('askSubject', 'Ask what it is about', { fallback: true }),
    ],
    pages: ANY_PAGE,
  },
  {
    type: 'newsletter_signup',
    label: 'A subscribe form',
    hint: 'Asks for an email address and sends it one email to confirm. Nobody is added to your list until they press the button in it.',
    settings: [HEADING, BODY, field.text('buttonLabel', 'Button text', { max: 60 })],
    pages: ANY_PAGE,
  },

  // Pages about one thing ------------------------------------------------
  //
  // These read the product or post the page is about rather than something the
  // merchant named, which is why they are confined to the pages that have one.
  // A `reviews` band on a home page has no product to review.

  {
    type: 'reviews',
    label: 'Reviews',
    hint: 'Published reviews of this product. Nothing appears until you approve it.',
    settings: [
      HEADING,
      field.number('limit', 'How many', { min: 1, max: 20, fallback: 5 }),
      field.boolean('showForm', 'Let a customer write one', { fallback: true }),
    ],
    pages: ['product'],
    needs: (section) => [{ resource: 'reviews', limit: numberOr(section.limit, 5) }],
  },
  {
    type: 'related_products',
    label: 'Related products',
    hint: 'What shoppers buy together first, then more like it from your own shop.',
    settings: [HEADING, field.number('limit', 'How many', { min: 1, max: 12, fallback: 4 })],
    pages: ['product'],
    needs: (section) => [{ resource: 'related', limit: numberOr(section.limit, 4) }],
  },
  {
    /*
     * The pieces worn with this one, as a look: this product first, then the
     * ones the merchant paired with it ("goes with" in the admin, a
     * `compatible_with` pairing of their own), with what the look costs
     * together and one link that puts every piece in the basket. Only the
     * merchant's own pairings, never one a job worked out: a look is a
     * styling decision, and a counted guess would put the wrong coat with a
     * dress. With no pairings the band draws nothing.
     */
    type: 'styled_with',
    label: 'Styled with',
    hint: 'The pieces you paired with this one, what the look costs and a link that adds it all. Pair pieces on the product in your admin.',
    settings: [
      KICKER,
      HEADING,
      BODY,
      field.number('limit', 'How many pieces beside this one', { min: 1, max: 6, fallback: 3 }),
    ],
    pages: ['product'],
    // A pairing is the merchant's word on two of their products; a model has
    // nothing true to put here.
    neverGenerated: true,
    needs: (section) => [{ resource: 'styledWith', limit: numberOr(section.limit, 3) }],
  },

  // Bands the browser finishes -------------------------------------------
  //
  // Both ship script, and both render something useful without it. That is the
  // rule rather than a nicety: a crawler and a shopping agent read this markup
  // and neither runs JavaScript.

  {
    type: 'recently_viewed',
    label: 'Recently viewed',
    hint: 'What this shopper looked at, read from their own browser. New visitors see nothing.',
    settings: [HEADING, field.number('limit', 'How many', { min: 1, max: 12, fallback: 4 })],
    pages: ['product', 'collection', 'cart', 'home', 'search'],
    // Nothing to show on a shop nobody has browsed yet, which is every shop
    // the generator writes.
    neverGenerated: true,
    rendersAfterLoad: true,
  },
  {
    type: 'countdown',
    label: 'A countdown',
    hint: 'Counts down to a moment you name, and shows the date itself where script cannot run.',
    settings: [
      KICKER,
      HEADING,
      field.text('endsAt', 'Ends at', {
        max: 40,
        hint: 'A date and time, like 2026-12-24T17:00:00Z.',
      }),
      BODY,
      field.text('expiredBody', 'What it says afterwards', { max: 300 }),
    ],
    pages: ANY_PAGE,
    // A deadline is a commitment, and the prompt's second rule forbids
    // inventing one. A model with no date to work from would pick a plausible
    // Friday, and the merchant would find out when it passed.
    neverGenerated: true,
  },

  // Platform -------------------------------------------------------------

  {
    type: 'plugin_block',
    label: 'An app',
    hint: 'A band from one of the apps you have installed.',
    settings: [
      KICKER,
      HEADING,
      field.text('plugin', 'Which app', {
        max: 200,
        hint: 'The app’s handle. Leave empty to show every installed app that offers a band.',
      }),
    ],
    pages: ANY_PAGE,
    needs: () => [{ resource: 'pluginBlocks' }],
    // A new shop has no apps installed, so this can only ever render nothing.
    neverGenerated: true,
  },
  {
    /*
     * One section an installed app offers, wherever the merchant puts it.
     *
     * `plugin_block` draws whatever the apps answer in a slot; this names one
     * app and one of the sections its approved release declares, and the page
     * asks that app for that section alone. The editor offers the installed
     * apps' sections as one choice, which sets both handles. A section whose
     * app has gone draws nothing, never an error.
     */
    type: 'app_block',
    label: 'A section from an app',
    hint: 'One section an app you have installed offers, placed wherever you want it.',
    settings: [
      KICKER,
      HEADING,
      field.text('app', 'Which app', { max: 63, hint: 'The app’s handle.' }),
      field.text('section', 'Which section', {
        max: 32,
        hint: 'The handle of one of the sections the app offers.',
      }),
    ],
    pages: ANY_PAGE,
    needs: (section) => {
      const app = typeof section.app === 'string' ? section.app.trim() : '';
      const handle = typeof section.section === 'string' ? section.section.trim() : '';
      return app && handle ? [{ resource: 'appSection', app, section: handle }] : [];
    },
    // A new shop has no apps installed, so this can only ever render nothing.
    neverGenerated: true,
  },

  {
    type: 'cta_bar',
    label: 'One thing to do',
    hint: 'A line and a button. On a landing page, the thing the page is for.',
    settings: [
      KICKER,
      HEADING,
      BODY,
      field.text('buttonLabel', 'Button text', { max: 60 }),
      field.url('href', 'Where it goes'),
      field.boolean('sticky', 'Keep it on screen as they scroll', { fallback: false }),
      SCHEME,
    ],
    /*
     * `sticky` is CSS and nothing else -- `position: sticky` on the band, which
     * needs no script and no measurement. A JavaScript sticky bar is the
     * version of this that breaks on a phone keyboard, and the whole storefront
     * ships four client components on purpose.
     */
    pages: ANY_PAGE,
  },

  // A blog post, beyond its writing ---------------------------------------

  /*
   * `article_body` has been the whole of a post since posts had templates.
   * These five are what separates a post that reads like a page from one that
   * reads like a magazine, and every one of them renders from the post itself
   * rather than from anything a merchant has to fill in twice.
   */
  {
    type: 'article_meta',
    label: 'Byline and date',
    hint: 'Who wrote it, when, and how long it takes to read.',
    settings: [
      field.boolean('showAuthor', 'Show the byline', { fallback: true }),
      field.boolean('showReadingTime', 'Show how long it takes to read', { fallback: true }),
    ],
    pages: ['article'],
  },
  {
    type: 'article_toc',
    label: 'What is in this post',
    hint: 'Built from your own headings. Nothing to fill in.',
    settings: [HEADING],
    pages: ['article'],
  },
  {
    type: 'article_share',
    label: 'Share links',
    hint: 'Plain links. No third-party script and no tracking.',
    settings: [HEADING],
    pages: ['article'],
  },
  {
    type: 'article_related',
    label: 'More like this',
    hint: 'Other posts in this blog, newest first.',
    settings: [KICKER, HEADING, field.number('limit', 'How many', { min: 1, max: 6, fallback: 3 })],
    pages: ['article'],
    needs: (section) => [{ resource: 'articles', limit: numberOr(section.limit, 3) }],
  },
  {
    type: 'author_bio',
    label: 'About the author',
    hint: 'The byline, their note and their picture, from the post itself.',
    settings: [],
    pages: ['article'],
  },

  // The pages that were templates with nothing in them --------------------

  {
    type: 'page_body',
    label: 'The page itself',
    hint: 'Where the writing goes. Move it, do not remove it.',
    settings: [],
    /*
     * The `article_body` argument, made a second time.
     *
     * A CMS page's prose is built-in content, and turning it into a band is
     * what lets a merchant put anything ABOVE it -- a hero on an About page, a
     * product grid under a lookbook. `DEFAULT_PAGE` is this band alone, so a
     * page nobody has composed renders the prose the route used to render
     * inline, and no row is backfilled.
     */
    pages: ['page'],
  },
  {
    type: 'article_list',
    label: 'The posts',
    hint: 'Recent posts in this blog, newest first.',
    settings: [
      KICKER,
      HEADING,
      field.number('limit', 'How many', { min: 1, max: 48, fallback: 12 }),
    ],
    presets: looks(
      ['list', 'One after another'],
      ['cards', 'Cards'],
      ['rail', 'A row that scrolls sideways'],
    ),
    /*
     * The page size, which the route asks for. See `thisBlog` on `DataNeed`.
     *
     * The fallback is twelve and so is `DEFAULT_ARTICLE_LIMIT` in
     * `content/articles.ts`, which is why a shop that has set nothing fetches
     * exactly what it fetched before this existed.
     */
    needs: (section) => [{ resource: 'thisBlog', limit: numberOr(section.limit, 12) }],
    pages: ['blog'],
  },

  // The category page ----------------------------------------------------

  /*
   * A collection page is a template now, and these two are what it is made of.
   *
   * The alternative was the product page's model: render the built-in content,
   * then append whatever the merchant arranged below it. That is right for a
   * product page, where the thing being sold must come first and a mis-click
   * is "one mis-click from a shop that cannot sell anything". It is wrong here,
   * because the one thing a category page needs that it has never had is a
   * hero and some merchandising copy ABOVE the grid -- which append-below makes
   * impossible by construction.
   *
   * So the built-in content becomes two bands, and `DEFAULT_COLLECTION` is
   * exactly those two in exactly that order. A shop that arranges nothing
   * renders the page it rendered before this existed.
   */
  {
    type: 'collection_header',
    label: 'The category itself',
    hint: 'Its name, the trail above it, and your description. Move it, do not remove it.',
    settings: [],
    // Under the heading it draws whatever apps add to a collection's header,
    // so the page reads that slot before anything renders.
    needs: () => [{ resource: 'thisCollectionBlocks' }],
    pages: ['collection'],
  },
  {
    type: 'collection_products',
    label: 'The products in it',
    hint: 'The grid. Without this band a category page lists nothing.',
    settings: [
      KICKER,
      HEADING,
      field.number('limit', 'How many per page', { min: 4, max: 48, fallback: 24 }),
      /*
       * Filter and sort above the grid, worked out from what the shop has
       * recorded about its products. On unless a merchant turns it off, here
       * for every collection or on one collection's own page.
       */
      field.boolean('filters', 'Let shoppers filter and sort', { fallback: true }),
      SCHEME,
      /*
       * A campaign photograph set into the grid after its fourth product,
       * wider than a card, with a line and a link beside it: the way a fashion
       * house breaks up a page of products. Folio's grid photograph; base
       * draws it across the grid.
       */
      held(
        field.media('feature', 'A photograph set into the grid', {
          hint: 'Shown after the fourth product, wider than a card. Leave it empty for products only.',
        }),
      ),
      held(field.text('featureLine', 'A line beside the photograph', { max: 120 })),
      held(field.url('featureHref', 'Where the photograph links')),
    ],
    presets: looks(
      ['grid', 'A grid'],
      ['rail', 'A row that scrolls sideways'],
      ['mosaic', 'Mixed sizes'],
      ['list', 'One per row'],
      ['index', 'A ruled index'],
      ['offset', 'Staggered columns'],
      // The category page's half of the product grid's new looks: Force
      // Seven's bento and Counter's menu board, from the signed-off round two.
      ['bento', 'One large, the rest beside it', 'held'],
      ['menu', 'A priced list, like a menu', 'held'],
      ['stack', 'One per row, the picture large', 'held'],
    ),
    pages: ['collection'],
    needs: (section) => [{ resource: 'thisCollection', limit: numberOr(section.limit, 24) }],
  },

  // Bands added for the wider vocabulary -------------------------------

  /*
   * The six below exist because the registry could describe a shop's
   * ARRANGEMENT and not its character. A shop could have a hero, a grid and an
   * FAQ, and so could every other shop, and the result was that two generated
   * designs differed in colour and in nothing a person would call design.
   *
   * Each is content-only: no new `needs`, no new field kind, no new data plan.
   * That is deliberate for a first widening -- a band that reads a resource
   * nothing has fetched is a band that puts an N+1 on every page of every shop,
   * and adding one is worth doing after the ones that cannot.
   */
  {
    type: 'marquee',
    label: 'Scrolling words',
    hint: "A line of the shop's own phrases, moving. Type as texture.",
    settings: [field.select('speed', 'How fast', SPEEDS, { fallback: 'steady' }), SCHEME],
    blocks: {
      type: 'phrase',
      label: 'phrase',
      max: 12,
      settings: [field.text('text', 'The words', { max: 80 })],
    },
    pages: ANY_PAGE,
  },
  {
    type: 'manifesto',
    label: 'One sentence, set large',
    hint: 'What the shop believes, in its own voice. No attribution: this is you speaking.',
    settings: [
      KICKER,
      /*
       * A heading, declared 2026-09-12 because the renderer had always drawn
       * one.
       *
       * `sections.tsx` passes `heading={section.heading}` to `Band` for this
       * band, and nothing declared it, so the only route to a manifesto heading
       * was a generator writing a key the schema did not offer -- which is
       * exactly what one did, on two of three directions in a graded round, and
       * the band then rendered nothing because the branch returned null on an
       * empty `body`. Both halves are fixed: the field is declarable here and
       * the branch draws a manifesto that has any words at all.
       *
       * It suits the band as well as the markup. "One sentence, set large" is
       * the sentence; a line above it naming what the shop is saying is the same
       * eyebrow every other band gets.
       */
      HEADING,
      BODY,
      field.select('align', 'Alignment', ALIGNMENT, { fallback: 'start' }),
      SCHEME,
      FIT,
    ],
    /*
     * No attribution field, and that is what separates this from
     * `testimonials` and what makes it safe to generate. A quote with a name on
     * it is somebody's word; `testimonials` is `neverGenerated` because
     * "fabricated praise is a fake review whoever typed it". A shop speaking as
     * itself cannot be a fake review, so this one is generated freely.
     */
    pages: ANY_PAGE,
  },
  {
    type: 'promo_pair',
    label: 'Picture tiles or story panels',
    hint: 'Shop men, shop women. Or a run of full-width pictures, each with a line and a link.',
    settings: [KICKER, HEADING, SCHEME],
    /*
     * Six rather than three since 2026-10-03, when the band learned to draw a
     * run of panels: a fashion house's front page is half a dozen of them, one
     * under another. Tiles side by side still read best at two or three, and
     * the layout decides how they are drawn, not how many there are.
     */
    blocks: {
      type: 'tile',
      label: 'tile',
      max: 6,
      settings: [
        field.media('image', 'Picture'),
        KICKER,
        HEADING,
        field.text('body', 'One sentence under the heading', { max: 240 }),
        field.text('ctaLabel', 'Button text', { max: 60 }),
        field.url('href', 'Where it goes'),
      ],
    },
    presets: looks(
      ['tiles', 'Tiles side by side'],
      ['panels', 'Full-width panels, one under another'],
      ['spread', 'Full-width, two to a row'],
    ),
    pages: ANY_PAGE,
    requires: ['media'],
  },
  {
    type: 'process_steps',
    label: 'How it works',
    hint: 'Numbered steps. How it is made, how a fitting works, what happens after you order.',
    settings: [KICKER, HEADING, SCHEME],
    blocks: {
      type: 'step',
      label: 'step',
      max: 6,
      settings: [HEADING, BODY, field.media('image', 'Picture')],
    },
    pages: ANY_PAGE,
  },
  {
    type: 'figures',
    label: 'Numbers about the business',
    hint: 'Forty years, three makers, one workshop. Set large.',
    settings: [KICKER, HEADING],
    blocks: {
      type: 'figure',
      label: 'figure',
      max: 4,
      settings: [
        field.text('value', 'The number', { max: 24 }),
        field.text('label', 'What it counts', { max: 60 }),
      ],
    },
    pages: ANY_PAGE,
    /*
     * A number is a fact, and rule 1 of every prompt in this platform is that a
     * model may not invent one. "Forty years" written by a model is a claim
     * about the merchant's business that the merchant never made and may have
     * to answer for.
     */
    neverGenerated: true,
  },
  {
    type: 'comparison',
    label: 'Ours against the usual',
    hint: 'Two columns of plain claims. Crawlers and shopping agents read this well.',
    settings: [
      KICKER,
      HEADING,
      field.text('ours', 'Your column', { max: 60 }),
      field.text('theirs', 'The other column', { max: 60 }),
    ],
    blocks: {
      type: 'row',
      label: 'row',
      max: 10,
      settings: [
        field.text('label', 'What is being compared', { max: 80 }),
        field.text('ours', 'Yours', { max: 80 }),
        field.text('theirs', 'Theirs', { max: 80 }),
      ],
    },
    pages: [...ANY_PAGE],
    /*
     * A comparative claim about somebody else is both a fact and a legal
     * exposure, and it is the merchant's to make. The band exists because a
     * merchant who has done the comparison should be able to put it on a page;
     * generating one would be this platform writing a competitor claim under
     * somebody else's name.
     */
    neverGenerated: true,
  },

  // Bands the twelve themes draw --------------------------------------------

  /*
   * Four bands from the comps the owner signed off on 2026-10-19, each drawn
   * by the platform in its own plain way so a merchant can place it on any
   * shop, and drawn again by the themes that own it (`src/themes` in the shop
   * front). Every one is never generated for now: the generators are taught
   * a band in the same change that offers it, and that is phase C6.
   */
  {
    type: 'lookbook',
    label: 'A picture with its products marked',
    hint: 'One photograph and up to six products pinned where they appear in it, listed beside it.',
    settings: [KICKER, HEADING, field.media('image', 'Picture', { narrowest: 800 }), BODY, SCHEME],
    blocks: {
      type: 'spot',
      label: 'product',
      max: 6,
      settings: [
        field.reference('product', 'product', 'Which product'),
        field.number('x', 'How far across, in percent', { min: 0, max: 100, fallback: 50 }),
        field.number('y', 'How far down, in percent', { min: 0, max: 100, fallback: 50 }),
      ],
    },
    pages: ANY_PAGE,
    requires: ['media', 'product'],
    neverGenerated: true,
    /*
     * The products the spots name, read the way a featured product is: by
     * handle, deduped with every other band on the page by `dataPlanFor`. A
     * spot whose product was renamed loses its marker and its line rather than
     * drawing a link to nothing.
     */
    needs: (section) =>
      (Array.isArray(section.blocks) ? section.blocks : []).flatMap((block) => {
        const handle = (block as { product?: unknown }).product;
        return typeof handle === 'string' && handle.length > 0
          ? [{ resource: 'product' as const, handle }]
          : [];
      }),
  },
  {
    type: 'collage',
    label: 'Pictures laid over each other',
    hint: 'Three to five photographs, scattered, stacked or in a strip, each with a line and a link if you like.',
    settings: [KICKER, HEADING, BODY, SCHEME],
    blocks: {
      type: 'picture',
      label: 'picture',
      max: 5,
      settings: [
        field.media('image', 'Picture'),
        field.text('alt', 'Description for a screen reader', { max: 300 }),
        field.text('caption', 'A line on it', { max: 80 }),
        field.url('href', 'Link'),
        SHAPE,
      ],
    },
    presets: looks(
      ['scatter', 'Scattered, each at its own angle'],
      ['stack', 'Stacked, one over the next'],
      ['strip', 'In a strip across the page'],
    ),
    pages: ANY_PAGE,
    requires: ['media'],
    neverGenerated: true,
  },
  {
    type: 'split_screen',
    label: 'Words that stay while pictures pass',
    hint: 'One half holds still with the words and a button; the other runs a column of photographs past it.',
    settings: [
      KICKER,
      HEADING,
      BODY,
      field.text('ctaLabel', 'Button text', { max: 60 }),
      field.url('ctaHref', 'Button link'),
      field.select(
        'side',
        'Which side the words sit on',
        [
          { value: 'start', label: 'Left' },
          { value: 'end', label: 'Right' },
        ],
        { fallback: 'start', generatable: false },
      ),
      SCHEME,
    ],
    blocks: {
      type: 'picture',
      label: 'picture',
      max: 6,
      settings: [
        field.media('image', 'Picture'),
        field.text('alt', 'Description for a screen reader', { max: 300 }),
        field.text('caption', 'A line under it', { max: 120 }),
      ],
    },
    pages: ANY_PAGE,
    requires: ['media'],
    neverGenerated: true,
  },
  /*
   * Ranges as tabs, each showing a few of its products. Tabs that work with
   * script off: a radio button per range and the panels shown by the
   * stylesheet, so every product is in the document for a crawler and an
   * agent, and a keyboard moves between ranges with the arrow keys the way it
   * moves through any radio group. Each range is read by name, like
   * `collection_columns`, so the registry check can see every one.
   */
  {
    type: 'collection_tabs',
    label: 'Collections as tabs',
    hint: 'Two to four ranges, one tab each, showing a few of its products. Works with script off.',
    settings: [
      KICKER,
      HEADING,
      field.reference('first', 'collection', 'First tab'),
      field.reference('second', 'collection', 'Second tab'),
      field.reference('third', 'collection', 'Third tab'),
      field.reference('fourth', 'collection', 'Fourth tab'),
      field.number('limit', 'Products in each tab', { min: 1, max: 12, fallback: 4 }),
      SCHEME,
    ],
    pages: ANY_PAGE,
    requires: ['collection'],
    neverGenerated: true,
    needs: (section) => [
      // The titles, which name the tabs.
      { resource: 'collections' },
      ...[section.first, section.second, section.third, section.fourth]
        .filter((handle): handle is string => typeof handle === 'string' && handle.length > 0)
        .map((handle) => ({
          resource: 'collection' as const,
          handle,
          limit: numberOr(section.limit, 4),
        })),
    ],
  },
] as const satisfies readonly SectionDefinition[];

export type SectionType = (typeof SECTION_DEFINITIONS)[number]['type'];

/**
 * The type names alone, for callers that only need the vocabulary.
 *
 * Typed as a non-empty tuple because `z.enum` requires one, and derived by
 * `map` rather than written out because a second list is a list that drifts.
 * TypeScript cannot see that a `map` over a non-empty literal is non-empty, so
 * the assertion states what the line above guarantees.
 */
export const SECTION_TYPES = SECTION_DEFINITIONS.map(
  (section) => section.type,
) as unknown as readonly [SectionType, ...SectionType[]];

/**
 * The same list, widened.
 *
 * `as const satisfies` narrows every entry to its own literal type, which is
 * what gives `SectionType` its union and is worth keeping. The cost is that the
 * array's element type is a union of twenty-eight shapes, and the ones without
 * blocks genuinely have no `blocks` property to read. Anything iterating for a
 * field that only some entries carry reads this instead.
 */
const DEFINITIONS: readonly SectionDefinition[] = SECTION_DEFINITIONS.map(withPresetField);

/**
 * A section's declared presets, folded in as an ordinary `select` setting.
 *
 * Done once here rather than at each of the five places that read `settings`,
 * which is what makes a preset reach the parser, the editor, the data plan, the
 * translation filter and the AI schema without any of them knowing it is not a
 * hand-written field. That is the same reason this file exists at all.
 *
 * The fallback is the first choice, which by convention renders what the band
 * rendered before it had presets.
 */
function withPresetField(section: SectionDefinition): SectionDefinition {
  if (!section.presets || section.presets.length === 0) return section;

  return {
    ...section,
    settings: [
      ...section.settings,
      field.select('preset', 'Layout', section.presets, {
        fallback: section.presets[0]!.value,
      }),
    ],
  };
}

const BY_TYPE = new Map<string, SectionDefinition>(
  DEFINITIONS.map((section) => [section.type, section]),
);

/** The definition for a type, or undefined for a name nothing recognises. */
export function sectionDefinition(type: string): SectionDefinition | undefined {
  return BY_TYPE.get(type);
}

/**
 * The setting kinds a model can fill knowing nothing but the business.
 *
 * Words, numbers and closed choices. A `colour` belongs here too: it is checked
 * by the same predicate the brand form uses, so the worst a model can do is
 * propose a shade somebody dislikes.
 *
 * `url` is here because the schema the generator builds narrows it to paths
 * this shop actually serves. Left as free text it would be the one field where
 * a model could invent something that looks right and answers 404.
 */
const ALWAYS_FILLABLE: readonly FieldKind[] = [
  'text',
  'richtext',
  'number',
  'boolean',
  'select',
  'colour',
  'url',
];

/**
 * The kinds that name something the shop owns.
 *
 * These were once unfillable and the comment here said so: a model writing a
 * shop from one sentence has no media library to choose a picture from. That
 * was true of the only caller at the time, which ran once during onboarding
 * against a store with nothing in it.
 *
 * It stopped being true when the same generator was pointed at a merchant
 * redesigning a shop that has a catalogue and three hundred photographs. The
 * model does not invent an id: it is handed the shop's own, and picks. So what
 * decides these now is not whether a model could fill them but whether this
 * particular shop has anything to fill them with, which is `AvailableMaterials`
 * below.
 */
export const MATERIAL_KINDS = ['media', 'product', 'collection', 'blog'] as const;

export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** What a shop has to design with, one flag per {@link MATERIAL_KINDS}. */
export type AvailableMaterials = Readonly<Record<MaterialKind, boolean>>;

/** A shop with nothing in it yet, which is what onboarding hands the generator. */
export const NO_MATERIALS: AvailableMaterials = {
  media: false,
  product: false,
  collection: false,
  blog: false,
};

function isMaterial(kind: FieldKind): kind is MaterialKind {
  return (MATERIAL_KINDS as readonly FieldKind[]).includes(kind);
}

/** Whether every material a section is made of is one this shop owns. */
function materialsPresent(section: SectionDefinition, have: AvailableMaterials): boolean {
  return (section.requires ?? []).every((kind) => isMaterial(kind) && have[kind]);
}

/**
 * The sections the shop generator may propose, derived rather than listed.
 *
 * Three rules, and each one is here because leaving it out produced a shop a
 * merchant did not trust.
 *
 * A band marked `neverGenerated` stays out however fillable its fields look:
 * that flag is about having something true to say, not about being able to type.
 *
 * A band must be allowed on the page being generated, so an article body cannot
 * be proposed for a home page.
 *
 * A band must have its materials. The rule this replaces was that every setting
 * had to be words or a number, which excluded a hero because a hero has a
 * picture field, even though `Section` renders a hero with no picture perfectly
 * well as a large heading. So the question moved from what kind of field it is
 * to whether the shop owns the thing, and the sections that are genuinely made
 * of pictures say so with `requires`.
 *
 * Derived from the registry so a section added later joins or does not join on
 * its own merits, with nobody having to remember this exists.
 */
export function blueprintSectionTypes(
  have: AvailableMaterials,
  page: PageType = 'home',
): SectionType[] {
  return DEFINITIONS.filter(
    (section) =>
      section.neverGenerated !== true &&
      sectionAllowedOn(section.type, page) &&
      materialsPresent(section, have) &&
      section.settings.every(
        (setting) => ALWAYS_FILLABLE.includes(setting.kind) || isMaterial(setting.kind),
      ),
  ).map((section) => section.type as SectionType);
}

/**
 * Every setting the offered sections carry, deduped, for the generator.
 *
 * ## What this is for now, and what it used to be for
 *
 * It used to be the SHAPE: a generator handed the model one flat object with
 * every possible field on it, on the stated grounds that "strict structured
 * output has no union at a property position". That claim was never true of a
 * property position, only of a schema's root, and the generator stopped relying
 * on it on 2026-09-12 after a graded round measured what the flat shape costs.
 * Every band was being offered between nineteen and twenty-four settings it
 * could not hold; a model put a manifesto's sentence in `heading`, which a
 * manifesto does not have, and the band rendered nothing at all.
 * `modelSectionShapeFor` in `packages/ai` now builds one member per band.
 *
 * What survives, and is the only thing this should be read as, is the answer to
 * "which setting NAMES may a generator fill in at all" -- the `generatable`
 * filter below, applied once, in one place. The per-band builder takes the set
 * of names from here and reads each band's own settings and bounds from its own
 * definition, because a deduped field is the wrong shape for a band: `body` is
 * richtext of 2,000 on ten bands and text of 300 on `banner`, and first-wins
 * told the model it had 2,000 everywhere.
 *
 * Derived rather than listed, and the version that was listed is why. It named
 * `heading`, `body` and `limit`, which were the only settings the five original
 * sections had. The vocabulary grew, `spacer` and `policy_badges` became
 * offerable, and the model could pick them and had no way to say how much room
 * or which badges — so it always got the defaults, silently, and nothing about
 * the generated shop said a choice had been skipped.
 *
 * A name is only ever reported once. Two sections sharing `heading` share the
 * field, which is what makes the flat object work at all: the same key means
 * the same thing everywhere in this registry, and a section that wanted a
 * different meaning would have called it something else.
 *
 * `preset` is the one name where "the same thing" is not the same LIST. Every
 * band that has presets calls the setting `preset` and each offers its own
 * values, so first-wins would hand the model the hero's four choices and let it
 * pick `image_scrim` for a gallery -- which `parseSection` then refuses,
 * costing a turn. `mergeChoices` answers the union instead, and the per-section
 * parser narrows it back down, which is exactly the division of labour the flat
 * shape already relies on everywhere else.
 */
export function blueprintSectionFields(
  have: AvailableMaterials,
  page: PageType = 'home',
): FieldDefinition[] {
  const offered = new Set<string>(blueprintSectionTypes(have, page));
  const fields = new Map<string, FieldDefinition>();

  for (const section of DEFINITIONS) {
    if (!offered.has(section.type)) continue;
    for (const setting of section.settings) {
      // A setting the registry has and a prompt has not explained. See
      // `FieldDefinition.generatable`.
      if (setting.generatable === false) continue;

      const offered = generatableChoices(setting);
      const seen = fields.get(setting.name);
      fields.set(setting.name, seen ? mergeChoices(seen, offered) : offered);
    }
  }

  return [...fields.values()];
}

/**
 * A select narrowed to the choices a generator may make.
 *
 * Every other field comes back as it is. A select loses the values marked
 * `generatable: false`, and its schema with them, so a look added to a band
 * the model already fills reaches the editor and not the model. See
 * `FieldChoice.generatable`.
 */
export function generatableChoices(setting: FieldDefinition): FieldDefinition {
  if (setting.kind !== 'select' || !setting.choices) return setting;
  if (setting.choices.every((choice) => choice.generatable !== false)) return setting;

  const choices = setting.choices.filter((choice) => choice.generatable !== false);
  const allowed = choices.map((choice) => choice.value);
  return {
    ...setting,
    choices,
    schema: z
      .string()
      .refine((value) => allowed.includes(value))
      .optional()
      .catch(undefined),
  };
}

/**
 * Two same-named settings folded into one the model can fill in.
 *
 * Only ever widens, and only ever a `select`. Everything else keeps the first
 * definition, which is the behaviour this function replaced and is right for
 * every other kind: two sections' `heading` are the same field and the bounds
 * agree, because they come from the same constant.
 *
 * A union rather than an intersection, because the shape is flat and there is
 * one slot per name: an intersection would offer only the values every band
 * agrees on, which for presets is none of them, so the model would be handed a
 * setting it could never fill in legally.
 */
function mergeChoices(first: FieldDefinition, second: FieldDefinition): FieldDefinition {
  if (first.kind !== 'select' || second.kind !== 'select') return first;

  const values = new Set((first.choices ?? []).map((choice) => choice.value));
  const merged = [
    ...(first.choices ?? []),
    ...(second.choices ?? []).filter((choice) => !values.has(choice.value)),
  ];

  const allowed = merged.map((choice) => choice.value);

  return {
    ...first,
    choices: merged,
    schema: z
      .string()
      .refine((value) => allowed.includes(value))
      .optional()
      .catch(undefined),
  };
}

/**
 * The block type names the generator may use, across the sections it is offered.
 *
 * A flat list rather than a map from section to its block type, because the
 * model fills one shape for every block on the page and a `question` under a
 * `multicolumn` is refused on the way out by `parseBlocks`, which only ever
 * parses a block against the section holding it.
 */
export function blueprintBlockTypes(have: AvailableMaterials, page: PageType = 'home'): string[] {
  const offered = new Set<string>(blueprintSectionTypes(have, page));
  const types = new Set<string>();

  for (const section of DEFINITIONS) {
    if (offered.has(section.type) && section.blocks) types.add(section.blocks.type);
  }

  return [...types];
}

/**
 * Every setting the offered sections' blocks carry, deduped.
 *
 * The block half of {@link blueprintSectionFields}, and read the same way: the
 * set of names a generator may fill in, rather than the shape it is handed. The
 * note on that function covers why, including the claim about unions that was
 * wrong and what replaced it.
 *
 * Names collide across block types on purpose. A gallery image and a logo both
 * call their picture `image`, and the same key means the same thing everywhere
 * in this registry, which is what made one flat shape possible at all. It is
 * also what made it lossy: a block list offering every block type's fields let
 * a model put a `question` on a `multicolumn` column, and `parseBlocks` dropped
 * it after the words had been paid for.
 */
export function blueprintBlockFields(
  have: AvailableMaterials,
  page: PageType = 'home',
): FieldDefinition[] {
  const offered = new Set<string>(blueprintSectionTypes(have, page));
  const fields = new Map<string, FieldDefinition>();

  for (const section of DEFINITIONS) {
    if (!offered.has(section.type) || !section.blocks) continue;
    for (const setting of section.blocks.settings) {
      if (setting.generatable === false) continue;
      if (!fields.has(setting.name)) fields.set(setting.name, setting);
    }
  }

  return [...fields.values()];
}

/**
 * The largest number of blocks any offered section accepts.
 *
 * One bound for the model's array, because the shape is shared. The real cap is
 * per section and `parseBlocks` applies it, slicing a twenty-question list down
 * to the four columns a `multicolumn` holds. Bounding the model at the maximum
 * rather than the minimum means a generous section is not silently limited to
 * the stingiest one's allowance.
 */
export function blueprintMaxBlocks(have: AvailableMaterials, page: PageType = 'home'): number {
  const offered = new Set<string>(blueprintSectionTypes(have, page));

  return DEFINITIONS.filter((section) => offered.has(section.type) && section.blocks).reduce(
    (most, section) => Math.max(most, section.blocks?.max ?? 0),
    0,
  );
}

/**
 * The structured data a page's bands add up to.
 *
 * Collected here rather than per band, so a page emits one graph rather than a
 * script element per section. A crawler reading five separate blocks has to
 * merge them itself, and some do not.
 *
 * Answers are the bands' own: nothing is inferred, and a band whose declaration
 * returns null contributes nothing rather than an empty object.
 */
export function sectionsJsonLd(sections: readonly LayoutSection[]): Record<string, unknown>[] {
  return sections.flatMap((section) => {
    const declared = sectionDefinition(section.type)?.jsonLd;
    if (!declared) return [];

    const emitted = declared(section as Record<string, unknown>);
    return emitted === null ? [] : [emitted];
  });
}

/** Whether a section may be placed on a given page. */
export function sectionAllowedOn(type: string, page: PageType): boolean {
  const pages: readonly PageType[] = sectionDefinition(type)?.pages ?? [];
  return pages.includes(page);
}

/** The sections offered for one page type, in the order the editor lists them. */
/**
 * The bands that can carry a page's title.
 *
 * Named here rather than spelled out in the renderer, because the renderer is
 * no longer the only caller. A route that composes a page has to know whether
 * the template will supply an `h1` before deciding whether to render one
 * itself, and two spellings of that question is how a page ends up with two
 * titles or with none.
 */
/**
 * The bands that can supply a page's title.
 *
 * `collection_header` was missing, and that made every collection page on the
 * default arrangement render its title as an `<h2>`: `DEFAULT_COLLECTION` is
 * exactly `[collection_header, collection_products]`, so `findIndex` over this
 * list answered -1 and the band took its non-title branch. Not a latent gap
 * either. It was a regression, and the route's own comment claimed the case was
 * "reported by the editor", which nothing does.
 *
 * `page_body`, `article_body` and `article_list` are deliberately NOT here.
 * Their routes already render a title of their own when this list does not
 * match, so adding them would suppress that fallback and leave those pages with
 * no `h1` instead of one. Membership means "this band renders the page title",
 * not "this band appears on a page that has one".
 */
export const TITLE_BANDS: readonly string[] = ['intro', 'hero', 'collection_header'];

/**
 * Whether a template supplies the page's own title.
 *
 * The bug this exists for is quiet and total. `Sections` picks the `h1` from
 * the first `intro` or `hero` it finds, and answers -1 when there is neither --
 * so a page a merchant composed out of a banner and a product grid has NO `h1`
 * at all. Nothing looks wrong; the page simply stops having a title, to a
 * screen reader and to a crawler both.
 *
 * With `home` that was survivable, because the default template starts with an
 * `intro` and a merchant had to work to remove it. It stops being survivable
 * the moment a CMS page or a landing page is a template too, since those start
 * empty and a merchant composes them from nothing.
 *
 * So a route asks this, and renders the row's own title when the answer is no.
 */
export function templateCarriesHeading(sections: readonly LayoutSection[]): boolean {
  return sections.some(sectionCarriesHeading);
}

/**
 * Whether THIS band will actually render the page's title.
 *
 * The band TYPE is not enough, and the difference is a real hole rather than a
 * refinement. `hero` renders its heading only when it has one: the renderer
 * asks `text(section.heading)` and draws nothing when it is empty. A predicate
 * answering on type alone therefore LIES about a hero a merchant has placed and
 * not yet typed into, which is the normal intermediate state, because the
 * editor writes `{ type }` on Add. The route sees "the template has a title",
 * renders none of its own, and the hero renders none either. Zero.
 *
 * `intro` and `collection_header` always carry: the first falls back to the
 * shop's name and the second takes the collection's own title, so neither can
 * be empty the way a hero can.
 *
 * The emptiness test is the renderer's, copied rather than imported because
 * this package depends on zod and nothing else. It is a non-empty trimmed
 * string with no translation involved, which is what `text` does.
 */
export function sectionCarriesHeading(section: LayoutSection): boolean {
  if (section.type === 'intro' || section.type === 'collection_header') return true;
  if (section.type !== 'hero') return false;

  const heading = (section as { heading?: unknown }).heading;
  return typeof heading === 'string' && heading.trim().length > 0;
}

export function sectionsAvailableOn(page: PageType): readonly SectionDefinition[] {
  return DEFINITIONS.filter((section) => sectionAllowedOn(section.type, page));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The registry as JSON, for the surfaces that cannot import it.
 *
 * The admin is the one that matters. It depends on `@storeware/api-client` and
 * deliberately not on `@storeware/core`, so it cannot read the definitions
 * above, and the copy it showed a merchant lived in its own table keyed by
 * section type. That table was the drift: a section could exist on the platform
 * and be invisible in the editor, or be listed there with a label nothing on
 * the storefront agreed with.
 *
 * So the vocabulary travels over the wire like everything else the admin knows.
 * `settings` is the setting names rather than the schema, which is all the
 * current form needs to decide whether to draw a body box; a schema-driven form
 * will want more, and this is where it goes when it does.
 */
export interface FieldView {
  name: string;
  kind: FieldKind;
  label: string;
  hint?: string;
  choices?: FieldChoice[];
  min?: number;
  max?: number;
  /** For a picture, the narrowest the band draws well. See `FieldDefinition.narrowest`. */
  narrowest?: number;
  fallback?: string | number | boolean;
}

export interface SectionDefinitionView {
  type: string;
  label: string;
  hint: string;
  /** The settings this section accepts, in the order the editor should draw them. */
  settings: FieldView[];
  /** The page types it may be placed on. */
  pages: PageType[];
  /** Present only on the sections that take repeatable children. */
  blocks?: {
    type: string;
    label: string;
    max: number;
    settings: FieldView[];
  };
}

export function sectionDefinitionViews(): SectionDefinitionView[] {
  return DEFINITIONS.map((section) => ({
    type: section.type,
    label: section.label,
    hint: section.hint,
    settings: section.settings.map(fieldView),
    pages: [...section.pages],
    ...(section.blocks
      ? {
          blocks: {
            type: section.blocks.type,
            label: section.blocks.label,
            max: section.blocks.max,
            settings: section.blocks.settings.map(fieldView),
          },
        }
      : {}),
  }));
}

function fieldView(setting: FieldDefinition): FieldView {
  return {
    name: setting.name,
    kind: setting.kind,
    label: setting.label,
    ...(setting.hint === undefined ? {} : { hint: setting.hint }),
    ...(setting.choices === undefined ? {} : { choices: setting.choices.map((c) => ({ ...c })) }),
    ...(setting.min === undefined ? {} : { min: setting.min }),
    ...(setting.max === undefined ? {} : { max: setting.max }),
    ...(setting.narrowest === undefined ? {} : { narrowest: setting.narrowest }),
    ...(setting.fallback === undefined ? {} : { fallback: setting.fallback }),
  };
}

/**
 * One section as stored, which is its type plus whatever settings it carries.
 *
 * The index signature is what keeps this honest across a widening vocabulary: a
 * renderer reads the settings it knows about, and a setting written by a newer
 * deploy travels through an older one rather than being stripped on the next
 * save.
 */
export interface LayoutSection {
  type: string;
  /**
   * A name for this band that survives being moved.
   *
   * Assigned on write, never on read, and that is the whole point of it.
   * Translated copy is keyed by it, and the obvious alternative — keying by
   * position — breaks the first time a merchant drags a band up two places: the
   * French heading stays where it was and now belongs to a different section,
   * silently, on a page nobody who speaks French is watching.
   *
   * Optional because every layout stored before this existed has none. Those
   * bands render exactly as they did and become translatable the next time
   * their page is saved.
   */
  id?: string | undefined;
  heading?: string | undefined;
  body?: string | undefined;
  limit?: number | undefined;
  /** Present only on the sections that declare them, and only when non-empty. */
  blocks?: LayoutBlock[] | undefined;
  [setting: string]: unknown;
}

/**
 * The shape of a band's own name.
 *
 * Short and opaque. It is not a handle and never appears in a URL, so it needs
 * no meaning; what it needs is to be stable and to be cheap to compare.
 */
const SECTION_ID = /^[a-z0-9]{6,32}$/;

/** The Zod object one field list describes. */
function shapeOf(settings: readonly FieldDefinition[]): z.ZodRawShape {
  return Object.fromEntries(settings.map((setting) => [setting.name, setting.schema]));
}

/**
 * A parser for one section, built from its own definition.
 *
 * `.passthrough()` rather than the default strip, for the forward-compatibility
 * reason above: an older deploy reading a layout that a newer one wrote must
 * hand the unknown settings back unchanged when the merchant next saves,
 * instead of quietly deleting them.
 *
 * `blocks` is stripped here and parsed separately, because a block list has to
 * fail the way a section list does — one bad row dropped, the rest kept —
 * and Zod's array parse is all-or-nothing.
 */
const PARSERS = new Map<string, z.ZodTypeAny>(
  // `DEFINITIONS` rather than the literal, so a generated `preset` setting is
  // one the parser knows about. Reading the literal here would mean a band
  // whose preset parsed in the editor and was stripped on the way to a page.
  DEFINITIONS.map((section) => [
    section.type,
    z
      .object({
        ...shapeOf(section.settings),
        type: z.literal(section.type),
        id: z.string().regex(SECTION_ID).optional(),
      })
      .passthrough()
      .transform(({ blocks: _blocks, ...rest }) => rest),
  ]),
);

const BLOCK_PARSERS = new Map<string, z.ZodTypeAny>(
  DEFINITIONS.filter((section) => section.blocks !== undefined).map((section) => [
    section.type,
    z
      .object({
        ...shapeOf(section.blocks!.settings),
        type: z.literal(section.blocks!.type),
        id: z.string().regex(SECTION_ID).optional(),
      })
      .passthrough(),
  ]),
);

/**
 * Parses one section, or returns null for anything unrecognised.
 *
 * Null rather than throwing, because the caller drops sections one at a time.
 */
export function parseSection(value: unknown): LayoutSection | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;

  const parser = PARSERS.get(type);
  if (!parser) return null;

  const parsed = parser.safeParse(value);
  if (!parsed.success) return null;

  const section = parsed.data as LayoutSection;
  const definition = BY_TYPE.get(type);
  if (!definition?.blocks) return section;

  const blocks = parseBlocks(type, (value as { blocks?: unknown }).blocks);
  return blocks.length === 0 ? section : { ...section, blocks };
}

/**
 * The blocks of one section, with anything unreadable left out.
 *
 * Same discipline as the section list and for the same reason: a merchant who
 * placed six questions and whose fourth has a field a later release removed
 * should lose that question, not the whole band. Over the section's own maximum
 * the tail is dropped rather than the lot refused, so a bound tightened later
 * shortens a page instead of emptying one.
 */
export function parseBlocks(sectionType: string, value: unknown): LayoutBlock[] {
  const definition = BY_TYPE.get(sectionType);
  const parser = BLOCK_PARSERS.get(sectionType);
  if (!definition?.blocks || !parser || !Array.isArray(value)) return [];

  return value
    .map((block) => parser.safeParse(block))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data as LayoutBlock)
    .slice(0, definition.blocks.max);
}

/**
 * How many sections one page may hold.
 *
 * Unchanged at twelve. "Forty sections is not a layout, it is a merchant who
 * has discovered a button."
 */
export const MAX_SECTIONS_PER_PAGE = 12;

/**
 * Gives a band a name if it has none.
 *
 * Called on write and never on read, because an id minted at render time would
 * be different on every request and would key nothing. A band that arrives with
 * one keeps it, which is what makes a name survive an edit: the editor posts
 * the whole template back, ids included, and only genuinely new bands get new
 * ones.
 *
 * Random rather than derived from position or type. Two `note` bands on one
 * page need different names, and a name derived from position is the thing this
 * exists to avoid.
 */
export function withSectionIds(sections: readonly LayoutSection[]): LayoutSection[] {
  return sections.map((section) => {
    const named =
      typeof section.id === 'string' && SECTION_ID.test(section.id)
        ? section
        : { ...section, id: freshSectionId() };

    // Blocks are named too, and for the same reason. Without this the words
    // inside a `multicolumn` or an `faq` — which is most of the words on a page
    // that has one — could not be translated at all, because there was nothing
    // stable to hang the translation off.
    if (!Array.isArray(named.blocks)) return named;

    return {
      ...named,
      blocks: named.blocks.map((block) =>
        typeof block.id === 'string' && SECTION_ID.test(block.id)
          ? block
          : { ...block, id: freshSectionId() },
      ),
    };
  });
}

function freshSectionId(): string {
  // Base 36 over two draws, which is roughly 62 bits. Collisions matter only
  // within one page of at most twelve bands, so this is enormous overkill and
  // costs nothing.
  return (Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)).replace(
    /[^a-z0-9]/g,
    '0',
  );
}

/**
 * Which of a section's settings hold words a translator would want.
 *
 * Derived from the field kinds, so a band that gains a heading next year
 * becomes translatable without anybody adding it to a list. Everything else —
 * a media id, a product handle, a colour, a count — is the same in every
 * language, and offering it for translation would be offering somebody the
 * chance to break a page in a language nobody on the team reads.
 */
export function translatableFieldsOf(type: string): FieldDefinition[] {
  const definition = sectionDefinition(type);
  if (!definition) return [];

  return definition.settings.filter(
    (setting) => setting.kind === 'text' || setting.kind === 'richtext',
  );
}

/** One page's translated copy: band id to field name to what it says. */
export type SectionCopy = Record<string, Record<string, string>>;

/**
 * Lays a locale's copy over a template.
 *
 * A missing entry means untranslated, and untranslated means the merchant's own
 * words. That is the same rule the `translations` table keeps for products and
 * pages, and it is what lets a shop be half translated without any page of it
 * being half empty.
 *
 * Only the fields the registry calls translatable are replaced, so a copy blob
 * carrying a stale `limit` or a media id from an older release cannot reach a
 * renderer through this path.
 */
export function applySectionCopy(
  sections: readonly LayoutSection[],
  copy: SectionCopy,
): LayoutSection[] {
  if (Object.keys(copy).length === 0) return [...sections];

  return sections.map((section) => {
    const definition = sectionDefinition(section.type);
    const blocks = definition?.blocks
      ? blocksWithCopy(section, definition.blocks.settings, copy)
      : undefined;

    const id = typeof section.id === 'string' ? section.id : null;
    const translated = id ? copy[id] : undefined;

    if (!translated) return blocks ? { ...section, blocks } : section;

    const next: LayoutSection = { ...section, ...(blocks ? { blocks } : {}) };
    for (const field of translatableFieldsOf(section.type)) {
      const value = translated[field.name];
      if (typeof value === 'string' && value.trim().length > 0) next[field.name] = value;
    }
    return next;
  });
}

/**
 * The same overlay, applied to a band's repeatable children.
 *
 * Blocks are keyed at the top level of the copy blob by their own id rather
 * than nested under their section's, because a block id is minted by the same
 * generator and is unique on its own. That keeps the blob two levels deep and
 * means no key has to be parsed apart to be read.
 */
function blocksWithCopy(
  section: LayoutSection,
  blockSettings: readonly FieldDefinition[],
  copy: SectionCopy,
): LayoutBlock[] | undefined {
  if (!Array.isArray(section.blocks)) return undefined;

  const words = blockSettings.filter(
    (setting) => setting.kind === 'text' || setting.kind === 'richtext',
  );
  if (words.length === 0) return section.blocks;

  return section.blocks.map((block) => {
    const translated = typeof block.id === 'string' ? copy[block.id] : undefined;
    if (!translated) return block;

    const next = { ...block };
    for (const field of words) {
      const value = translated[field.name];
      if (typeof value === 'string' && value.trim().length > 0) next[field.name] = value;
    }
    return next;
  });
}

/**
 * What a page looks like before a merchant arranges anything.
 *
 * `home` keeps exactly what it rendered before templates existed, for the
 * reason the constant has always carried: a default that quietly rearranged
 * every existing storefront would be a redesign nobody asked for.
 *
 * Every other page type defaults to **no sections**, and that is the whole
 * safety of widening `PAGE_TYPES` in one go. An empty template means "render
 * the page the way the storefront already renders it", so a product page with
 * no template is the product page that shipped. Nothing about a shop changes
 * until a merchant places a section on it.
 *
 * **One deliberate exception, made on 2026-09-29:** a product page defaults
 * to its related products. A product page that ends at the description is a
 * dead end every current shop platform stopped shipping, and every direction
 * the theme generator writes already places this band, so the only shops it
 * changes are those that never arranged their product page at all. It is a
 * band like any other, and a merchant removes it the same way.
 */
export const DEFAULT_HOME: LayoutSection[] = [
  { type: 'intro' },
  { type: 'assistant' },
  { type: 'products', limit: 24 },
];

/**
 * A post's default, which is the post.
 *
 * Not empty, unlike the other pages, and the difference is what `article_body`
 * exists for. A post's writing is the one piece of built-in page content a
 * merchant might reasonably want to move — above a picture, below a quote — so
 * the article route renders its template rather than the body directly, and the
 * default template is exactly that body.
 *
 * The output is byte-for-byte what the route rendered before templates reached
 * it, which is the same promise `DEFAULT_HOME` makes.
 */
const DEFAULT_ARTICLE: LayoutSection[] = [{ type: 'article_body' }];

/**
 * A category page, as it renders before a merchant touches it.
 *
 * Exactly the two bands the route used to render inline, in the order it
 * rendered them. That is the whole compatibility story: every shop on the
 * platform has an empty `collection` key, falls through to this, and gets the
 * page it got yesterday down to the element.
 */
const DEFAULT_COLLECTION: LayoutSection[] = [
  { type: 'collection_header' },
  { type: 'collection_products' },
];

/** A CMS page is its writing, until a merchant puts something else with it. */
const DEFAULT_PAGE: LayoutSection[] = [{ type: 'page_body' }];

/** What a shopper looks at next, below the product. See the exception above. */
const DEFAULT_PRODUCT: LayoutSection[] = [{ type: 'related_products' }];

/** A blog index is its posts, on the same terms. */
const DEFAULT_BLOG: LayoutSection[] = [{ type: 'article_list' }];

const DEFAULT_TEMPLATES: Record<PageType, LayoutSection[]> = {
  home: DEFAULT_HOME,
  product: DEFAULT_PRODUCT,
  collection: DEFAULT_COLLECTION,
  page: DEFAULT_PAGE,
  article: DEFAULT_ARTICLE,
  blog: DEFAULT_BLOG,
  search: [],
  cart: [],
  account: [],
  not_found: [],
  // Nothing above the header until a merchant puts something there.
  shop: [],
};

/** The template a page falls back to. A copy, so a caller cannot edit the default. */
export function defaultTemplateFor(page: PageType): LayoutSection[] {
  return DEFAULT_TEMPLATES[page].map((section) => ({ ...section }));
}

/**
 * What one page render has to fetch, asked of the sections rather than guessed.
 *
 * Exactly reproduces the arithmetic the home page did inline: the largest limit
 * any product band wanted, and whether anything at all wants collections.
 */
export function dataPlanFor(sections: readonly LayoutSection[]): DataPlan {
  let productLimit = 0;
  let articleLimit = 0;
  let reviewLimit = 0;
  let relatedLimit = 0;
  let styledLimit = 0;
  let thisCollectionLimit = 0;
  let thisBlogLimit = 0;
  let collections = false;
  let pluginBlocks = false;
  let thisCollectionBlocks = false;
  const appSections = new Map<string, { app: string; section: string }>();

  const productHandles = new Set<string>();
  const mediaIds = new Set<string>();
  // A map rather than a set, because two bands may feature the same collection
  // at different depths and one read has to satisfy the deeper of them.
  const collectionLimits = new Map<string, number>();

  for (const section of sections) {
    const definition = sectionDefinition(section.type);
    if (definition) collectMedia(definition, section, mediaIds);

    const needs = definition?.needs?.(section) ?? [];

    for (const need of needs) {
      switch (need.resource) {
        case 'products':
          productLimit = Math.max(productLimit, need.limit);
          break;
        case 'collections':
          collections = true;
          break;
        case 'product':
          productHandles.add(need.handle);
          break;
        case 'collection':
          collectionLimits.set(
            need.handle,
            Math.max(collectionLimits.get(need.handle) ?? 0, need.limit),
          );
          break;
        case 'articles':
          articleLimit = Math.max(articleLimit, need.limit);
          break;
        case 'reviews':
          reviewLimit = Math.max(reviewLimit, need.limit);
          break;
        case 'related':
          relatedLimit = Math.max(relatedLimit, need.limit);
          break;
        case 'styledWith':
          styledLimit = Math.max(styledLimit, need.limit);
          break;
        case 'thisCollection':
          thisCollectionLimit = Math.max(thisCollectionLimit, need.limit);
          break;
        case 'thisBlog':
          thisBlogLimit = Math.max(thisBlogLimit, need.limit);
          break;
        case 'pluginBlocks':
          pluginBlocks = true;
          break;
        case 'appSection':
          appSections.set(`${need.app}/${need.section}`, {
            app: need.app,
            section: need.section,
          });
          break;
        case 'thisCollectionBlocks':
          thisCollectionBlocks = true;
          break;
      }
    }
  }

  return {
    productLimit,
    collections,
    productHandles: [...productHandles],
    collectionHandles: [...collectionLimits].map(([handle, limit]) => ({ handle, limit })),
    articleLimit,
    reviewLimit,
    relatedLimit,
    styledLimit,
    thisCollectionLimit,
    thisBlogLimit,
    pluginBlocks,
    appSections: [...appSections.values()],
    thisCollectionBlocks,
    mediaIds: [...mediaIds],
  };
}

/**
 * Every picture one section refers to, found by kind rather than by name.
 *
 * Walking the field definitions rather than reading known keys is what makes
 * this survive the next section. A `hero` names its picture `image` and a
 * `video` names its `poster`; a band added next year will name its own
 * something else, and this will collect it without being told.
 */
function collectMedia(
  definition: SectionDefinition,
  section: LayoutSection,
  into: Set<string>,
): void {
  for (const setting of definition.settings) {
    if (setting.kind !== 'media') continue;
    const value = section[setting.name];
    if (typeof value === 'string' && value.length > 0) into.add(value);
  }

  if (!definition.blocks || !Array.isArray(section.blocks)) return;

  for (const block of section.blocks) {
    for (const setting of definition.blocks.settings) {
      if (setting.kind !== 'media') continue;
      const value = block[setting.name];
      if (typeof value === 'string' && value.length > 0) into.add(value);
    }
  }
}
