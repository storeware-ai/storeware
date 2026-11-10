import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI keeps its credentials.
 *
 * A file in the home directory, written 0600, rather than anything clever. The
 * one decision worth stating: environment variables win over the file, so CI
 * never needs a login step and a developer can override a stale token without
 * hunting for where it was cached.
 */

export interface CliConfig {
  apiUrl: string;
  adminUrl: string;
  token?: string;
  /**
   * Beside a token from `storeware login`: it rotates, so the CLI keeps the
   * newest one here and refreshes a minute before the hour runs out.
   */
  refreshToken?: string;
  /** When `token` stops working, in milliseconds since the epoch. */
  expiresAt?: number;
  organizationId?: string;
  /**
   * Which shop the theme commands act on.
   *
   * Stored rather than passed every time, because every theme endpoint is
   * `/stores/{storeId}/...` and a merchant with one shop should never have to
   * name it. It is not part of `Credentials`: a token and an organisation are
   * who you are, and a store is what you are pointing at. Commands that need
   * one resolve it against the live list, so a stale id here fails with a
   * sentence rather than a 403 three requests later.
   */
  storeId?: string;
}

export const DEFAULTS = {
  apiUrl: 'https://api.storeware.ai',
  adminUrl: 'https://app.storeware.ai',
};

function configPath(): string {
  return join(process.env.STOREWARE_CONFIG_HOME ?? homedir(), '.storeware', 'config.json');
}

export async function loadConfig(): Promise<CliConfig> {
  let stored: Partial<CliConfig> = {};

  try {
    stored = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<CliConfig>;
  } catch {
    // No config yet is the normal first run, not an error.
  }

  // A token from the environment is used as given and never refreshed or
  // saved: CI has no file to write the next one to.
  const fromEnv = process.env.STOREWARE_CLI_TOKEN ?? process.env.STOREWARE_TOKEN;
  return {
    apiUrl: process.env.STOREWARE_API_URL ?? stored.apiUrl ?? DEFAULTS.apiUrl,
    adminUrl: process.env.STOREWARE_ADMIN_URL ?? stored.adminUrl ?? DEFAULTS.adminUrl,
    ...((fromEnv ?? stored.token) ? { token: fromEnv ?? stored.token } : {}),
    ...(!fromEnv && stored.refreshToken ? { refreshToken: stored.refreshToken } : {}),
    ...(!fromEnv && stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
    ...((process.env.STOREWARE_ORG ?? stored.organizationId)
      ? { organizationId: process.env.STOREWARE_ORG ?? stored.organizationId }
      : {}),
    ...((process.env.STOREWARE_STORE ?? stored.storeId)
      ? { storeId: process.env.STOREWARE_STORE ?? stored.storeId }
      : {}),
  };
}

export async function saveConfig(config: Partial<CliConfig>): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });

  let existing: Partial<CliConfig> = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Partial<CliConfig>;
  } catch {
    // First write.
  }

  await writeFile(path, `${JSON.stringify({ ...existing, ...config }, null, 2)}\n`, 'utf8');
  // Written after the file exists, and separately, because the mode on an
  // existing file is not changed by writeFile.
  await chmod(path, 0o600);

  return path;
}

/** Forgets the sign-in, keeping where the CLI points and which shop. */
export async function clearCredentials(): Promise<void> {
  const path = configPath();
  let existing: Partial<CliConfig> = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Partial<CliConfig>;
  } catch {
    return;
  }
  const { token: _token, refreshToken: _refresh, expiresAt: _expires, ...kept } = existing;
  await writeFile(path, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
  await chmod(path, 0o600);
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in. Run `storeware login`,\n' +
        'or set STOREWARE_CLI_TOKEN to a CI token from the Developer page.',
    );
    this.name = 'NotAuthenticatedError';
  }
}

export interface Credentials {
  apiUrl: string;
  adminUrl: string;
  token: string;
  /**
   * Sent as a header when known. A token from `storeware login` or a CI token
   * names its own organisation, so the API needs none for those.
   */
  organizationId: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** A token that says which organisation it is for, so none need be stored. */
export function namesItsOrganisation(token: string): boolean {
  return token.startsWith('swd_') || token.startsWith('swdk_');
}

export function requireCredentials(config: CliConfig): Credentials {
  if (!config.token) throw new NotAuthenticatedError();
  if (!config.organizationId && !namesItsOrganisation(config.token)) {
    throw new NotAuthenticatedError();
  }
  return {
    apiUrl: config.apiUrl,
    adminUrl: config.adminUrl,
    token: config.token,
    organizationId: config.organizationId ?? '',
    ...(config.refreshToken ? { refreshToken: config.refreshToken } : {}),
    ...(config.expiresAt ? { expiresAt: config.expiresAt } : {}),
  };
}
