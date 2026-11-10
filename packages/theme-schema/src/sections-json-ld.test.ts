import { describe, expect, it } from 'vitest';
import { sectionsJsonLd } from './sections';

/**
 * What a page says to the readers that cannot see it.
 *
 * The argument this file is here to protect: on a platform with a template
 * language, a merchant's FAQ is a pile of divs and the only way to tell a
 * machine it is a list of answers is to ask them to write structured data too,
 * which nobody does. Here the band already knows what it is, so the same act
 * that put it on the page emits the markup that says so, and neither the
 * merchant nor the model that wrote it had to know this existed.
 */

describe('the structured data a page adds up to', () => {
  it('turns an FAQ band into questions a search engine can read', () => {
    const graph = sectionsJsonLd([
      {
        type: 'faq',
        heading: 'Questions',
        blocks: [
          { type: 'question', question: 'Do you ship abroad?', answer: 'Yes, everywhere.' },
          { type: 'question', question: 'How long do returns take?', answer: 'About a week.' },
        ],
      },
    ]);

    expect(graph).toEqual([
      {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'Do you ship abroad?',
            acceptedAnswer: { '@type': 'Answer', text: 'Yes, everywhere.' },
          },
          {
            '@type': 'Question',
            name: 'How long do returns take?',
            acceptedAnswer: { '@type': 'Answer', text: 'About a week.' },
          },
        ],
      },
    ]);
  });

  it('leaves out a question nobody answered', () => {
    // A `Question` with no `acceptedAnswer` is invalid markup, and the entry a
    // merchant has not finished writing is exactly the one missing its answer.
    const graph = sectionsJsonLd([
      {
        type: 'faq',
        blocks: [
          { type: 'question', question: 'Do you ship abroad?' },
          { type: 'question', question: 'Returns?', answer: 'About a week.' },
        ],
      },
    ]);

    expect(graph[0]).toMatchObject({ mainEntity: [{ name: 'Returns?' }] });
  });

  it('says nothing at all for an FAQ with nothing in it', () => {
    expect(sectionsJsonLd([{ type: 'faq', heading: 'Questions' }])).toEqual([]);
  });

  it('says nothing for the bands that have nothing honest to say', () => {
    expect(sectionsJsonLd([{ type: 'intro' }, { type: 'products' }, { type: 'spacer' }])).toEqual(
      [],
    );
  });

  /**
   * Two deliberate silences, both about not making a claim on the merchant's
   * behalf.
   *
   * `Review` markup for quotes a merchant wrote themselves is a self-serving
   * review, which search engines penalise. `MerchantReturnPolicy` wants a
   * return window and a fee the band does not carry, and filling them in is
   * inventing a commitment, which is the one thing the whole feature refuses to
   * do anywhere else.
   */
  it.each(['testimonials', 'policy_badges'])('stays quiet about %s', (type) => {
    expect(
      sectionsJsonLd([
        { type, heading: 'What people say', blocks: [{ type: 'testimonial', quote: 'Lovely' }] },
      ]),
    ).toEqual([]);
  });

  it('collects every band that has something to say, in order', () => {
    const graph = sectionsJsonLd([
      { type: 'intro' },
      { type: 'faq', blocks: [{ type: 'question', question: 'A?', answer: 'B.' }] },
      { type: 'faq', blocks: [{ type: 'question', question: 'C?', answer: 'D.' }] },
    ]);

    expect(graph).toHaveLength(2);
  });
});
