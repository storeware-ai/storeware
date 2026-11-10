import { describe, expect, it } from 'vitest';
import {
  SECTION_DEFINITIONS as REGISTRY,
  parseSection,
  type FieldDefinition,
  type SectionDefinition,
} from './sections';

// Widened from the registry's literal types, so a search can ask about `blocks`.
const SECTION_DEFINITIONS: readonly SectionDefinition[] = REGISTRY;

/**
 * What every stored band reads back as, recorded.
 *
 * Every layout on the platform is read through `parseSection` on each request,
 * so a change in what it accepts is a change to live pages: a band that stops
 * parsing is a band that silently vanishes from a shop, on a page nobody at the
 * platform is looking at. That is the risk of moving zod from 3 to 4, where a
 * uuid became RFC 9562 strict, a record keyed by an enum became exhaustive, and
 * a `.default()` stopped running what follows it.
 *
 * So this records the parsed result of one band of every type with every
 * setting filled, and of the awkward cases a stored row really holds, and the
 * upgrade has to leave the record byte-identical. A change here is a change to
 * what a merchant's shop draws.
 */

/** A version 4 id, which any reading of "uuid" accepts. */
const PICTURE = '22222222-2222-4222-8222-222222222222';

/**
 * An id zod 3 accepted and RFC 9562 does not: its variant digit is a 4.
 *
 * Fixtures on this platform are written this way (`theme-file.v2.json`), and a
 * stored layout is whatever a merchant's editor wrote at the time, so a reader
 * that starts refusing this shape drops a band from a live page.
 */
const LOOSE_PICTURE = '11111111-2222-3333-4444-555555555555';

/** Values worth trying for a field, in order. The first one its schema takes is used. */
function candidates(field: FieldDefinition): unknown[] {
  switch (field.kind) {
    case 'text':
      return ['A heading'];
    case 'richtext':
      return ['<p>Body copy</p>'];
    case 'number':
      return [field.min, field.fallback, 1, 3].filter((value) => typeof value === 'number');
    case 'boolean':
      return [true];
    case 'select':
      return (field.choices ?? []).map((choice) => choice.value);
    case 'colour':
      return ['#1a2b3c', 'accent'];
    case 'media':
      return [PICTURE];
    case 'product':
    case 'collection':
    case 'blog':
      return ['oak-chair'];
    case 'url':
      return ['/collections/seating', 'https://example.com/journal'];
  }
}

/** Every setting given the first value its own schema accepts. */
function filled(settings: readonly FieldDefinition[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of settings) {
    const value = candidates(field).find((candidate) => field.schema.safeParse(candidate).success);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

/** One band of a type with everything filled, and two blocks when it takes them. */
function band(type: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const definition = SECTION_DEFINITIONS.find((d) => d.type === type)!;
  return {
    type,
    id: 'band01',
    ...filled(definition.settings),
    ...(definition.blocks
      ? {
          blocks: [
            { type: definition.blocks.type, id: 'block01', ...filled(definition.blocks.settings) },
            { type: definition.blocks.type, id: 'block02', ...filled(definition.blocks.settings) },
          ],
        }
      : {}),
    ...over,
  };
}

/** The first band with a setting of this kind, and that setting. */
function firstWith(kind: FieldDefinition['kind']): { type: string; field: FieldDefinition } {
  for (const definition of SECTION_DEFINITIONS) {
    const field = definition.settings.find((s) => s.kind === kind);
    if (field) return { type: definition.type, field };
  }
  throw new Error(`No band has a ${kind} setting.`);
}

/** Keys sorted, so a diff shows what changed rather than what moved. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])]),
  );
}

const golden = (value: unknown) => `${JSON.stringify(canonical(value), null, 2)}\n`;

describe('what a stored band reads back as', () => {
  it('every band, every setting filled', async () => {
    const read = Object.fromEntries(
      SECTION_DEFINITIONS.map((definition) => [
        definition.type,
        parseSection(band(definition.type)),
      ]),
    );

    await expect(golden(read)).toMatchFileSnapshot('./__stored__/every-band.json');
  });

  it('the awkward rows', async () => {
    const media = firstWith('media');
    const select = firstWith('select');
    const url = firstWith('url');
    const text = firstWith('text');
    const number = SECTION_DEFINITIONS.flatMap((d) =>
      d.settings.map((field) => ({ type: d.type, field })),
    ).find(({ field }) => field.kind === 'number' && typeof field.max === 'number')!;
    const withBlocks = SECTION_DEFINITIONS.find((d) => d.blocks)!;

    const cases: Record<string, unknown> = {
      'a picture id zod 3 took and RFC 9562 does not': band(media.type, {
        [media.field.name]: LOOSE_PICTURE,
      }),
      'a picture id that is not an id': band(media.type, { [media.field.name]: 'not-a-uuid' }),
      'a key this release does not know': band(text.type, { settingFromTheFuture: 'kept?' }),
      'a select value this release does not offer': band(select.type, {
        [select.field.name]: 'no-such-choice',
      }),
      'a link that is not safe': band(url.type, { [url.field.name]: 'javascript:alert(1)' }),
      'a number past its bound': band(number.type, { [number.field.name]: number.field.max! + 1 }),
      'text with space around it': band(text.type, { [text.field.name]: '  padded  ' }),
      'an id in the wrong shape': band(text.type, { id: 'NOT AN ID!' }),
      'no id at all': (() => {
        const { id: _id, ...rest } = band(text.type);
        return rest;
      })(),
      'a band this release cannot draw': { type: 'no-such-band', id: 'band01' },
      'more blocks than the band may hold': band(withBlocks.type, {
        blocks: Array.from({ length: withBlocks.blocks!.max + 2 }, (_, i) => ({
          type: withBlocks.blocks!.type,
          id: `block${String(i).padStart(2, '0')}`,
          ...filled(withBlocks.blocks!.settings),
        })),
      }),
      'a block of another band': band(withBlocks.type, {
        blocks: [{ type: 'not-this-bands-block', id: 'block01' }],
      }),
      'not an object': 'hero',
    };

    const read = Object.fromEntries(
      Object.entries(cases).map(([name, value]) => [name, parseSection(value)]),
    );

    await expect(golden(read)).toMatchFileSnapshot('./__stored__/awkward-rows.json');
  });
});
