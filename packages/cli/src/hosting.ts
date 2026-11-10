import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { MAX_BUNDLE_BYTES, parseManifest } from '@storeware/plugin-sdk/manifest';

/**
 * What `storeware app deploy` does for an app Storeware hosts.
 *
 * The code becomes one ES module, uploaded under its own SHA-256, and the
 * manifest is sent with that hash in `runtime.bundle`. So the release is the
 * manifest exactly as it always was, and a change of code is a change of the
 * manifest: reviewed, and approved by each merchant, by the path every other
 * change already takes.
 *
 * Both halves are deterministic on purpose. The server keys a release by the
 * hash of the manifest it was sent, so the same code and the same file must
 * give the same text byte for byte, or every deploy of nothing would be a new
 * release that asks every merchant again.
 */

export class HostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostingError';
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** The table header `[runtime]`, however it is spaced or quoted, with an optional comment. */
const RUNTIME_HEADER = /^\s*\[\s*(?:runtime|"runtime"|'runtime')\s*\]\s*(?:#.*)?$/;
/** Any table or array-of-tables header, which ends the one before it. */
const ANY_HEADER = /^\s*\[/;
const BUNDLE_KEY = /^\s*(?:bundle|"bundle"|'bundle')\s*=/;

/**
 * The manifest's text with `runtime.bundle` set to this hash, or taken out
 * when it is null. Only the one line changes, so the developer's comments and
 * layout are what the server stores and a reviewer reads.
 *
 * An existing `bundle = ...` line is replaced where it stands; otherwise the
 * line goes straight under `[runtime]`. The file on disk is never written: the
 * hash is a fact about this deploy, not something to commit.
 */
export function withRuntimeBundle(source: string, sha256: string | null): string {
  const lines = source.split('\n');
  const header = lines.findIndex((line) => RUNTIME_HEADER.test(line.replace(/\r$/, '')));
  if (header === -1) {
    throw new HostingError(
      'Write `[runtime]` as a table of its own in storeware.app.toml, so deploy can fill in its bundle.',
    );
  }
  let end = lines.length;
  for (let at = header + 1; at < lines.length; at += 1) {
    if (ANY_HEADER.test(lines[at]!)) {
      end = at;
      break;
    }
  }
  const ending = lines[header]!.endsWith('\r') ? '\r' : '';
  const line = sha256 === null ? null : `bundle = "${sha256}"${ending}`;

  const existing = lines.slice(header + 1, end).findIndex((text) => BUNDLE_KEY.test(text));
  if (existing === -1) {
    if (line !== null) lines.splice(header + 1, 0, line);
  } else if (line === null) {
    lines.splice(header + 1 + existing, 1);
  } else {
    lines[header + 1 + existing] = line;
  }
  const text = lines.join('\n');

  // Read back, so a file laid out in a way the lines above misread (a
  // multi-line string holding a `[`) fails here rather than at the server.
  const parsed = parseManifest(text);
  if ((parsed.runtime?.bundle ?? null) !== sha256) {
    throw new HostingError(
      'Could not set runtime.bundle in storeware.app.toml. Keep `[runtime]` as a plain table with one key per line.',
    );
  }
  return text;
}

/**
 * Bundles a hosted app's entry into one ES module for the runtime.
 *
 * `workerd`, `worker` and `browser` conditions first, so a package that ships a
 * Workers build is given it. Not minified, so a line in `app logs --console`
 * can be found in the code. No source map, which would be a second file the
 * runtime has no way to load.
 *
 * Built from the manifest's folder, so the comments esbuild writes name paths
 * relative to it: the same code checked out somewhere else is the same bytes.
 */
export async function bundleHostedApp(
  folder: string,
  main: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const entry = resolve(folder, main);
  if (!entry.startsWith(resolve(folder) + sep)) {
    throw new HostingError(`runtime.main must be a file inside the app, and ${main} is not.`);
  }
  const found = await stat(entry).catch(() => null);
  if (!found?.isFile()) {
    throw new HostingError(`No file at ${main}, which runtime.main names.`);
  }

  // Loaded only here, so a deploy of an app on its own server never starts it.
  const { build } = await import('esbuild');
  let output: Uint8Array;
  try {
    const result = await build({
      absWorkingDir: resolve(folder),
      entryPoints: [main],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      target: 'es2022',
      minify: false,
      sourcemap: false,
      // The runtime's own modules are provided by it, never bundled.
      external: ['cloudflare:*'],
      logLevel: 'silent',
    });
    output = result.outputFiles[0]?.contents ?? new Uint8Array();
  } catch (error) {
    const failures = (
      error as { errors?: { text: string; location?: { file: string; line: number } | null }[] }
    ).errors;
    if (failures?.length) {
      throw new HostingError(
        `Could not bundle ${main}:\n${failures
          .map((f) => `  ${f.location ? `${f.location.file}:${f.location.line}: ` : ''}${f.text}`)
          .join('\n')}`,
      );
    }
    throw error;
  }

  if (output.byteLength === 0) {
    throw new HostingError(
      `The bundle of ${main} came out empty. Its default export should be an object with a fetch method.`,
    );
  }
  if (output.byteLength > MAX_BUNDLE_BYTES) {
    throw new HostingError(
      `The bundle is ${megabytes(output.byteLength)} MB, and a hosted app may be at most ${megabytes(MAX_BUNDLE_BYTES)} MB. Look for a large dependency to drop, or run the app on your own server.`,
    );
  }
  return { bytes: output, sha256: sha256Hex(output) };
}

/** One line of what a hosted app's code logged, as `app logs --console` prints it. */
export interface ConsoleEntry {
  at: string;
  level: string;
  message: string;
  installationId: string | null;
  storeId: string | null;
  outcome: string;
  status: number | null;
  release: string;
}

export function consoleLine(entry: ConsoleEntry): string {
  const time = entry.at.slice(11, 19);
  const marks = [
    entry.status !== null ? String(entry.status) : '',
    entry.outcome !== 'ok' ? entry.outcome : '',
    entry.storeId ? entry.storeId.slice(0, 8) : '',
  ].filter(Boolean);
  return `  ${time}  ${entry.level.padEnd(5)}  ${entry.message}${marks.length ? `  (${marks.join(', ')})` : ''}`;
}

/** Whether an entry went wrong: a failed run, a 4xx or 5xx, or an error logged. */
export function consoleFailed(entry: ConsoleEntry): boolean {
  return entry.outcome !== 'ok' || (entry.status ?? 0) >= 400 || entry.level === 'error';
}
