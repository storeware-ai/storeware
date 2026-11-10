import { describe, expect, it } from 'vitest';
import { isSafeHref } from './href';
import { parseSection } from './sections';

/**
 * The link check, and specifically the hole it was written to close.
 *
 * A theme can be written by somebody who is not the merchant, and a band's
 * call-to-action renders as a plain anchor on the shop's own domain under the
 * merchant's own brand. So a link this predicate lets through is a link a
 * merchant publishes without knowing they did.
 */
describe('what a link may be', () => {
  it.each(['/collections/new', '/', '#reviews', 'https://example.test/a', 'mailto:a@b.test'])(
    'allows %s',
    (href) => {
      expect(isSafeHref(href)).toBe(true);
    },
  );

  /*
   * The one that mattered. All four implementations this replaced accepted it,
   * because all four asked "does it start with a slash" and it does.
   */
  it.each(['//evil.test', '//evil.test/checkout', '  //evil.test', '///evil.test'])(
    'refuses the protocol-relative %s',
    (href) => {
      expect(isSafeHref(href)).toBe(false);
    },
  );

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    'http://example.test',
    'tel:+441234567890',
    'ftp://example.test',
    'file:///etc/passwd',
  ])('refuses %s', (href) => {
    expect(isSafeHref(href)).toBe(false);
  });

  /*
   * A scheme is case insensitive to a browser. The registry's own copy of this
   * rule was case sensitive, which is the kind of difference between four
   * implementations that nobody notices until one of them is the one being
   * tested.
   */
  it('compares the scheme case insensitively', () => {
    expect(isSafeHref('HTTPS://example.test')).toBe(true);
    expect(isSafeHref('MailTo:a@b.test')).toBe(true);
  });

  it('trims before judging, so leading space cannot smuggle a scheme past', () => {
    expect(isSafeHref('  https://example.test')).toBe(true);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
  });
});

/**
 * The predicate reaching the place it actually protects.
 *
 * `isSafeHref` being right is worth nothing if the registry keeps its own copy,
 * which is exactly the state this replaced. A `cta_bar` renders `ctaHref`
 * directly into an anchor with no interstitial.
 */
describe('a band cannot carry a link the predicate refuses', () => {
  it('drops a protocol-relative call to action', () => {
    const parsed = parseSection({
      type: 'cta_bar',
      heading: 'Shop the sale',
      buttonLabel: 'Go',
      href: '//evil.test/checkout',
    });

    // The setting fails, and a failed setting that is not a `select` takes its
    // band with it rather than rendering a link nobody meant to publish.
    expect(parsed).toBeNull();
  });

  it('drops a javascript: call to action whatever its casing', () => {
    expect(
      parseSection({ type: 'cta_bar', buttonLabel: 'Go', href: 'JavaScript:alert(1)' }),
    ).toBeNull();
  });

  it('keeps an ordinary one', () => {
    const parsed = parseSection({ type: 'cta_bar', buttonLabel: 'Go', href: '/collections/sale' });
    expect(parsed?.href).toBe('/collections/sale');
  });

  /*
   * The limit of what this check can promise, asserted so nobody mistakes it
   * for more.
   *
   * `PARSERS` are `.passthrough()`, deliberately: an older deploy reading a
   * layout a newer one wrote must hand the unknown settings back unchanged
   * rather than quietly deleting a merchant's work. The cost is that a setting
   * the registry does not declare is not validated by anything, and this test
   * was written with the wrong field name (`ctaHref` rather than `href`) and
   * PASSED a protocol-relative URL through on the first run.
   *
   * Nothing renders an undeclared setting, so this is not an injection. It is
   * the reason a marketplace cannot say "every setting parsed" using
   * `parseSection` alone: an untrusted file needs a STRICT pass that refuses
   * unknown keys, which is a different check living somewhere that is allowed
   * to reject rather than tolerate.
   */
  it('passes an undeclared setting through unjudged, which is why a strict pass is owed', () => {
    const parsed = parseSection({ type: 'cta_bar', ctaHref: 'javascript:alert(1)' });

    expect(parsed).not.toBeNull();
    expect(parsed?.['ctaHref']).toBe('javascript:alert(1)');
  });
});
