import { describe, expect, it } from 'vitest';
import { REFUSED_IN_A_LISTING, strictTemplates } from './strict';
import { parseSection } from './sections';

/**
 * What a theme from a stranger may contain.
 *
 * Listings on this platform are self-serve, so nothing human stands between an
 * author and a merchant's live shop. These rules are the whole of what does.
 */

const carries = (name: string) => name === 'hero.jpg';
const listing = { thirdParty: true, resolvesPicture: carries };

const at = (problems: { at: string }[]) => problems.map((p) => p.at);

describe('the gap between reading a layout and accepting one', () => {
  /*
   * The reason this module exists. `parseSection` is `.passthrough()`, so an
   * undeclared setting is stored unvalidated forever. Nothing renders one
   * today, which is a fact about today's renderer rather than about the file.
   */
  it('refuses a setting the band does not declare, where the parser keeps it', () => {
    const band = { type: 'cta_bar', ctaHref: 'javascript:alert(1)' };

    // The forgiving reader keeps it, unjudged.
    expect(parseSection(band)?.['ctaHref']).toBe('javascript:alert(1)');

    // The strict one refuses the file.
    expect(at(strictTemplates({ home: [band] }, listing))).toContain('templates.home[0].ctaHref');
  });

  it('refuses a band type it does not know, where the parser drops it silently', () => {
    expect(parseSection({ type: 'liquid' })).toBeNull();
    expect(at(strictTemplates({ home: [{ type: 'liquid' }] }, listing))).toEqual([
      'templates.home[0].type',
    ]);
  });

  it('refuses a page over the band limit, where the parser truncates it', () => {
    const many = Array.from({ length: 13 }, () => ({ type: 'note' }));
    expect(at(strictTemplates({ home: many }, listing))).toContain('templates.home');
  });
});

describe('bands that may not travel in a listing', () => {
  /*
   * The one that carries the whole argument. An app band's content is fetched
   * from a third party on every render, so a theme carrying one is a live link
   * rather than a copy the merchant owns, which is exactly the property that
   * separates a theme from a plugin.
   */
  it('refuses an app band', () => {
    const problems = strictTemplates({ home: [{ type: REFUSED_IN_A_LISTING }] }, listing);

    expect(at(problems)).toContain('templates.home[0].type');
    expect(problems[0]?.says).toContain('fetched from a third party');
  });

  it('refuses a section from an app, once, for the same reason', () => {
    const problems = strictTemplates(
      { home: [{ type: 'app_block', app: 'size-guide', section: 'chart' }] },
      listing,
    );

    expect(at(problems)).toEqual(['templates.home[0].type']);
    expect(problems[0]?.says).toContain('fetched from a third party');
  });

  it.each(['testimonials', 'logo_list', 'countdown', 'figures', 'comparison'])(
    'refuses %s, which the platform also refuses to generate',
    (type) => {
      expect(at(strictTemplates({ home: [{ type }] }, listing))).toContain(
        'templates.home[0].type',
      );
    },
  );

  /*
   * The same bands are fine in a merchant's own export of their own shop: a
   * testimonial there is a real customer's words. The rule is about who wrote
   * them, and only the caller knows that.
   */
  it("allows them back when the file is the shop's own", () => {
    const own = { thirdParty: false, resolvesPicture: carries };
    expect(strictTemplates({ home: [{ type: 'testimonials' }] }, own)).toEqual([]);
  });
});

