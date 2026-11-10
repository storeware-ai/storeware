import { z } from 'zod';

/**
 * App Bridge: every message between a page the admin frames and the admin.
 *
 * Both ends validate with these schemas, the admin when a frame asks for
 * something and an app when the admin answers, so the two can never disagree
 * about what a message may carry. Pure on purpose: no window, no DOM, nothing
 * that cannot run in a test.
 *
 * Version 2 opens with a handshake. The app says `hello` with the versions it
 * speaks, and the admin answers `welcome` with the one it chose and everything
 * the page needs to start: the record in context, the theme and a session
 * token. Every later message an app sends may carry an `id`, and the admin
 * answers each one that does with a `response` of the same id. Version 1
 * (`storeware.bridge.v1`, four messages and no handshake) is still accepted,
 * so a page written for it keeps working.
 *
 * Every capability here is handed to code Storeware does not run and cannot
 * review, so each is bounded where the admin acts on it: toasts are limited
 * and attributed, paths are relative, a confirm is titled with the app's name,
 * a picker opens only for what the merchant's grant lets the app read, and a
 * link off Storeware stops at a page that says where it goes.
 */

/** The protocol name on every version 2 message, in both directions. */
export const PROTOCOL = 'storeware.bridge';

/** The protocol name version 1 put on every message. */
export const PROTOCOL_V1 = 'storeware.bridge.v1';

/** The newest version this package speaks. */
export const VERSION = 2;

/** Every version an admin and an app may agree on, oldest first. */
export const VERSIONS = [1, 2] as const;

/** Bounds the admin holds every message to. */
export const LIMITS = {
  /** Characters of a toast the admin shows. Longer ones are cut. */
  toast: 200,
  /** Toasts one frame may show in any window of `toastWindowMs`. */
  toasts: 3,
  toastWindowMs: 10_000,
  /** Characters of a confirm's message. */
  message: 500,
  /** Characters of a title: the title bar's, a modal's, a confirm's. */
  title: 80,
  /** Characters of a button's label. */
  label: 40,
  /** Buttons beside the title bar's primary one. */
  secondaryActions: 3,
  /** Records one picker may return. */
  pick: 50,
  /** Bytes of JSON a modal may hand back to the page that opened it. */
  modalData: 16_384,
  /** A frame's height, in pixels, whatever it asks for. */
  minHeight: 80,
  maxHeight: 1200,
} as const;

/** The most rows one action on a list is handed, as `context.selection`. */
export const MAX_SELECTION = 100;

/** What the resource picker can choose. */
export const PICKER_RESOURCES = ['products', 'variants', 'collections', 'customers'] as const;

export type PickerResource = (typeof PICKER_RESOURCES)[number];

/**
 * The permission the merchant's grant must hold for each picker.
 *
 * A picker shows the merchant's records to the merchant, but what is chosen
 * goes to the app, so it opens only for what the app could read anyway.
 * Variants and collections are part of the catalogue, read with products.
 */
export const PICKER_SCOPES: Record<PickerResource, string> = {
  products: 'products:read',
  variants: 'products:read',
  collections: 'products:read',
  customers: 'customers:read',
};

/** The pickers a grant opens. Holding `x:write` counts as holding `x:read`. */
export function pickersFor(scopes: readonly string[]): PickerResource[] {
  const held = new Set(scopes);
  return PICKER_RESOURCES.filter((resource) => {
    const read = PICKER_SCOPES[resource];
    return held.has(read) || held.has(read.replace(/:read$/, ':write'));
  });
}

const SAFE_PATH = /^\/[A-Za-z0-9._~/-]*$/;
const SAFE_QUERY = /^[A-Za-z0-9._~%=&+-]*$/;

/**
 * A page of the app's own home, such as `/settings`.
 *
 * The same rule the manifest holds `[[app.navigation]]` paths to: one leading
 * slash, plain characters, never `..`. It is joined to `app.url` by the admin,
 * so it can only ever name a page on the app's own origin.
 */
export function isAppPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.startsWith('//') && !path.includes('..');
}

/**
 * A page of this shop's admin, relative to the shop, such as `/orders` or
 * `/products/<id>`, with an optional query.
 *
 * Relative to the shop rather than to the admin, so an app can send a
 * merchant to another page of the shop it is installed on and nowhere else.
 */
export function isAdminPath(path: string): boolean {
  const [pathname = '', query, ...rest] = path.split('?');
  if (rest.length > 0) return false;
  if (query !== undefined && !SAFE_QUERY.test(query)) return false;
  return isAppPath(pathname);
}

/**
 * Where an app may send a merchant off Storeware: https, or http on the
 * developer's own machine, and never with a user name or password in it.
 */
export function isRedirectUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || (local && url.protocol === 'http:');
}

/** Whether a value survives JSON and fits in `limit` bytes of it. */
function jsonWithin(value: unknown, limit: number): boolean {
  try {
    const text = JSON.stringify(value);
    return text === undefined || new TextEncoder().encode(text).length <= limit;
  } catch {
    return false;
  }
}

