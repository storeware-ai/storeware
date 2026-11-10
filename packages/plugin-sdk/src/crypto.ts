/**
 * The few primitives the SDK signs and verifies with, on WebCrypto.
 *
 * `crypto.subtle` and `crypto.getRandomValues` exist on Workers, Node 20 and
 * later, Bun, Deno and every browser, where `node:crypto` exists on one of
 * them. An app built on this SDK runs wherever its author deploys it.
 */

const encoder = new TextEncoder();

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Decodes base64url to text. Throws on input that is not base64url. */
export function base64urlToText(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('not base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function textToBase64url(value: string): string {
  return bytesToBase64url(encoder.encode(value));
}

/** Cryptographically random bytes, as base64url. */
export function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
}

export async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64url(new Uint8Array(digest));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  return bytesToHex(await hmac(secret, value));
}

export async function hmacSha256Base64url(secret: string, value: string): Promise<string> {
  return bytesToBase64url(await hmac(secret, value));
}

/**
 * Compares two strings in time that depends only on their length.
 *
 * `===` returns at the first differing character, which tells an attacker how
 * much of a guessed signature was right. Lengths are public (a signature's
 * length is fixed), so a mismatch there returns at once.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
