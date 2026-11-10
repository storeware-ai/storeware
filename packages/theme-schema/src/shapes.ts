/**
 * The outline a picture is cut to, as an attribute the renderer can key rules
 * off. The sibling of `./schemes` and `./presets`: the values are a published
 * part of the format, the CSS behind them is not.
 *
 * `plain` is the picture's own rectangle and emits nothing, so a band nobody
 * has shaped draws the picture it always drew. Every other shape is a mask or
 * a radius in the stylesheet, never a second picture.
 */

/** The shapes a picture may take. `plain` is the picture as it is. */
export const PICTURE_SHAPES = [
  'plain',
  'arch',
  'circle',
  'pill',
  'blob',
  'ticket',
  'torn',
] as const;

export type PictureShape = (typeof PICTURE_SHAPES)[number];

/**
 * The attribute one picture's chosen shape is worth.
 *
 * Empty for `plain`, for nothing chosen, and for a shape this build has never
 * heard of, which is the rule `schemeAttributes` keeps: a shape from a later
 * release costs the picture its outline, never the band.
 */
export function shapeAttributes(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || value === 'plain') return {};
  if (!(PICTURE_SHAPES as readonly string[]).includes(value)) return {};

  return { 'data-sw-shape': value };
}