const id = z.string().min(1).max(64);
const title = z.string().trim().min(1).max(LIMITS.title);
const label = z.string().trim().min(1).max(LIMITS.label);
const appPath = z
  .string()
  .max(512)
  .refine(isAppPath, 'must be a path inside your app, such as /settings');
const adminPath = z
  .string()
  .max(512)
  .refine(isAdminPath, 'must be a path inside this shop, such as /orders');

/** A button in the title bar. Its `id` comes back in `title_bar.action`. */
export const titleBarAction = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'must be letters, digits, _ or -'),
    label,
    disabled: z.boolean().optional(),
    destructive: z.boolean().optional(),
  })
  .strict();

export type TitleBarAction = z.infer<typeof titleBarAction>;

// Spread into each version 2 message. `id` is optional on most of them: a
// message that has one is answered, one that has none is not.
const envelope = { protocol: z.literal(PROTOCOL), id: id.optional() };

/** A message from an app to the admin, version 2. */
export const appMessage = z.discriminatedUnion('type', [
  /** The handshake. Sent once, first. */
  z.object({
    ...envelope,
    type: z.literal('hello'),
    id,
    versions: z.array(z.number().int().positive()).min(1).max(8),
  }),
  /** A fresh session token, for a call to the app's own server. */
  z.object({ ...envelope, type: z.literal('session.request'), id }),
  /** The frame's height. Clamped by the admin. */
  z.object({ ...envelope, type: z.literal('resize'), height: z.number().finite() }),
  /** A short message, shown with the app's name in front of it. */
  z.object({
    ...envelope,
    type: z.literal('toast'),
    message: z.string().trim().min(1).max(LIMITS.message),
    tone: z.enum(['info', 'error']).optional(),
  }),
  /** The loading bar across the top of the frame. */
  z.object({ ...envelope, type: z.literal('loading'), on: z.boolean() }),
  /** A heading and buttons above the frame. Sent again to change them. */
  z.object({
    ...envelope,
    type: z.literal('title_bar'),
    title: title.optional(),
    primary: titleBarAction.nullable().optional(),
    secondary: z.array(titleBarAction).max(LIMITS.secondaryActions).optional(),
  }),
  /** Whether the app has unsaved changes. While it does, leaving the page is questioned. */
  z.object({ ...envelope, type: z.literal('save_bar'), dirty: z.boolean() }),
  /** How a save the merchant asked for went. */
  z.object({
    ...envelope,
    type: z.literal('save_bar.result'),
    ok: z.boolean(),
    message: z.string().trim().max(LIMITS.toast).optional(),
  }),
  /** A page of the app's home, in a window over the admin. Answered when it closes. */
  z.object({
    ...envelope,
    type: z.literal('modal.open'),
    id,
    path: appPath,
    title,
    size: z.enum(['small', 'medium', 'large']).optional(),
  }),
  /** From inside a modal: close it, handing `data` to the page that opened it. */
  z.object({
    ...envelope,
    type: z.literal('modal.close'),
    data: z
      .unknown()
      .refine((value) => jsonWithin(value, LIMITS.modalData), 'must be JSON of at most 16 KB')
      .optional(),
  }),
  /** A question with two answers, titled with the app's name. */
  z.object({
    ...envelope,
    type: z.literal('confirm'),
    id,
    title,
    message: z.string().trim().min(1).max(LIMITS.message),
    confirmLabel: label.optional(),
    destructive: z.boolean().optional(),
  }),
  /** The merchant chooses records; the app is handed their ids and names. */
  z.object({
    ...envelope,
    type: z.literal('picker'),
    id,
    resource: z.enum(PICKER_RESOURCES),
    multiple: z.boolean().optional(),
    max: z.number().int().min(1).max(LIMITS.pick).optional(),
  }),
  /** Another page of this shop's admin. */
  z.object({ ...envelope, type: z.literal('navigate'), path: adminPath }),
  /** A page of the app's own home. */
  z.object({ ...envelope, type: z.literal('app.navigate'), path: appPath }),
  /** A page off Storeware, after the merchant has been told where it goes. */
  z.object({
    ...envelope,
    type: z.literal('redirect'),
    url: z.string().max(2048).refine(isRedirectUrl, 'must be an https address'),
  }),
]);

export type AppMessage = z.infer<typeof appMessage>;
export type AppMessageType = AppMessage['type'];

/** A message from an app to the admin, version 1. Lenient, as the version 1 admin was. */
export const appMessageV1 = z.discriminatedUnion('type', [
  z.object({ protocol: z.literal(PROTOCOL_V1), type: z.literal('ready') }),
  z.object({ protocol: z.literal(PROTOCOL_V1), type: z.literal('resize'), height: z.number() }),
  z.object({
    protocol: z.literal(PROTOCOL_V1),
    type: z.literal('toast'),
    message: z.string(),
    tone: z.string().optional(),
  }),
  z.object({ protocol: z.literal(PROTOCOL_V1), type: z.literal('navigate'), path: z.string() }),
]);

export type AppMessageV1 = z.infer<typeof appMessageV1>;

/** The admin's colours and type, as the 13 `--sw-*` variables. */
export const theme = z.object({
  scheme: z.enum(['light', 'dark']),
  variables: z.record(z.string(), z.string()),
});

