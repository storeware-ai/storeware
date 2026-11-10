import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The SDK's handlers, for `node:http` and Express.
 *
 * Everything else in the SDK speaks fetch `Request` and `Response`, which Node
 * servers do not. This turns one into a `(req, res)` listener. Mount it before
 * any body parser: a signature is over the raw bytes, and a parsed and
 * re-serialised body never verifies.
 */

type FetchHandler = (request: Request) => Promise<Response>;

export function toNodeListener(
  handler: FetchHandler,
  options: { origin?: string } = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  return (incoming, outgoing) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) {
        chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const origin = options.origin ?? `http://${incoming.headers.host ?? 'localhost'}`;
      const method = incoming.method ?? 'GET';
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const request = new Request(new URL(incoming.url ?? '/', origin), {
        method,
        headers,
        ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
      });

      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      if (!outgoing.headersSent) outgoing.statusCode = 500;
      outgoing.end();
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    });
  };
}
