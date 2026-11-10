/**
 * Which ground a band sits on, as an attribute the renderer can key rules off.
 *
 * The sibling of `./presets`, and deliberately its own module for the same
 * reason that one is: the values are a published part of the format, the CSS
 * behind them is not. A theme file may say a band is `inverse`; what inverse
 * LOOKS like is the platform's to decide, and a host rendering this kit decides
 * it for themselves.
 *
 * ## Why a band and not the page
 *
 * The palette is one `:root` block, so until this existed a page was one colour
 * from the header to the footer however considered the seven colours were. That
 * is the difference between a shop that reads as art directed and one that reads
 * as a template, and it is not a difference more hues can buy: rhythm is a
 * property of the SEQUENCE of bands, which is why the setting lives on the band.
 *
 * ## Every ground reuses a pair the palette check already covers
 *
 * `raised` is the surface, whose pair with the text colour is checked. `tint` is
 * the derived accent-soft, a twelfth of the accent mixed into the page, so text
 * on it sits within a hair of text on the page. `inverse` swaps the text and the
 * page, and a contrast ratio is symmetric, so an inverted band is exactly as
 * legible as the band it inverts. `accent` is the accent with its own
 * foreground, which is the pair every button already uses.
 *
 * That is the whole argument for these five and against a sixth: a ground
 * mixing the accent into the ink would be a pair nothing has ever checked.
 */

/**
 * The grounds a band may sit on. `base` is the page and emits no attribute.
 *
 * `accent2` is the palette's second accent with its own foreground, added for
 * the two-accent themes (Primary, Hyper). Its pair is checked whenever a
 * palette carries one, and a palette that does not draws the band in the
 * first accent instead, so the choice can never be a band with no colours.
 */
export const SCHEME_IDS = ['base', 'raised', 'tint', 'inverse', 'accent', 'accent2'] as const;

export type SchemeId = (typeof SCHEME_IDS)[number];

/**
 * The attribute one band's chosen ground is worth.
 *
 * Empty for `base`, for a band that has chosen nothing, and for a value this
 * build has never heard of. All three render the band exactly as it renders
 * today, which is the right answer to all three and the same rule
 * `presetAttributes` keeps: the first costs nothing because the page IS the
 * default, the second because nothing was asked for, and the third because a
 * ground invented by a later release should cost a band's colour rather than a
 * page.
 */
export function schemeAttributes(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || value === 'base') return {};
  if (!(SCHEME_IDS as readonly string[]).includes(value)) return {};

  return { 'data-sw-scheme': value };
}