export type Theme = z.infer<typeof theme>;

/** What the page around a frame had in context. `selection` is an index action's ticked ids. */
export const sessionContext = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

/** A record the merchant chose in a picker. */
export const picked = z.object({
  id: z.string(),
  title: z.string(),
  /** A second line where a title is not enough: a variant's product, a customer's email. */
  subtitle: z.string().optional(),
});

export type Picked = z.infer<typeof picked>;

/** Why the admin refused a request. */
export const ERROR_CODES = [
  /** The message did not match its schema. */
  'invalid',
  /** Sent before the handshake finished. */
  'not_ready',
  /** Too many toasts too quickly. */
  'rate_limited',
  /** The merchant's grant does not cover it: a picker for records the app cannot read. */
  'not_granted',
  /** Not offered where the frame is: a save bar on a page without one, a modal inside a modal. */
  'unavailable',
  /** One of these is already open. */
  'busy',
  /** The admin tried and could not, for example a session it could not mint. */
  'failed',
] as const;

export type BridgeErrorCode = (typeof ERROR_CODES)[number];

const session = z.object({ token: z.string(), expiresAt: z.string() });

/** A message from the admin to an app, version 2. */
export const hostMessage = z.discriminatedUnion('type', [
  z.object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('welcome'),
    /** The `hello` this answers. */
    id,
    version: z.number().int(),
    app: z.object({ name: z.string(), slug: z.string().nullable() }),
    storeId: z.string(),
    /** Where the frame is, such as `admin.product.detail.sidebar` or `admin.app.home`. */
    point: z.string(),
    context: sessionContext,
    theme,
    session,
    /** The pickers this app may open, from the merchant's grant. */
    pickers: z.array(z.enum(PICKER_RESOURCES)),
    /** Whether the frame is inside a modal, where `modal.close` works. */
    modal: z.boolean(),
  }),
  z.object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('response'),
    id,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).optional(),
  }),
  /** A fresh session, sent before the current one expires. */
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('session'), ...session.shape }),
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('theme'), ...theme.shape }),
  /** A title bar button was pressed. */
  z.object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('title_bar.action'),
    action: z.string(),
  }),
  /** The merchant pressed Save on the save bar. Answer with `save_bar.result`. */
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('save_bar.save') }),
  /** The merchant chose to discard. Put the page back as it was last saved. */
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('save_bar.discard') }),
]);

export type HostMessage = z.infer<typeof hostMessage>;
export type Welcome = Extract<HostMessage, { type: 'welcome' }>;
export type BridgeResponse = Extract<HostMessage, { type: 'response' }>;

/** A message from the admin to an app, version 1. */
export const hostMessageV1 = z.discriminatedUnion('type', [
  z.object({
    protocol: z.literal(PROTOCOL_V1),
    type: z.literal('context'),
    storeId: z.string(),
    context: sessionContext,
  }),
  z.object({ protocol: z.literal(PROTOCOL_V1), type: z.literal('session'), token: z.string() }),
  z.object({ protocol: z.literal(PROTOCOL_V1), type: z.literal('theme'), ...theme.shape }),
]);

export type HostMessageV1 = z.infer<typeof hostMessageV1>;

/** What each request is answered with, by its type. */
export interface Results {
  'session.request': z.infer<typeof session>;
  'modal.open': { data?: unknown };
  confirm: { confirmed: boolean };
  picker: { selection: Picked[] };
}

/** What an app sent, sorted by version. `invalid` is a version 2 message that failed its schema. */
export type Received =
  | { version: 1; message: AppMessageV1 }
  | { version: 2; message: AppMessage }
  | { version: 2; invalid: string; id: string | null }
  | null;

/**
 * Sorts and checks one message from an app.
 *
 * Null for anything that is not the bridge at all: other scripts post into
 * frames too, and those are none of the admin's business. A version 2 message
 * that fails its schema is returned as invalid with its id, so it can be
 * answered rather than left waiting.
 */
export function parseAppMessage(data: unknown): Received {
  if (typeof data !== 'object' || data === null) return null;
  const protocol = (data as { protocol?: unknown }).protocol;

  if (protocol === PROTOCOL_V1) {
    const parsed = appMessageV1.safeParse(data);
    return parsed.success ? { version: 1, message: parsed.data } : null;
  }
  if (protocol !== PROTOCOL) return null;

  const parsed = appMessage.safeParse(data);
  if (parsed.success) return { version: 2, message: parsed.data };
  const raw = (data as { id?: unknown }).id;
  const first = parsed.error.issues[0];
  return {
    version: 2,
    invalid: first ? `${first.path.join('.') || 'message'} ${first.message}` : 'invalid message',
    id: typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null,
  };
}

/** Checks one message from the admin. Null for anything else. */
export function parseHostMessage(data: unknown): HostMessage | HostMessageV1 | null {
  if (typeof data !== 'object' || data === null) return null;
  const protocol = (data as { protocol?: unknown }).protocol;
  const schema =
    protocol === PROTOCOL ? hostMessage : protocol === PROTOCOL_V1 ? hostMessageV1 : null;
  if (!schema) return null;
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
