import { describe, expect, it } from 'vitest';
import { components, MAX_COMPONENT_NODES, parseComponents } from './components';
import { ManifestError, parseManifest, settingAccepts } from './manifest';

const BASE = `
[app]
slug = "reviews-plus"
name = "Reviews Plus"
url = "https://reviews.example.com/app"

[oauth]
scopes = ["products:read", "checkout:read"]
`;

function problemsOf(source: string): string[] {
  try {
    parseManifest(source);
    return [];
  } catch (error) {
    if (error instanceof ManifestError) return [...error.issues];
    throw error;
  }
}

describe('the extension sections of a manifest', () => {
  it('parses settings, sections, a proxy, automations and delivery rates', () => {
    const manifest = parseManifest(`${BASE}
[[settings]]
key = "badge_text"
label = "Badge text"
type = "single_line_text"
default = "Loved by shoppers"

[[settings]]
key = "api_key"
label = "Your API key"
type = "secret"
required = true

[[settings]]
key = "layout"
label = "Layout"
type = "select"
default = "grid"
options = [{ value = "grid", label = "Grid" }, { value = "list", label = "List" }]

[[extensions.sections]]
handle = "review_wall"
name = "Review wall"
url = "https://reviews.example.com/sections/wall"

[[extensions.storefront]]
block = "storefront.product.below_description"
url = "https://reviews.example.com/blocks/stars"
format = "components"

[app_proxy]
url = "https://reviews.example.com/proxy"

[[automations.triggers]]
key = "review_left"
label = "A review was left"
fields = [{ key = "rating", label = "Rating", type = "number" }]

[[automations.actions]]
key = "ask_for_review"
label = "Ask for a review"
url = "https://reviews.example.com/actions/ask"
fields = [{ key = "delay_days", label = "Days to wait", type = "number", required = true }]

[checkout.delivery_rates]
url = "https://reviews.example.com/rates"
`);
    expect(manifest.settings?.map((field) => field.key)).toEqual([
      'badge_text',
      'api_key',
      'layout',
    ]);
    expect(manifest.extensions?.sections?.[0]?.format).toBe('components');
    expect(manifest.extensions?.storefront?.[0]?.format).toBe('components');
    expect(manifest.app_proxy?.url).toBe('https://reviews.example.com/proxy');
    expect(manifest.automations?.triggers[0]?.fields[0]?.type).toBe('number');
    expect(manifest.automations?.actions[0]?.fields[0]?.required).toBe(true);
    expect(manifest.checkout?.delivery_rates?.url).toBe('https://reviews.example.com/rates');
  });

  it('keeps a block answering in html unless it says otherwise', () => {
    const manifest = parseManifest(`${BASE}
[[extensions.storefront]]
block = "storefront.cart.summary"
url = "https://reviews.example.com/blocks/cart"
`);
    expect(manifest.extensions?.storefront?.[0]?.format).toBe('html');
  });

  it('refuses a secret with a default, a select without options and a default of the wrong kind', () => {
    const problems = problemsOf(`${BASE}
[[settings]]
key = "token"
label = "Token"
type = "secret"
default = "shared"

[[settings]]
key = "mode"
label = "Mode"
type = "select"

[[settings]]
key = "count"
label = "How many"
type = "integer"
default = "four"
`);
    expect(problems).toEqual([
      'settings.token: a secret has no default, or every shop would share it',
      'settings.mode: a select needs options',
      'settings.count: the default is not a integer',
    ]);
  });

  it('refuses two settings, sections, triggers or actions with one key', () => {
    const problems = problemsOf(`${BASE}
[[settings]]
key = "same_key"
label = "A"
type = "boolean"
[[settings]]
key = "same_key"
label = "Again"
type = "boolean"

[[extensions.sections]]
handle = "wall"
name = "Wall"
url = "https://reviews.example.com/a"
[[extensions.sections]]
handle = "wall"
name = "Wall again"
url = "https://reviews.example.com/b"

[[automations.triggers]]
key = "left"
label = "Left"
[[automations.triggers]]
key = "left"
label = "Left again"
`);
    expect(problems).toContain('settings: two fields share a key');
    expect(problems).toContain('extensions.sections: two sections share a handle');
    expect(problems).toContain('automations.triggers: two triggers share a key');
  });

  it('refuses delivery rates without checkout:read, which the address and basket need', () => {
    const source = `${BASE.replace('"products:read", "checkout:read"', '"products:read"')}
[checkout.delivery_rates]
url = "https://reviews.example.com/rates"
`;
    expect(problemsOf(source)).toEqual([
      'checkout.delivery_rates: needs checkout:read, which oauth.scopes does not request',
    ]);
  });

  it('refuses a trigger key with digits, which an event name cannot carry', () => {
    expect(() =>
      parseManifest(`${BASE}
[[automations.triggers]]
key = "review_5"
label = "Five stars"
`),
    ).toThrow(ManifestError);
  });
});

