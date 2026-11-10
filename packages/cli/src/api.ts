import { saveConfig, type Credentials } from './config';
import type { ConsoleEntry } from './hosting';
import { refreshTokens } from './oauth';

/**
 * The CLI's view of the public API.
 *
 * The same `/api/v1` a merchant's dashboard and every plugin uses. There is no
 * developer-only API, which is the point: if registering an app needed a
 * private endpoint, third parties could not build the tooling we build.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly requiredScopes?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { type?: string; message?: string; requiredScopes?: string[] };
}

/** Refresh this long before the hour is up, so a slow command does not straddle it. */
const REFRESH_AHEAD_MS = 60_000;
let refreshing: Promise<void> | null = null;

/**
 * Swaps a token from `storeware login` for a fresh pair when it is about to
 * end, or has. One refresh at a time: a refresh token is spent by use, so two
 * at once would sign the CLI out.
 */
async function freshen(credentials: Credentials, force = false): Promise<void> {
  if (!credentials.refreshToken) return;
  if (!force && (credentials.expiresAt ?? 0) - Date.now() > REFRESH_AHEAD_MS) return;
  refreshing ??= (async () => {
    const pair = await refreshTokens(credentials.apiUrl, credentials.refreshToken!);
    credentials.token = pair.accessToken;
    credentials.refreshToken = pair.refreshToken;
    credentials.expiresAt = pair.expiresAt;
    await saveConfig({
      token: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresAt: pair.expiresAt,
    });
  })().finally(() => {
    refreshing = null;
  });
  await refreshing;
}

function send(credentials: Credentials, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${credentials.token}`);
  if (credentials.organizationId) {
    headers.set('x-storeware-organization', credentials.organizationId);
  }
  return fetch(`${credentials.apiUrl.replace(/\/$/, '')}${path}`, { ...init, headers });
}

export async function request<T>(
  credentials: Credentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return ((await requestBody(credentials, path, init)) as { data: T }).data;
}

/** The whole JSON body of a successful response, for the routes that do not wrap it in `data`. */
async function requestBody(
  credentials: Credentials,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  await freshen(credentials);
  let response = await send(credentials, path, init);
  // An hour is an estimate made on this machine's clock. A 401 with a refresh
  // token in hand gets one more try with a new pair.
  if (response.status === 401 && credentials.refreshToken) {
    await freshen(credentials, true);
    response = await send(credentials, path, init);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const problem = body as ErrorBody | null;
    throw new ApiError(
      response.status,
      problem?.error?.type ?? 'unknown',
      problem?.error?.message ?? `Request failed with ${response.status}`,
      problem?.error?.requiredScopes,
    );
  }

  return body;
}

export interface ScopeDefinition {
  name: string;
  description: string;
}

/** The live permission vocabulary, so validation is never against a stale copy. */
export function fetchScopes(credentials: Credentials): Promise<ScopeDefinition[]> {
  return request<ScopeDefinition[]>(credentials, '/api/v1/scopes');
}

export interface EventDefinition {
  topic: string;
  /** Any one of these scopes lets an app receive the topic. */
  anyOf: string[];
  label: string;
}

/** The live event catalogue, so a manifest's events are checked against what is sent. */
export function fetchEvents(credentials: Credentials): Promise<EventDefinition[]> {
  return request<EventDefinition[]>(credentials, '/api/v1/events');
}

export interface ApplyResult {
  pluginId: string;
  clientId: string;
  created: boolean;
  clientSecret?: string;
  scopes: string[];
  extensions: number;
  mcpTools: number;
  removedScopes: string[];
  /** Absent from servers older than releases. */
  release?: { id: string; version: number; created: boolean; channel?: string };
  installations?: { advanced: number; pending: number };
}

/**
 * Submits a manifest.
 *
 * Sent as TOML, byte for byte as written. Re-encoding it as JSON here would
 * mean the server validates something the developer never wrote, and the
 * stored copy would no longer match the file in their repository.
 */
export function applyManifest(
  credentials: Credentials,
  source: string,
  publish: boolean,
  channel: 'production' | 'development' = 'production',
): Promise<ApplyResult> {
  const query = new URLSearchParams({ via: 'cli' });
  if (publish) query.set('publish', 'true');
  if (channel === 'development') query.set('channel', 'development');
  return request<ApplyResult>(credentials, `/api/v1/plugins?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/toml' },
    body: source,
  });
}

