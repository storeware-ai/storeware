import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_DESCRIPTIONS,
  MANIFEST_SCHEMA_URL,
  manifestJsonSchema,
  schemaPaths,
} from './manifest-schema';

const CHECKED_IN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema',
  'storeware.app.schema.json',
);

const schema = manifestJsonSchema();
const text = `${JSON.stringify(schema, null, 2)}\n`;

/** `pnpm schema:write` runs this file with the flag set, and it writes rather than compares. */
if (process.env['WRITE_MANIFEST_SCHEMA'] === '1') {
  mkdirSync(dirname(CHECKED_IN), { recursive: true });
  writeFileSync(CHECKED_IN, text);
}

describe('the manifest as JSON Schema', () => {
  it('describes every key, and nothing the schema does not have', () => {
    const paths = schemaPaths(schema as Parameters<typeof schemaPaths>[0]);
    expect(paths.length).toBeGreaterThan(50);
    expect(paths.filter((path) => !MANIFEST_DESCRIPTIONS[path])).toEqual([]);
    expect(Object.keys(MANIFEST_DESCRIPTIONS).filter((path) => !paths.includes(path))).toEqual([]);
  });

  it('says it in the words storeware.ai uses: no dashes, no exclamation marks', () => {
    for (const [path, words] of Object.entries(MANIFEST_DESCRIPTIONS)) {
      expect(words, path).not.toMatch(/[—–!]| - /);
    }
  });

  it('names where it is served, and refuses keys it does not know', () => {
    expect(schema['$id']).toBe(MANIFEST_SCHEMA_URL);
    expect(schema['additionalProperties']).toBe(false);
    expect((schema['required'] as string[]).sort()).toEqual(['app', 'oauth']);
  });

  it('is checked in as it is generated; run `pnpm schema:write` after changing the manifest', () => {
    // Compared as data, so the copy can be formatted like every other JSON file here.
    expect(JSON.parse(readFileSync(CHECKED_IN, 'utf8'))).toEqual(schema);
  });
});