describe('what a setting accepts', () => {
  const field = (type: string, extra: object = {}) =>
    ({ key: 'k', label: 'K', type, required: false, ...extra }) as Parameters<
      typeof settingAccepts
    >[0];

  it('checks each kind of value', () => {
    expect(settingAccepts(field('boolean'), true)).toBe(true);
    expect(settingAccepts(field('boolean'), 'true')).toBe(false);
    expect(settingAccepts(field('integer'), 3)).toBe(true);
    expect(settingAccepts(field('integer'), 3.5)).toBe(false);
    expect(settingAccepts(field('decimal'), 3.5)).toBe(true);
    expect(settingAccepts(field('url'), 'https://a.example')).toBe(true);
    expect(settingAccepts(field('url'), 'javascript:alert(1)')).toBe(false);
    expect(settingAccepts(field('color'), '#1A2B3C')).toBe(true);
    expect(settingAccepts(field('color'), 'red')).toBe(false);
    expect(settingAccepts(field('single_line_text'), 'one\ntwo')).toBe(false);
    expect(settingAccepts(field('multi_line_text'), 'one\ntwo')).toBe(true);
    const select = field('select', {
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(settingAccepts(select, 'a')).toBe(true);
    expect(settingAccepts(select, 'c')).toBe(false);
  });
});

describe('components', () => {
  it('accepts a tree the shop front can draw', () => {
    const answer = components(
      { type: 'heading', text: 'What shoppers say', level: 2 },
      { type: 'rating', value: 4.6, count: 212 },
      {
        type: 'accordion',
        items: [{ title: 'Sizing', children: [{ type: 'text', text: 'Runs small.' }] }],
      },
      { type: 'image', src: 'https://cdn.mystoreware.com/apps/reviews-plus/a.jpg', alt: '' },
      { type: 'button_link', text: 'Read all', href: '/apps/reviews-plus/all' },
    );
    expect(answer.components).toHaveLength(5);
  });

  it('refuses an image from another host and a link that runs script', () => {
    const result = parseComponents({
      components: [
        { type: 'image', src: 'https://tracker.example.com/pixel.gif', alt: '' },
        { type: 'link', text: 'Go', href: 'javascript:alert(1)' },
        { type: 'link', text: 'Go', href: '//evil.example.com' },
        { type: 'link', text: 'Go', href: '/\t/evil.example.com' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(4);
  });

  it('refuses a node it does not know, and a key a node does not have', () => {
    expect(parseComponents({ components: [{ type: 'script', text: 'x' }] }).ok).toBe(false);
    expect(
      parseComponents({ components: [{ type: 'text', text: 'x', style: 'color:red' }] }).ok,
    ).toBe(false);
  });

  it(`refuses more than ${MAX_COMPONENT_NODES} nodes, counting children`, () => {
    const many = Array.from({ length: 20 }, () => ({
      type: 'stack' as const,
      children: Array.from({ length: 10 }, () => ({ type: 'text' as const, text: 'x' })),
    }));
    const result = parseComponents({ components: many });
    expect(result.ok).toBe(false);
  });

  it('refuses a tree nested deeper than four', () => {
    const deep = {
      type: 'stack',
      children: [
        {
          type: 'stack',
          children: [
            {
              type: 'stack',
              children: [{ type: 'stack', children: [{ type: 'text', text: 'x' }] }],
            },
          ],
        },
      ],
    };
    expect(parseComponents({ components: [deep] }).ok).toBe(false);
  });
});
