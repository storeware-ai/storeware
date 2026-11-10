/**
 * The Storeware theme vocabulary.
 *
 * A theme on this platform is DATA rather than code. There is no template
 * language, no expression syntax and no `html` or `css` field kind, so there is
 * nothing in a theme file to sandbox and nothing to review for what it might
 * execute. Every value a merchant or a model supplies is either a key into a
 * table this package owns or a string that has passed the allow-list in
 * `./css-values`.
 *
 * That is the whole security argument, and it is why this package can be public
 * while the platform is not.
 *
 * ## What is exported and what is promised are not the same list
 *
 * Everything below is exported because it is pure and useful. What this package
 * PROMISES is narrower and is written down in `schema.snapshot.json`: a section
 * type is never renamed or removed, a setting is never removed, a bound never
 * lowers, and a page is never taken off a section's allow-list. `compatibility.ts`
 * checks that promise on every run of the test suite.
 *
 * The distinction matters because a stored layout outlives a release. Renaming
 * a section type does not rename it in the `layout` column of every themed shop:
 * it makes that shop's band unparseable, and a band that cannot be parsed is
 * dropped from a page a shopper is looking at. Loosen freely, tighten never.
 *
 * ## The direction of the dependency
 *
 * This package depends on `zod` and on nothing else, ever. The platform imports
 * it; it never imports the platform. A change here that needed a database, an
 * environment variable or a network call would be a change that belongs on the
 * other side of the line.
 */

export { isColour, isLength, isFontStack } from './css-values';
export { isSafeHref } from './href';

export {
  REFUSED_IN_A_LISTING,
  APP_BANDS,
  strictTemplates,
  type StrictOptions,
  type ThemeProblem,
} from './strict';

export {
  EDITABLE_TOKENS,
  InvalidThemeTokenError,
  mergeTokens,
  themeCss,
  themeTokensInput,
  tokenDeclarations,
  type EditableToken,
} from './tokens';

export {
  layoutInput,
  layoutSectionInput,
  layoutTemplate,
  parseTemplate,
  sectionsFor,
  sectionsForRow,
  type LayoutInput,
} from './layout';

export { PRESETS, isMarquee, presetAttributes, type PresetAxes } from './presets';
export { SCHEME_IDS, schemeAttributes, type SchemeId } from './schemes';
export { PICTURE_SHAPES, shapeAttributes, type PictureShape } from './shapes';

export * from './sections';
