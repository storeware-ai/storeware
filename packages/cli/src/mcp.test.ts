import { describe, expect, it } from 'vitest';
import { answer, docsMarkdownUrl, findOperations, searchIndex, TOOLS } from './mcp';

const INDEX = `# Storeware Docs

- [Verifying requests](https://storeware.ai/docs/webhooks/verifying.md): How every call from Storeware to your app is signed, and how to check it.
- [App Bridge](https://storeware.ai/docs/extensions/app-bridge.md): Toasts, the title bar and the save bar.
- [Test payments](https://storeware.ai/docs/get-started/test-payments.md): No money moves.
`;

const context = {
  fetchImpl: (async (url: string) =>
    String(url).endsWith('/llms.txt')
      ? new Response(INDEX)
      : new Response(
          '# Verifying requests\n\nEvery request is signed.',
        )) as unknown as typeof fetch,
  cwd: '/nowhere',
  credentials: async () => {
    throw new Error('Not signed in.');
  },
};

describe('storeware mcp', () => {
  it('answers the handshake with its tools', async () => {
    const hello = await answer(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      context,
      '1.0.0-beta.0',
    );
    expect(hello).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-03-26', serverInfo: { name: 'storeware' } },
    });
    const listed = (await answer(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      context,
      'x',
    )) as {
      result: { tools: { name: string }[] };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'search_docs',
      'read_docs_page',
      'manifest_schema',
      'api_operation',
      'validate',
      'preflight',
      'webhook_trigger',
    ]);
  });

  it('sends nothing back for a notification', async () => {
    expect(
      await answer({ jsonrpc: '2.0', method: 'notifications/initialized' }, context, 'x'),
    ).toBeNull();
  });

  it('searches the docs index and reads a page as Markdown', async () => {
    expect(searchIndex(INDEX, 'verify signed')[0]).toContain('webhooks/verifying');
    const read = await answer(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_docs_page', arguments: { path: '/webhooks/verifying' } },
      },
      context,
      'x',
    );
    expect(JSON.stringify(read)).toContain('Every request is signed.');
  });

  it('reads only the docs', () => {
    expect(docsMarkdownUrl('/webhooks/verifying')).toBe(
      'https://storeware.ai/docs/webhooks/verifying.md',
    );
    expect(docsMarkdownUrl('https://storeware.ai/docs/webhooks/verifying.md')).toBe(
      'https://storeware.ai/docs/webhooks/verifying.md',
    );
    expect(docsMarkdownUrl('/')).toBe('https://storeware.ai/docs/index.md');
    expect(() => docsMarkdownUrl('https://evil.example/docs/x')).toThrow();
    expect(() => docsMarkdownUrl('/../../etc')).toThrow();
  });

  it('finds an operation by its id first, then by words', () => {
    const document = {
      paths: {
        '/api/v1/stores/{storeId}/products': {
          get: { operationId: 'listProducts', summary: 'List products' },
          post: { operationId: 'createProduct', summary: 'Create a product' },
        },
      },
    };
    expect(findOperations(document, 'listproducts')).toEqual([
      expect.objectContaining({ method: 'GET', operationId: 'listProducts' }),
    ]);
    expect(findOperations(document, 'create product')[0]).toMatchObject({
      operationId: 'createProduct',
    });
  });

  it('answers a failed tool with what went wrong, for the agent to read', async () => {
    const failed = (await answer(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'validate', arguments: {} } },
      context,
      'x',
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0]!.text).toContain('No manifest');
  });
});
