/**
 * The one place a link is judged safe.
 *
 * ## Why this file exists
 *
 * Four separate implementations of this rule were found in the platform, and
 * they disagreed:
 *
 *   - the plugin block sanitiser lowercased first, this did not
 *   - the section registry's `url` field was case sensitive, so `HTTPS://x`
 *     failed and `Javascript:` was not the thing being tested for anyway
 *   - the prose sanitiser worked from a scheme allow-list and also permitted `tel:`
 *   - the menu editor parsed with `new URL()` and permitted plain `http:`
 *
 * Two of those four are now this function: the section registry's `url` field
 * and the plugin block sanitiser. Those are the two that judge a link supplied
 * by SOMEBODY OTHER THAN THE MERCHANT, which is why they must agree exactly.
 *
 * The other two stay separate, and the difference is deliberate rather than
 * leftover. The prose sanitiser judges body text a merchant typed themselves
 * and keeps a wider list including `tel:`, because a merchant writing their own
 * About page may reasonably link a phone number. The menu editor parses with
 * `new URL()` and permits `http:`, because a merchant adding a link to their own
 * supplier's site is entitled to a wrong opinion about that site's TLS. Neither
 * has the hole described below: `new URL('//evil.test')` throws with no base,
 * and the sanitiser sets `allowProtocolRelative: false`.
 *
 * (One thing worth fixing next door: the menu editor's refusal message says the
 * address "needs to start with https://" while the code accepts `http:` too.)
 *
 * ## The hole all four shared
 *
 * `//evil.test/checkout` inherits the page's scheme. It is a fully qualified
 * link to somebody else's server, and every check that asked "does it start
 * with a slash" said yes. The prose sanitiser had already named this in a
 * comment, about its neighbour rather than about itself:
 *
 *   "`//evil.test` inherits the page's scheme and reads as a path to anything
 *    checking the first character. It is a fully qualified link to somebody
 *    else's server, and it is the one hole the neighbouring `isSafeHref` still
 *    has, since that function accepts anything starting with a slash."
 *
 * It mattered more once a theme could be written by somebody other than the
 * merchant. A band's call-to-action is rendered as a plain anchor on the shop's
 * own domain, under the merchant's own brand, with no interstitial: a link a
 * merchant would never knowingly publish, published by them.
 *
 * ## What is allowed, and why the list is this short
 *
 * A path, a fragment, an absolute `https:` URL, or `mailto:`. Nothing else.
 *
 * `javascript:` is the reason a check exists at all. `data:` is the other one,
 * because a data URL can carry a whole HTML document and a link to one runs it
 * on the merchant's origin. `http:` is excluded because a shop is served over
 * TLS and a plain-http link is either downgraded, blocked as mixed content, or
 * a quiet way to move a shopper onto an unencrypted page. `tel:` is excluded
 * because no field that uses this predicate collects a phone number; the prose
 * sanitiser keeps its own wider list for body text a merchant typed themselves.
 */
export function isSafeHref(value: string): boolean {
  const trimmed = value.trim();

  /*
   * Before anything else, and deliberately not folded into the checks below.
   *
   * A protocol-relative URL starts with a slash and is not a path, so every
   * ordering that tests "starts with /" first gets this wrong. Testing it first
   * makes the exclusion impossible to lose in a later edit.
   */
  if (trimmed.startsWith('//')) return false;

  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;

  // Lowercased only for the scheme comparison. A scheme is case insensitive to
  // a browser, so `HTTPS://` and `JavaScript:` are the same links the lowercase
  // spellings are, and a check that misses that is a check somebody walks past.
  const scheme = trimmed.toLowerCase();
  return scheme.startsWith('https://') || scheme.startsWith('mailto:');
}
