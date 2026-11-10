import { z } from 'zod';
import {
  MAX_SECTIONS_PER_PAGE,
  PAGE_TYPES,
  defaultTemplateFor,
  parseSection,
  sectionAllowedOn,
  withSectionIds,
  type LayoutSection,
  type PageType,
} from './sections';

/**
 * A whole shop's arrangement: one list of bands per page.
 *
 * The other half of the file format. `./sections` says what a band may be;
 * this says how a page is made of them and how a stored layout is read back.
 *
 * Read back LENIENTLY, everywhere, and that is the property a third party
 * should copy rather than the code. A shop whose layout column holds something
 * this release cannot draw renders an ordinary page: the band is dropped, the
 * rest of the page stands, and a page that loses everything falls back to what
 * the shop rendered before templates existed. The failure a shopper sees must
 * never be worse than the failure a merchant caused.
 */

/**
 * One section, as an input schema.
 *
 * A permissive object here and a per-type parse in `parseSection`, because the
 * settings a section accepts now depend on which section it is. Kept exported
 * under its old name because `blueprint-schema.ts` builds on it, deliberately:
 * reusing it "is what makes an unknown section type unrepresentable rather than
 * merely discouraged".
 */
export const layoutSectionInput = z
  .object({ type: z.string() })
  .passthrough()
  .superRefine((value, ctx) => {
    if (parseSection(value) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${String(value.type)} is not a section this platform builds.`,
      });
    }
  })
  .transform((value) => parseSection(value) as LayoutSection);

/**
 * A page's bands, each with a name it keeps.
 *
 * Ids are stamped here rather than in `parseSection`, because this schema runs
 * on the way in and the parser runs on the way out too. An id minted at read
 * time would be different on every request, so it would key nothing and the
 * translations hanging off it would resolve on none of them.
 */
const template = z
  .array(layoutSectionInput)
  .max(MAX_SECTIONS_PER_PAGE)
  .transform((sections) => withSectionIds(sections));

/**
 * The same schema, named, for the row that carries bands of its own.
 *
 * Exported rather than restated in `content/pages.ts`, so a page's own layout
 * is bounded by the same maximum, parsed by the same section parser and given
 * ids by the same minting as a theme template. A second spelling of this would
 * be a second place for a band to be admitted that the renderer then drops.
 */
export const layoutTemplate = template;

/**
 * A write against one or more page templates.
 *
 * One optional key per page type rather than a free record, so a typo in a page
 * name is a validation error rather than a template nothing will ever render.
 * `updateStoreLayout` merges per key, so writing `product` cannot clear `home`.
 */
export const layoutInput = z.object(
  Object.fromEntries(PAGE_TYPES.map((page) => [page, template.optional()])) as Record<
    PageType,
    z.ZodOptional<typeof template>
  >,
);

export type LayoutInput = z.infer<typeof layoutInput>;

/**
 * A stored layout as the storefront wants it.
 *
 * Parsed rather than cast, and dropping what it cannot read rather than
 * throwing. A shop whose layout column holds nonsense should render an ordinary
 * page, not a stack trace: the failure a shopper sees must never be worse than
 * the failure a merchant caused.
 *
 * The change worth noticing is that a bad section is now dropped on its own,
 * where it used to take the whole page with it. That matters more with a wider
 * vocabulary than it did with five types, and it matters most on a rollback: a
 * deploy that no longer knows about a section a merchant placed last week
 * should lose that band, not reset the page to the platform default and present
 * as every themed shop reverting at once.
 *
 * A page whose sections all fail, or which has none, still falls back to that
 * page's default. For `home` that is the three bands it always rendered; for
 * every other page type it is nothing at all, which means the built-in page.
 */
export function sectionsFor(layout: Record<string, unknown>, page: PageType): LayoutSection[] {
  const sections = parseTemplate(layout[page], page);
  return sections.length === 0 ? defaultTemplateFor(page) : sections;
}

/**
 * A stored template, parsed, with no fallback of its own.
 *
 * Split out of `sectionsFor` when a page gained the ability to carry bands of
 * its own, and the split is what makes the three-layer resolution in
 * `sectionsForRow` possible at all: a caller has to be able to tell "this row
 * has arranged nothing" from "this row arranged nothing readable", and a
 * function that answers the platform default for both cannot.
 *
 * Empty for anything that is not an array, for a template whose bands this
 * release cannot draw, and for one whose bands are not allowed on the page. The
 * caller decides what empty falls back to.
 */
export function parseTemplate(value: unknown, page: PageType): LayoutSection[] {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, MAX_SECTIONS_PER_PAGE)
    .map((section) => parseSection(section))
    .filter((section): section is LayoutSection => section !== null)
    .filter((section) => sectionAllowedOn(section.type, page));
}

/**
 * One row's own bands, falling through to the template for its kind.
 *
 * Three layers, most specific first: THIS page, every page of this type, the
 * platform's default. A row that has never been composed holds an empty array,
 * so it resolves to exactly what it resolved to before the column existed --
 * which is the whole migration for every page already written.
 *
 * ## The row wins whole, and does not merge
 *
 * Two section lists have no honest merge. Append, prepend and match-by-id are
 * three different answers and a merchant means only one of them, and there is
 * nothing in either list that says which. Worse, a merge would put two bands
 * carrying the same `id` on one page, and `id` exists precisely to key the
 * translations -- so a merged page would show one band's German heading on
 * another band, on a page nobody who reads German is watching.
 */
export function sectionsForRow(
  layout: Record<string, unknown>,
  page: PageType,
  own: unknown,
): LayoutSection[] {
  const mine = parseTemplate(own, page);
  return mine.length > 0 ? mine : sectionsFor(layout, page);
}
