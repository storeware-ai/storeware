import { describe, expect, it } from 'vitest';
import { localPortOf, originsIn, rewriteLocalOrigins } from './dev';

const manifest = `
manifest_version = 2

[app]
slug = "hello"
name = "Hello"
url = "http://localhost:4000/app"
homepage_url = "https://hello.example"

[oauth]
redirect_uris = ["http://localhost:4000/callback"]
scopes = ["products:read"]

[webhooks]
url = "http://localhost:4000/webhooks"
events = ["product.created.v1"]
`;

describe('pointing a manifest at a tunnel', () => {
  it('swaps every local origin and leaves every other URL alone', () => {
    const rewritten = rewriteLocalOrigins(manifest, 'https://calm-fox.trycloudflare.com/');
    expect(rewritten).toContain('url = "https://calm-fox.trycloudflare.com/app"');
    expect(rewritten).toContain('"https://calm-fox.trycloudflare.com/callback"');
    expect(rewritten).toContain('url = "https://calm-fox.trycloudflare.com/webhooks"');
    expect(rewritten).toContain('homepage_url = "https://hello.example"');
    expect(rewritten).not.toContain('localhost');
  });

  it('changes nothing else in the file, byte for byte', () => {
    const rewritten = rewriteLocalOrigins(manifest, 'https://t.trycloudflare.com');
    expect(rewritten.split('https://t.trycloudflare.com').join('http://localhost:4000')).toBe(
      manifest,
    );
  });

  it('never lets a short origin eat the front of a longer one', () => {
    const two = 'a = "http://localhost:4000/x"\nb = "http://localhost:40001/y"\n';
    expect(rewriteLocalOrigins(two, 'https://t.test')).toBe(
      'a = "https://t.test/x"\nb = "https://t.test/y"\n',
    );
  });

  it('finds the port the tunnel should forward to', () => {
    expect(localPortOf(manifest)).toBe(4000);
    expect(localPortOf('url = "https://only.example/x"')).toBeNull();
    expect(originsIn(manifest)).toEqual(['http://localhost:4000', 'https://hello.example']);
  });
});
