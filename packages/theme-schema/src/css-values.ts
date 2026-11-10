/**
 * What a CSS value is allowed to look like, before it reaches a page.
 *
 * Extracted from `theme.ts` when the section registry needed `isColour` too.
 * The alternative was a cycle: `theme.ts` imports the section vocabulary, so a
 * section importing a validator back out of `theme.ts` would have closed the
 * loop. A second copy of these patterns would have been worse than either.
 *
 * The threat is unchanged and it is not theoretical. These values are rendered
 * into a `<style>` block on a page a merchant's own customers load. An accent
 * colour of
 *
 *   red; } body { display: none
 *
 * closes the rule, opens another, and hides the shop. An accent of
 *
 *   red } </style><script>...
 *
 * leaves CSS entirely and runs script on the merchant's domain, next to their
 * checkout. So no value reaches the page unless it matches a pattern for the
 * kind of thing it is, and the patterns are allow-lists rather than filters: a
 * filter has to anticipate every attack, and an allow-list only has to describe
 * the handful of shapes a colour can legitimately take.
 */

/** Roughly a hundred characters is more than any legitimate value needs. */
const MAX_VALUE = 120;

/**
 * The colour forms a merchant can actually type, and nothing else.
 *
 * `oklch` and `oklab` are here because they are how a designer working in 2026
 * specifies a colour and refusing them would push somebody towards a hex
 * approximation of what they meant. Named colours are allowed from a closed
 * list rather than by pattern: `red` is fine, and an arbitrary identifier is
 * how `expression(...)` and friends have historically got through.
 */
const NAMED = new Set([
  'transparent',
  'currentcolor',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'grey',
  'gray',
  'brown',
  'beige',
  'navy',
  'teal',
  'olive',
  'maroon',
  'silver',
  'gold',
  'ivory',
  'cream',
]);

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A functional colour, with its arguments checked rather than trusted.
 *
 * The function name is matched from a closed set and the body is restricted to
 * digits, separators and units. Notably absent: letters beyond the unit
 * characters, which is what stops `rgb(var(--x))` and anything else that could
 * smuggle a nested function through the parentheses.
 */
const FUNCTIONAL = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z%.,\s/+-]{1,100}\)$/i;

export function isColour(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VALUE) return false;

  // Belt and braces. Nothing below can match a string containing these, and
  // saying so here means a future edit to a pattern cannot quietly reopen the
  // hole: `<` escapes the style element, and the rest escape the rule.
  if (/[<>{};\\]/.test(trimmed)) return false;

  if (NAMED.has(trimmed.toLowerCase())) return true;
  if (HEX.test(trimmed)) return true;
  return FUNCTIONAL.test(trimmed);
}

/** A length, for the one token that is one. Zero is allowed without a unit. */
export function isLength(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VALUE) return false;
  if (/[<>{};\\]/.test(trimmed)) return false;

  return /^(?:0|[0-9]*\.?[0-9]+(?:px|rem|em|%|vw|vh|ch))$/.test(trimmed);
}

/**
 * A font stack.
 *
 * The riskiest of the three, because a family name is arbitrary text by nature
 * and the temptation is to let anything through. It is restricted to letters,
 * digits, spaces, hyphens, quotes and commas, which covers every real family
 * name and every generic keyword while excluding the parenthesis `url()` needs
 * and the semicolon a second declaration needs.
 *
 * A merchant wanting a font nobody has installed is a different feature, and it
 * is a bigger one: a webfont is a file to host, a licence to honour and a
 * render-blocking request to budget for. This ships the stack, not the file.
 */
export function isFontStack(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VALUE * 2) return false;

  return /^[a-z0-9 ,'"-]+$/i.test(trimmed);
}