/** `storeware logout`: ends the sign-in this CLI holds, on the server too. */
export function signOut(credentials: Credentials): Promise<{ revoked: boolean }> {
  return request(credentials, '/api/v1/developer/session', { method: 'DELETE' });
}

export interface DevelopmentStore {
  id: string;
  name: string;
  handle: string;
}

export function listDevelopmentStores(credentials: Credentials): Promise<DevelopmentStore[]> {
  return request(credentials, '/api/v1/developer/dev-stores');
}

export function createDevelopmentStore(
  credentials: Credentials,
  name: string,
): Promise<DevelopmentStore> {
  return request(credentials, '/api/v1/developer/dev-stores', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function seedDevelopmentStore(
  credentials: Credentials,
  storeId: string,
): Promise<{ products: number; customers: number; alreadySeeded: boolean }> {
  return request(credentials, `/api/v1/developer/dev-stores/${encodeURIComponent(storeId)}/seed`, {
    method: 'POST',
  });
}

/** How a test payment ends, as the API takes it. */
export const TEST_PAYMENT_OUTCOMES = ['approve', 'decline', 'needs_action', 'error'] as const;
export type TestPaymentOutcome = (typeof TEST_PAYMENT_OUTCOMES)[number];

export interface TestOrder {
  orderId: string;
  orderNumber: string | number;
  paid: boolean;
  /** How a test payment ended. Absent for an order placed on account. */
  payment?: 'succeeded' | 'declined' | 'failed' | 'waiting_for_bank';
  /** The pretend bank page, for a payment waiting for it. */
  authenticationUrl?: string;
}

export function createTestOrder(
  credentials: Credentials,
  storeId: string,
  paid: boolean,
  pay?: TestPaymentOutcome,
): Promise<TestOrder> {
  return request(
    credentials,
    `/api/v1/developer/dev-stores/${encodeURIComponent(storeId)}/test-orders`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pay ? { pay } : { paid }),
    },
  );
}