describe('pictures', () => {
  it('refuses a raw media id, which would resolve to nothing in another shop', () => {
    const problems = strictTemplates(
      { home: [{ type: 'hero', image: '11111111-1111-4111-8111-111111111111' }] },
      listing,
    );

    expect(at(problems)).toContain('templates.home[0].image');
    expect(problems[0]?.says).toContain('exported from');
  });

  it('refuses a picture the theme does not carry', () => {
    expect(
      at(strictTemplates({ home: [{ type: 'hero', image: 'missing.jpg' }] }, listing)),
    ).toContain('templates.home[0].image');
  });

  it('accepts one it does', () => {
    expect(strictTemplates({ home: [{ type: 'hero', image: 'hero.jpg' }] }, listing)).toEqual([]);
  });

  /*
   * With no resolver the caller has not decided what a picture reference means,
   * and the safe reading of that is that none is allowed. A default that let
   * every name through would make forgetting the option indistinguishable from
   * choosing it.
   */
  it('refuses every picture when the caller supplied no resolver', () => {
    expect(
      at(strictTemplates({ home: [{ type: 'hero', image: 'hero.jpg' }] }, { thirdParty: true })),
    ).toContain('templates.home[0].image');
  });
});

describe('links', () => {
  it.each(['//evil.test/checkout', 'javascript:alert(1)', 'http://example.test'])(
    'refuses %s',
    (href) => {
      const problems = strictTemplates(
        { home: [{ type: 'cta_bar', buttonLabel: 'Go', href }] },
        listing,
      );
      expect(at(problems)).toContain('templates.home[0].href');
    },
  );

  it('accepts an ordinary path', () => {
    expect(
      strictTemplates({ home: [{ type: 'cta_bar', buttonLabel: 'Go', href: '/sale' }] }, listing),
    ).toEqual([]);
  });
});

describe('blocks', () => {
  it('refuses more than the band holds', () => {
    const blocks = Array.from({ length: 30 }, (_, i) => ({
      type: 'question',
      question: `Q${i}`,
      answer: 'A',
    }));

    expect(at(strictTemplates({ home: [{ type: 'faq', blocks }] }, listing))).toContain(
      'templates.home[0].blocks',
    );
  });

  it('refuses an undeclared block setting', () => {
    const problems = strictTemplates(
      { home: [{ type: 'faq', blocks: [{ type: 'question', onclick: 'x' }] }] },
      listing,
    );

    expect(at(problems)).toContain('templates.home[0].blocks[0].onclick');
  });

  it('refuses blocks on a band that takes none', () => {
    expect(at(strictTemplates({ home: [{ type: 'note', blocks: [] }] }, listing))).toContain(
      'templates.home[0].blocks',
    );
  });
});

describe('pages', () => {
  it('refuses a page the platform does not render', () => {
    expect(at(strictTemplates({ liquid: [] }, listing))).toContain('templates.liquid');
  });

  it('refuses a band on a page it does not belong on', () => {
    expect(at(strictTemplates({ home: [{ type: 'article_body' }] }, listing))).toContain(
      'templates.home[0].type',
    );
  });
});

describe('reporting', () => {
  /*
   * Every problem, not the first. Somebody fixing a theme wants the whole list;
   * a tool that reports one error per run is a tool run twenty times.
   */
  it('collects every problem in one pass', () => {
    const problems = strictTemplates(
      {
        home: [
          { type: 'cta_bar', href: '//evil.test', onclick: 'x' },
          { type: REFUSED_IN_A_LISTING },
          { type: 'hero', image: 'missing.jpg' },
        ],
      },
      listing,
    );

    // One problem per address, so a list somebody is working through never
    // repeats itself. An app band carries `neverGenerated` too and is refused
    // once, for the reason that is actually about it.
    expect(at(problems)).toEqual([
      'templates.home[0].onclick',
      'templates.home[0].href',
      'templates.home[1].type',
      'templates.home[2].image',
    ]);
  });

  it('says nothing at all about a theme that is fine', () => {
    expect(
      strictTemplates(
        {
          home: [
            { type: 'hero', heading: 'Leather, made in Bristol', image: 'hero.jpg' },
            { type: 'products', limit: 12 },
            { type: 'cta_bar', buttonLabel: 'Shop', href: '/collections/all' },
          ],
          page: [{ type: 'page_body' }],
        },
        listing,
      ),
    ).toEqual([]);
  });
});
