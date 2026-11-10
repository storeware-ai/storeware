import { z } from 'zod';
import { isColour, isFontStack, isLength } from './css-values';

/**
 * The ten values a shop is coloured and set in.
 *
 * Split out of `theme.ts` when this package was extracted, and the split is the
 * package's own boundary rather than a tidy-up: everything here is a fact about
 * the FILE FORMAT -- which tokens a theme may carry and what each has to look
 * like -- and everything left behind reads or writes a database.
 *
 * The safety property is the allow-list in `./css-values`, which every token is
 * checked against twice: once before it is stored and once before it reaches a
 * page. The threat model is written out there, next to the patterns it
 * justifies. Nothing here interpolates a merchant's string into anything until
 * it has passed that check.
 */

/**
 * Which tokens a merchant may set, and what each one has to look like.
 *
 * A closed map rather than "validate whatever arrives", so a token added to the
 * design system is not automatically merchant-editable. Some of them should not
 * be: `ok`, `warn` and `bad` carry meaning a shopper relies on, and a shop that
 * made its error colour green would be lying to its own customers.
 */
export const EDITABLE_TOKENS = {
  bg: isColour,
  surface: isColour,
  fg: isColour,
  muted: isColour,
  line: isColour,
  accent: isColour,
  accentFg: isColour,
  /*
   * A second accent and the colour words take on it, for the themes that
   * draw in two (Primary's colour blocks, Hyper's mesh). Optional like every
   * token, and a palette without one draws everything in the first accent:
   * the stylesheet reads `--sw-accent2` with the accent as its fallback. The
   * pair is checked whenever both are present (`readPalette` in core).
   */
  accent2: isColour,
  accent2Fg: isColour,
  radius: isLength,
  fontSans: isFontStack,
  fontMono: isFontStack,
} as const satisfies Record<string, (value: string) => boolean>;

export type EditableToken = keyof typeof EDITABLE_TOKENS;

/** The CSS custom property each token is rendered as, matching @storeware/ui. */
const PROPERTY: Record<EditableToken, string> = {
  bg: '--sw-bg',
  surface: '--sw-surface',
  fg: '--sw-fg',
  muted: '--sw-muted',
  line: '--sw-line',
  accent: '--sw-accent',
  accentFg: '--sw-accent-fg',
  accent2: '--sw-accent2',
  accent2Fg: '--sw-accent2-fg',
  radius: '--sw-radius',
  fontSans: '--sw-font-sans',
  fontMono: '--sw-font-mono',
};

export class InvalidThemeTokenError extends Error {
  readonly code = 'invalid_theme_token';
  constructor(
    readonly token: string,
    readonly value: string,
  ) {
    super(`${token} is not a value this can accept. Use a colour, a length or a font name.`);
    this.name = 'InvalidThemeTokenError';
  }
}

export const themeTokensInput = z.record(z.string(), z.string()).superRefine((tokens, ctx) => {
  for (const [token, value] of Object.entries(tokens)) {
    const check = EDITABLE_TOKENS[token as EditableToken];

    if (!check) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [token],
        message: `${token} is not a token a shop can set.`,
      });
      continue;
    }

    if (!check(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [token],
        message: `${value} is not a value this can accept.`,
      });
    }
  }
});

/**
 * A partial set of tokens laid over the ones a shop already has.
 *
 * `updateStoreTheme` replaces the map wholesale, and its reasoning is sound for
 * the caller it was written for: the brand form shows every field at once, so a
 * cleared colour means the platform default and merging would make clearing
 * impossible.
 *
 * Every other caller wants the opposite. A merchant who says "make the buttons
 * green" has said nothing about their background, and a patch of `{ accent }`
 * sent straight to `updateStoreTheme` clears the other six colours and the
 * radius and both typefaces. So a caller holding a patch rather than a form
 * merges here first, and the wholesale write stays the wholesale write.
 *
 * An explicitly undefined value is treated as absent rather than as a clear,
 * because `exactOptionalPropertyTypes` is on and a caller building a patch by
 * spreading optional fields would otherwise wipe a token by mentioning it.
 */
export function mergeTokens(
  current: Record<string, string>,
  patch: Record<string, string | undefined>,
): Record<string, string> {
  const merged = { ...current };

  for (const [token, value] of Object.entries(patch)) {
    if (value !== undefined) merged[token] = value;
  }

  return merged;
}

/**
 * The merchant's overrides as a stylesheet block.
 *
 * Validated again at render rather than trusted from the column, and that is
 * deliberate rather than paranoid: a row could have been written by a migration,
 * by a support script, or by a version of the validator that has since been
 * tightened. The page a shopper loads is the last place this can be caught, so
 * it is caught here too, and an invalid value is dropped rather than rendered.
 *
 * Returns an empty string when there is nothing to say, so the caller renders no
 * element at all rather than an empty one.
 */
export function themeCss(tokens: Record<string, string>, selector = ':root'): string {
  const lines = tokenDeclarations(tokens);
  if (lines.length === 0) return '';
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/**
 * The ten tokens as declarations, without the block around them.
 *
 * Split out of `themeCss` when the art direction arrived, so that one selector
 * can carry the tokens, the art and the derived colours. `themeCss` keeps its
 * signature and its exact output, because `agent-frame.ts` and the branding
 * tests depend on the ten-token contract and there was no reason to widen it:
 * an agent frame carries four colours into somebody else's panel, and a density
 * or a type scale there would be this platform restyling a surface it does not
 * own.
 */
export function tokenDeclarations(tokens: Record<string, string>): string[] {
  const lines: string[] = [];

  for (const [token, value] of Object.entries(tokens)) {
    const key = token as EditableToken;
    const check = EDITABLE_TOKENS[key];
    if (!check || !check(value)) continue;

    lines.push(`  ${PROPERTY[key]}: ${value.trim()};`);
  }

  return lines;
}
