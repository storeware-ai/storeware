import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateClient,
  generateFormatted,
  OUTPUT_DIR,
  readDocument,
  REGENERATE,
  type OpenApiDocument,
} from './generate-client';

/**
 * The typed client in this folder is generated from `apps/api/openapi/v1.json`,
 * and the API's own snapshot test keeps that document true to the routes. This
 * closes the other half: a route that changed in the document but not here
 * would hand plugin authors a client that sends the old shape, and nothing
 * else would notice until a merchant's shop refused it.
 */
describe('the generated API client', () => {
  it(`matches what the generator writes from v1.json; run \`${REGENERATE}\``, async () => {
    const expected = await generateFormatted(readDocument());
    const committed = readdirSync(OUTPUT_DIR).filter((name) => !name.endsWith('.test.ts'));

    expect(committed.sort(), `files in src/generated differ; run \`${REGENERATE}\``).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [name, contents] of Object.entries(expected)) {
      const onDisk = readFileSync(join(OUTPUT_DIR, name), 'utf8');
      expect(onDisk === contents, `src/generated/${name} is stale; run \`${REGENERATE}\``).toBe(
        true,
      );
    }
  }, 30_000);

  it('has a method for every operation in the document', () => {
    const document = readDocument();
    const ids = Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );
    const api = generateClient(document)['api.ts'] ?? '';
    for (const id of ids) expect(api).toContain(`${id}: call('${id}'),`);
  });

  it('stops on a schema keyword it cannot type, rather than guessing', () => {
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {},
      components: { schemas: { Odd: { type: 'string', contentEncoding: 'base64' } } },
    };
    expect(() => generateClient(document)).toThrow(/contentEncoding/);
  });

  it('stops on an operation the client could not send', () => {
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/api/v1/things': {
          get: {
            operationId: 'listThings',
            parameters: [{ name: 'x-trace', in: 'header', schema: { type: 'string' } }],
            responses: { '200': {} },
          },
        },
      },
    };
    expect(() => generateClient(document)).toThrow(/header parameter/);
  });
});
