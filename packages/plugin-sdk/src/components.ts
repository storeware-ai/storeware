import { z } from 'zod';

/**
 * Components: what an app's block, section or proxy page can answer with
 * instead of HTML.
 *
 * Storeware draws each node itself, in the shop's own type, colours and
 * spacing, so an app looks native on every theme without shipping a single
 * style. Nothing here can run script, load a font or reach another host:
 * links go where a shopper can see, images come only from Storeware's own
 * media host, and a tree is at most `MAX_COMPONENT_NODES` nodes.
 *
 * Answer with `{ "components": [ ... ] }` and the content type
 * `application/vnd.storeware.components+json`, or name `format =
 * "components"` in the manifest.
 */

export const COMPONENTS_CONTENT_TYPE = 'application/vnd.storeware.components+json';

/** The most nodes one answer may hold, counting every child. */
export const MAX_COMPONENT_NODES = 200;

/**
 * The one host an image may come from. An app puts an image there with
 * `POST /api/v1/app/assets`, which needs no scope, and uses the URL it gets.
 */
export const COMPONENT_IMAGE_HOSTS = ['cdn.mystoreware.com'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * A link a shopper follows: https anywhere, or a path on the shop itself.
 * Never `javascript:`, `data:` or a protocol-relative `//host`.
 */
const href = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      // A browser drops tabs and line breaks from an address, so `/\t/host`
      // would leave the shop. No whitespace or control character at all.
      if (/\s/.test(value)) return false;
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return false;
      }
      if (value.startsWith('/')) return !value.startsWith('//') && !value.includes('\\');
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an https address or a path on the shop, starting with /' },
  );

const imageSrc = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          (COMPONENT_IMAGE_HOSTS as readonly string[]).includes(url.hostname)
        );
      } catch {
        return false;
      }
    },
    { message: `must be an image on ${COMPONENT_IMAGE_HOSTS.join(' or ')}` },
  );

/** The tones a badge or notice can take, drawn from the theme's own colours. */
export const COMPONENT_TONES = ['neutral', 'info', 'success', 'warning', 'critical'] as const;

export type ComponentNode =
  | { type: 'heading'; text: string; level?: 2 | 3 | 4 | undefined }
  | { type: 'text'; text: string; emphasis?: 'strong' | 'subdued' | undefined }
  | { type: 'list'; items: string[]; ordered?: boolean | undefined }
  | { type: 'table'; head?: string[] | undefined; rows: string[][] }
  | { type: 'rating'; value: number; count?: number | undefined; label?: string | undefined }
  | { type: 'badge'; text: string; tone?: (typeof COMPONENT_TONES)[number] | undefined }
  | {
      type: 'image';
      src: string;
      alt: string;
      width?: number | undefined;
      height?: number | undefined;
    }
  | { type: 'link'; text: string; href: string }
  | { type: 'button_link'; text: string; href: string }
  | { type: 'accordion'; items: { title: string; children: ComponentNode[] }[] }
  | {
      type: 'notice';
      text: string;
      tone?: (typeof COMPONENT_TONES)[number] | undefined;
      title?: string | undefined;
    }
  | { type: 'stack'; children: ComponentNode[]; direction?: 'row' | 'column' | undefined };

export type ComponentType = ComponentNode['type'];

export const COMPONENT_TYPES = [
  'heading',
  'text',
  'list',
  'table',
  'rating',
  'badge',
  'image',
  'link',
  'button_link',
  'accordion',
  'notice',
  'stack',
] as const satisfies readonly ComponentType[];

export const componentNodeSchema: z.ZodType<ComponentNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('heading'),
        text: text(200),
        level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('text'),
        text: text(2000),
        emphasis: z.enum(['strong', 'subdued']).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('list'),
        items: z.array(text(500)).min(1).max(50),
        ordered: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('table'),
        head: z.array(z.string().max(200)).max(8).optional(),
        rows: z
          .array(z.array(z.string().max(500)).min(1).max(8))
          .min(1)
          .max(50),
      })
      .strict(),
    z
      .object({
        type: z.literal('rating'),
        value: z.number().min(0).max(5),
        count: z.number().int().min(0).max(100_000_000).optional(),
        label: text(100).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('badge'),
        text: text(40),
        tone: z.enum(COMPONENT_TONES).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('image'),
        src: imageSrc,
        alt: z.string().trim().max(300),
        width: z.number().int().min(1).max(4000).optional(),
        height: z.number().int().min(1).max(4000).optional(),
      })
      .strict(),
    z.object({ type: z.literal('link'), text: text(200), href }).strict(),
    z.object({ type: z.literal('button_link'), text: text(60), href }).strict(),
    z
      .object({
        type: z.literal('accordion'),
        items: z
          .array(
            z.object({ title: text(200), children: z.array(componentNodeSchema).max(20) }).strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    z
      .object({
        type: z.literal('notice'),
        text: text(1000),
        tone: z.enum(COMPONENT_TONES).optional(),
        title: text(120).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('stack'),
        children: z.array(componentNodeSchema).max(30),
        direction: z.enum(['row', 'column']).optional(),
      })
      .strict(),
  ]),
);

/** Every node in a tree, children included. */
export function countComponentNodes(nodes: readonly ComponentNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.type === 'stack') count += countComponentNodes(node.children);
    if (node.type === 'accordion') {
      for (const item of node.items) count += countComponentNodes(item.children);
    }
  }
  return count;
}

/** How deep a tree goes; a stack inside a stack is two. */
export function componentDepth(nodes: readonly ComponentNode[]): number {
  let deepest = 0;
  for (const node of nodes) {
    let below = 0;
    if (node.type === 'stack') below = componentDepth(node.children);
    if (node.type === 'accordion') {
      below = Math.max(0, ...node.items.map((item) => componentDepth(item.children)));
    }
    deepest = Math.max(deepest, 1 + below);
  }
  return deepest;
}

/** The deepest a tree may nest. Enough for an accordion of stacks. */
export const MAX_COMPONENT_DEPTH = 4;

/** What an app answers with: `{ components: [...] }`. */
export const componentsAnswerSchema = z
  .object({ components: z.array(componentNodeSchema).min(1).max(MAX_COMPONENT_NODES) })
  .strict()
  .superRefine((answer, ctx) => {
    if (countComponentNodes(answer.components) > MAX_COMPONENT_NODES) {
      ctx.addIssue({
        code: 'custom',
        message: `holds more than ${MAX_COMPONENT_NODES} nodes`,
        path: ['components'],
      });
    }
    if (componentDepth(answer.components) > MAX_COMPONENT_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        message: `nests deeper than ${MAX_COMPONENT_DEPTH}`,
        path: ['components'],
      });
    }
  });

export type ComponentsAnswer = z.infer<typeof componentsAnswerSchema>;

/**
 * Parses an answer, or says why it cannot be drawn. Storeware runs the same
 * check, so a tree this accepts is a tree the shop front draws.
 */
export function parseComponents(
  value: unknown,
): { ok: true; components: ComponentNode[] } | { ok: false; problems: string[] } {
  const result = componentsAnswerSchema.safeParse(value);
  if (result.success) return { ok: true, components: result.data.components };
  return {
    ok: false,
    problems: result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`,
    ),
  };
}

/** Builds an answer, checked, so a mistake shows in development, not on a shop. */
export function components(...nodes: ComponentNode[]): ComponentsAnswer {
  const parsed = parseComponents({ components: nodes });
  if (!parsed.ok)
    throw new Error(`These components cannot be drawn:\n  ${parsed.problems.join('\n  ')}`);
  return { components: parsed.components };
}