/** A development secret: it works only on development stores, so the CLI may make one. */
export function createDevelopmentSecret(
  credentials: Credentials,
  slug: string,
): Promise<{ secret: string }> {
  return request(credentials, `/api/v1/developer/apps/${encodeURIComponent(slug)}/secrets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'development' }),
  });
}

/** Pins a development release on one of the developer's own development stores. */
export function installDevelopmentRelease(
  credentials: Credentials,
  storeId: string,
  slug: string,
  developmentReleaseId: string,
): Promise<{ installationId: string; embedded: boolean }> {
  return request(
    credentials,
    `/api/v1/stores/${encodeURIComponent(storeId)}/apps/${encodeURIComponent(slug)}/install`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-storeware-store': storeId },
      body: JSON.stringify({ developmentReleaseId, source: 'cli' }),
    },
  );
}

export interface ReleaseSummary {
  id: string;
  version: number;
  channel: 'production' | 'development';
  createdAt: string;
  createdVia: string | null;
  current: boolean;
  installs: number;
  pendingApproval: number;
}

export function listReleases(credentials: Credentials, slug: string): Promise<ReleaseSummary[]> {
  return request(credentials, `/api/v1/developer/apps/${encodeURIComponent(slug)}/releases`);
}

export function promoteRelease(
  credentials: Credentials,
  slug: string,
  releaseId: string,
): Promise<unknown> {
  return request(
    credentials,
    `/api/v1/developer/apps/${encodeURIComponent(slug)}/releases/${encodeURIComponent(releaseId)}/promote`,
    { method: 'POST' },
  );
}

export interface DeveloperPlugin {
  slug: string;
  name: string;
  status: string;
  scopes: string[];
  manifestUpdatedAt: string | null;
}

export function listMyPlugins(credentials: Credentials): Promise<DeveloperPlugin[]> {
  return request<DeveloperPlugin[]>(credentials, '/api/v1/plugins?mine=true');
}

export interface Me {
  email: string;
  organizations: { organizationId: string; organizationName: string; roleName: string }[];
}

export function fetchMe(credentials: Credentials): Promise<Me> {
  return request<Me>(credentials, '/api/v1/me');
}

/**
 * A shop, narrowed to the three fields a command line needs.
 *
 * `/api/v1/stores` returns the whole row. Restating it here would be a copy of
 * a database type in a package that must not depend on one, and it would go
 * stale in the direction that hurts: a field this CLI never reads becoming
 * required. Three fields is what naming a shop takes.
 */
export interface StoreSummary {
  id: string;
  handle: string;
  name: string;
}

export function listStores(credentials: Credentials): Promise<StoreSummary[]> {
  return request<StoreSummary[]>(credentials, '/api/v1/stores');
}

/**
 * The published look, as a file.
 *
 * The published one rather than the draft, which is the export route's own
 * decision: a merchant exporting means "the shop as it is", and a file of an
 * unpublished draft would be a file of a shop that has never existed.
 *
 * Typed `unknown` on purpose. The CLI parses what comes back with the same
 * parsers it parses a file from disk with, so a shape declared here would be a
 * second, weaker description of the format sitting in front of the real one.
 */
export function exportTheme(
  credentials: Credentials,
  storeId: string,
  name?: string,
): Promise<unknown> {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  return request<unknown>(credentials, `/api/v1/stores/${storeId}/theme/export${query}`);
}

/**
 * What an import kept and what it could not.
 *
 * All four numbers are printed. An import that quietly dropped a third of a
 * theme would look like a theme that was always like that, which is the whole
 * reason the endpoint answers with a report rather than an acknowledgement.
 */
export interface ImportReport {
  /** Bands accepted, per page. */
  placed: Record<string, number>;
  /** Bands the platform did not recognise, so it could not draw them. */
  skipped: number;
  /** Bands that arrived pointing at a picture belonging to another shop. */
  picturesDropped: number;
  /** Tokens the file carried that a shop is not allowed to set. */
  tokensDropped: number;
}

/** Reads a theme file into the DRAFT. Never into the shop. */
export function importTheme(
  credentials: Credentials,
  storeId: string,
  file: unknown,
): Promise<ImportReport> {
  return request<ImportReport>(credentials, `/api/v1/stores/${storeId}/theme/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(file),
  });
}

export interface PreviewMint {
  expiresAt: string;
  previewUrl: string;
}

/**
 * A link that makes the shop serve its draft.
 *
 * Every draft mint retires the draft links before it, so the URL printed by the
 * last run stops working. That is the platform being careful rather than an
 * inconvenience: a merchant opening the editor on a second machine should not
 * leave a working preview of their unpublished shop behind on the first.
 */
export function mintPreview(credentials: Credentials, storeId: string): Promise<PreviewMint> {
  return request<PreviewMint>(credentials, `/api/v1/stores/${storeId}/theme/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export interface ThemeDraft {
  /** False when the shop has no draft and is showing its published look. */
  editing: boolean;
  tokens: Record<string, string>;
  layout: Record<string, unknown>;
  updatedAt: string | null;
}

export function fetchThemeDraft(credentials: Credentials, storeId: string): Promise<ThemeDraft> {
  return request<ThemeDraft>(credentials, `/api/v1/stores/${storeId}/theme/draft`);
}

export interface PublishedTheme {
  tokens: Record<string, string>;
  layout: Record<string, unknown>;
}

/**
 * Makes the draft the shop.
 *
 * A POST to the draft rather than to the theme, because the thing being acted
 * on is the draft: publishing consumes it. Pressing it twice is not an error,
 * it is somebody making sure, and the second one answers with the same look.
 */
export function publishTheme(credentials: Credentials, storeId: string): Promise<PublishedTheme> {
  return request<PublishedTheme>(credentials, `/api/v1/stores/${storeId}/theme/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export interface AppRequest {
  id: number;
  storeId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number | null;
  createdAt: string;
}

export function listAppRequests(
  credentials: Credentials,
  slug: string,
  query: { storeId?: string; failed?: boolean; after?: number; limit?: number } = {},
): Promise<AppRequest[]> {
  const params = new URLSearchParams();
  if (query.storeId) params.set('store', query.storeId);
  if (query.failed) params.set('failed', '1');
  if (query.after) params.set('after', String(query.after));
  if (query.limit) params.set('limit', String(query.limit));
  const search = params.toString();
  return request(
    credentials,
    `/api/v1/developer/apps/${encodeURIComponent(slug)}/requests${search ? `?${search}` : ''}`,
  );
}

export interface TriggeredDelivery {
  topic: string;
  url: string;
  sample: boolean;
  ok: boolean;
  status?: number;
  error?: string;
  durationMs?: number;
}

export function triggerWebhook(
  credentials: Credentials,
  slug: string,
  input: { topic: string; storeId: string },
): Promise<TriggeredDelivery> {
  return request(
    credentials,
    `/api/v1/developer/apps/${encodeURIComponent(slug)}/webhooks/trigger`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export interface PreflightCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  detail: string | null;
}

export interface PreflightReport {
  /** The development store the checks ran against, or null when the app is on none. */
  storeId: string | null;
  checks: PreflightCheck[];
  passed: boolean;
}

/** The checks a review runs, against the app on one of the developer's development stores. */
export function runPreflight(
  credentials: Credentials,
  slug: string,
  input: { storeId?: string } = {},
): Promise<PreflightReport> {
  return request(credentials, `/api/v1/developer/apps/${encodeURIComponent(slug)}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface SubmittedListing {
  version: number;
  /** `submitted` while it waits for a reviewer; `published` when nobody needs to look. */
  state: string;
  name: string;
  submittedAt: string | null;
  /** Where it stands in the queue, when the API says. */
  queuePosition?: number | null;
}

/** Freezes the listing draft and sends it for review. */
export function submitListing(credentials: Credentials, slug: string): Promise<SubmittedListing> {
  return request(credentials, `/api/v1/developer/apps/${encodeURIComponent(slug)}/listing/submit`, {
    method: 'POST',
  });
}

export interface UploadedBundle {
  sha256: string;
  bytes: number;
  /** False when the same bytes were already there. */
  stored: boolean;
}

/** Uploads a hosted app's code under its hash. Releases nothing by itself. */
export function uploadBundle(
  credentials: Credentials,
  slug: string,
  sha256: string,
  bytes: Uint8Array,
): Promise<UploadedBundle> {
  return request(
    credentials,
    `/api/v1/developer/apps/${encodeURIComponent(slug)}/bundles/${sha256}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/javascript' },
      // A copy on an ordinary ArrayBuffer, which is what a request body may be.
      body: new Uint8Array(bytes),
    },
  );
}

export interface RuntimeLogPage {
  logs: ConsoleEntry[];
  /** Where the next page starts, passed back as `after`. Opaque. */
  next: string | null;
}

/**
 * What a hosted app's code logged, in the order it was kept: the latest lines,
 * or with `after` (an earlier page's `next`) the lines since, or with `since`
 * the lines after a time.
 */
export async function fetchRuntimeLogs(
  credentials: Credentials,
  slug: string,
  query: { after?: string; since?: string; limit?: number } = {},
): Promise<RuntimeLogPage> {
  const params = new URLSearchParams();
  if (query.after) params.set('after', query.after);
  if (query.since) params.set('since', query.since);
  if (query.limit) params.set('limit', String(query.limit));
  const search = params.toString();
  const body = (await requestBody(
    credentials,
    `/api/v1/developer/apps/${encodeURIComponent(slug)}/runtime/logs${search ? `?${search}` : ''}`,
  )) as (RuntimeLogPage & { data?: undefined }) | { data: RuntimeLogPage };
  // Read wrapped in `data` like every other route, or bare.
  const page = body.data ?? (body as RuntimeLogPage);
  return { logs: page.logs ?? [], next: page.next ?? null };
}
