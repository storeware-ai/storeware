/**
 * The postMessage bridge between an admin extension and its host page.
 *
 * An extension runs in a cross-origin iframe, so it cannot touch the admin's
 * DOM, cookies or navigation directly. This is the whole of what it can ask
 * the host to do, and the host validates every request rather than trusting
 * the frame.
 *
 * Every action here is a capability handed to code we do not run and cannot
 * review, so the bar is that a merchant would be comfortable with a stranger's
 * app doing it unprompted. `createAppBridge` speaks version 2;
 * `connectToHost` speaks version 1 and is kept for pages written for it.
 */

import {
  PROTOCOL,
  VERSION,
  parseAppMessage,
  parseHostMessage,
  type AppMessage,
  type BridgeErrorCode,
  type PickerResource,
  type Picked,
  type Theme,
  type TitleBarAction,
  type Welcome,
} from './bridge/protocol';

/** Version 1's protocol name. Version 2's is `PROTOCOL` in `./bridge/protocol`. */
export const BRIDGE_PROTOCOL = 'storeware.bridge.v1';

/** Sent by the extension to the host. */
export type ExtensionMessage =
  | { protocol: typeof BRIDGE_PROTOCOL; type: 'ready' }
  /** Ask the host to resize the frame. Clamped by the host. */
  | { protocol: typeof BRIDGE_PROTOCOL; type: 'resize'; height: number }
  | { protocol: typeof BRIDGE_PROTOCOL; type: 'toast'; message: string; tone?: 'info' | 'error' }
  /**
   * Ask the host to navigate the admin.
   *
   * Relative paths only. An absolute URL would let an app redirect a
   * merchant's admin tab to a page of its choosing, which is a phishing
   * primitive rather than an integration.
   */
  | { protocol: typeof BRIDGE_PROTOCOL; type: 'navigate'; path: string };

/** Sent by the host to the extension. */
export type HostMessage =
  | {
      protocol: typeof BRIDGE_PROTOCOL;
      type: 'context';
      storeId: string;
      /** For example `{ productId }` on a product page. */
      context: Record<string, string | string[]>;
    }
  /** A freshly minted session token, before the current one expires. */
  | { protocol: typeof BRIDGE_PROTOCOL; type: 'session'; token: string }
  /**
   * The admin's current design tokens, sent on connect and again when the
   * merchant's colour scheme changes.
   *
   * Sent as values rather than a stylesheet URL because an extension renders on
   * its own origin and cannot inherit the admin's cascade. Without this an
   * author has three options, all bad: guess our colours, ship their own and
   * look bolted on, or scrape the parent, which the sandbox correctly forbids.
   */
  | {
      protocol: typeof BRIDGE_PROTOCOL;
      type: 'theme';
      scheme: 'light' | 'dark';
      /** CSS custom properties, already named. Apply them to your root element. */
      variables: Record<string, string>;
    };

export interface BridgeOptions {
  /**
   * The admin origin, for example https://app.storeware.ai.
   *
   * Passed explicitly and used as the postMessage target. Posting to "*" would
   * broadcast your messages to whatever page happens to frame you.
   */
  hostOrigin: string;
  onContext?: (storeId: string, context: Record<string, string | string[]>) => void;
  onSession?: (token: string) => void;
  /**
   * Called with the admin's tokens on connect and whenever they change.
   *
   * Ignore it and your panel still works; it will just look like somebody
   * else's product sitting inside ours.
   */
  onTheme?: (scheme: 'light' | 'dark', variables: Record<string, string>) => void;
}

export interface Bridge {
  ready(): void;
  resize(height: number): void;
  toast(message: string, tone?: 'info' | 'error'): void;
  navigate(path: string): void;
  /**
   * Writes the host's tokens onto an element, usually document.documentElement.
   *
   * A convenience over onTheme, so the common case is one line and an author
   * does not have to know which variable names we use.
   */
  applyTheme(element: HTMLElement): void;
  /** Stops listening. Call on unmount. */
  dispose(): void;
}

/**
 * Connects an extension to its host.
 *
 * Runs in the browser, inside your iframe. Everything arriving from the host
 * is checked against `hostOrigin` before it is believed, because any page can
 * postMessage into a frame it does not own.
 */
export function connectToHost(options: BridgeOptions): Bridge {
  const parent = window.parent;
  if (!parent || parent === window) {
    throw new Error('connectToHost must run inside the Storeware admin iframe');
  }

  const post = (message: ExtensionMessage) => parent.postMessage(message, options.hostOrigin);

  // Held so applyTheme works whenever it is called rather than only inside the
  // message handler, which is the shape a React effect actually wants.
  let variables: Record<string, string> = {};

  const listener = (event: MessageEvent) => {
    // Origin first, always. Skipping this means any page that can open your
    // frame can feed it a store id and a session token of its choosing.
    if (event.origin !== options.hostOrigin) return;

    const data = event.data as HostMessage | undefined;
    if (data?.protocol !== BRIDGE_PROTOCOL) return;

    if (data.type === 'context') options.onContext?.(data.storeId, data.context);
    if (data.type === 'session') options.onSession?.(data.token);
    if (data.type === 'theme') {
      variables = data.variables;
      options.onTheme?.(data.scheme, data.variables);
    }
  };

  window.addEventListener('message', listener);

  return {
    ready: () => post({ protocol: BRIDGE_PROTOCOL, type: 'ready' }),
    resize: (height) => post({ protocol: BRIDGE_PROTOCOL, type: 'resize', height }),
    toast: (message, tone) =>
      post({ protocol: BRIDGE_PROTOCOL, type: 'toast', message, ...(tone ? { tone } : {}) }),
    navigate: (path) => post({ protocol: BRIDGE_PROTOCOL, type: 'navigate', path }),
    applyTheme: (element) => {
      for (const [name, value] of Object.entries(variables)) {
        element.style.setProperty(name, value);
      }
    },
    dispose: () => window.removeEventListener('message', listener),
  };
}

/**
 * App Bridge version 2, for a page the admin frames.
 *
 * `connectToHost` above speaks version 1 and still works. This speaks version
 * 2: a handshake that hands the page its context, theme and session in one
 * message, requests that are answered, and the admin's title bar, save bar,
 * modals, confirm, resource picker and links off Storeware. The messages are
 * in `@storeware/plugin-sdk/bridge/protocol`; React apps can use
 * `@storeware/app-bridge-react`, which is built on this.
 */
export interface AppBridgeOptions {
  /**
   * The admin origin, for example https://app.storeware.ai.
   *
   * Every message is posted to it and nothing from anywhere else is believed.
   */
  hostOrigin: string;
  /** How long a request waits for the admin, in milliseconds. The merchant's answers never time out. */
  timeoutMs?: number;
  /** The window to listen on. Injectable for tests. */
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Where messages are posted: the admin's window. Injectable for tests. */
  parent?: { postMessage(message: unknown, targetOrigin: string): void };
}

/** A request the admin refused, with its reason. */
export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode | 'timeout' | 'disposed',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** What a page can put above its frame. Send it again to change it, or `{}` to clear it. */
export interface TitleBar {
  /** The heading. */
  title?: string;
  /** The one button the page is for. */
  primary?: TitleBarAction | null;
  /** Up to three more. */
  secondary?: TitleBarAction[];
}

/** Things the admin tells the page about after the handshake. */
export interface AppBridgeEvents {
  /** A title bar button, by its id. */
  'title_bar.action': string;
  /** The merchant pressed Save. Save, then call `saveBar.result`. */
  'save_bar.save': void;
  /** The merchant chose to discard. Put the page back as it was last saved. */
  'save_bar.discard': void;
  /** The admin's colours changed. `applyTheme` already has them. */
  theme: Theme;
  /** A fresh session token, sent every four minutes. */
  session: { token: string; expiresAt: string };
}

export interface SaveBarControls {
  /** Whether there are unsaved changes. While there are, leaving the page is questioned. */
  dirty(dirty: boolean): void;
  /** How the save the merchant asked for went. Unsaved changes stay unsaved on a failure. */
  result(ok: boolean, message?: string): void;
}

export interface ModalControls {
  /**
   * Opens a page of your app's home in a window over the admin. Resolves with
   * what that page passed to `close`, or undefined when the merchant closed it.
   */
  open(
    path: string,
    title: string,
    options?: { size?: 'small' | 'medium' | 'large' },
  ): Promise<unknown>;
  /** From inside a window: closes it, handing `data` to the page that opened it. */
  close(data?: unknown): void;
}

export interface AppBridge {
  /** Resolves once the admin has answered the handshake. */
  readonly ready: Promise<Welcome>;
  /** The handshake's answer, or null until it arrives. */
  readonly welcome: Welcome | null;
  /**
   * A session token for a call to your own server.
   *
   * The current one while it has more than a minute left, otherwise a fresh
   * one from the admin. Send it as a bearer token and verify it there.
   */
  sessionToken(): Promise<string>;
  /** A short message, shown with your app's name in front of it. Three per ten seconds. */
  toast(message: string, tone?: 'info' | 'error'): void;
  /** The loading bar across the top of the frame. */
  loading(on: boolean): void;
  /** A heading and buttons above the frame. Presses come back as `title_bar.action`. */
  titleBar(bar: TitleBar): void;
  /** The admin's save bar, on pages that have one. */
  saveBar: SaveBarControls;
  /** Pages of your app's home in a window over the admin. */
  modal: ModalControls;
  /** Asks the merchant. The window is titled with your app's name. */
  confirm(options: {
    title: string;
    message: string;
    confirmLabel?: string;
    destructive?: boolean;
  }): Promise<boolean>;
  /**
   * The merchant chooses records. Empty when they cancel. Refused with
   * `not_granted` when your grant cannot read them.
   */
  pick(resource: PickerResource, options?: { multiple?: boolean; max?: number }): Promise<Picked[]>;
  /** Another page of this shop's admin, relative to the shop: `/orders`. */
  navigate(path: string): void;
  /** A page of your app's home: `/settings`. */
  appNavigate(path: string): void;
  /** A page off Storeware. The merchant is shown where it goes first. */
  redirect(url: string): void;
  /** The frame's height in pixels, kept between 80 and 1200. */
  resize(height: number): void;
  /** Keeps the frame as tall as `element`. Returns a function that stops it. */
  autoResize(element: HTMLElement): () => void;
  /** Listens for something the admin tells the page. Returns a function that stops it. */
  on<E extends keyof AppBridgeEvents>(
    event: E,
    handler: (detail: AppBridgeEvents[E]) => void,
  ): () => void;
  /** Writes the admin's 13 `--sw-*` variables onto an element, usually the root. */
  applyTheme(element: HTMLElement): void;
  /** Stops listening and fails anything still waiting. Call on unmount. */
  dispose(): void;
}

// Requests answered by the merchant rather than by the admin's code. They wait
// as long as the merchant does.
const WAITS_FOR_MERCHANT = new Set(['modal.open', 'confirm', 'picker']);

/**
 * Connects a framed page to the admin, version 2.
 *
 * Sends `hello` at once. Messages sent before the admin answers are held and
 * sent after, so a page can call `toast` on its first line.
 */
export function createAppBridge(options: AppBridgeOptions): AppBridge {
  const listenOn = options.window ?? window;
  const parent: { postMessage(message: unknown, targetOrigin: string): void } =
    options.parent ?? window.parent;
  if (!options.parent && (!window.parent || window.parent === window)) {
    throw new Error('createAppBridge must run inside the Storeware admin iframe');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const prefix = Math.random().toString(36).slice(2, 8);
  let counter = 0;
  const nextId = () => `${prefix}-${(counter += 1)}`;

  let welcome: Welcome | null = null;
  let session: { token: string; expiresAt: string } | null = null;
  let variables: Record<string, string> = {};
  let disposed = false;
  const held: AppMessage[] = [];
  const waiting = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  const handlers = new Map<string, Set<(detail: unknown) => void>>();

  const emit = (event: string, detail: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(detail);
  };

  const post = (message: AppMessage) => parent.postMessage(message, options.hostOrigin);

  /** Checked here as the admin will check it, so a mistake throws in the app's own code. */
  const check = (message: Record<string, unknown>): AppMessage => {
    const parsed = parseAppMessage({ protocol: PROTOCOL, ...message });
    if (!parsed || !('message' in parsed) || parsed.version !== 2) {
      const reason = parsed && 'invalid' in parsed ? parsed.invalid : 'not a bridge message';
      throw new BridgeError('invalid', reason);
    }
    return parsed.message;
  };

  const send = (message: Record<string, unknown>) => {
    if (disposed) return;
    const checked = check(message);
    if (welcome) post(checked);
    else held.push(checked);
  };

  const request = <T>(message: Record<string, unknown>): Promise<T> => {
    if (disposed) return Promise.reject(new BridgeError('disposed', 'the bridge was disposed'));
    const id = nextId();
    let checked: AppMessage;
    try {
      checked = check({ ...message, id });
    } catch (error) {
      return Promise.reject(error as Error);
    }
    return new Promise<T>((resolve, reject) => {
      const entry: {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
      } = { resolve: resolve as (value: unknown) => void, reject };
      if (!WAITS_FOR_MERCHANT.has(checked.type)) {
        entry.timer = setTimeout(() => {
          waiting.delete(id);
          reject(new BridgeError('timeout', `the admin did not answer ${checked.type}`));
        }, timeoutMs);
      }
      waiting.set(id, entry);
      if (welcome || checked.type === 'hello') post(checked);
      else held.push(checked);
    });
  };

  let settle: (value: Welcome) => void = () => {};
  const ready = new Promise<Welcome>((resolve) => {
    settle = resolve;
  });

  const listener = (event: MessageEvent) => {
    // Origin first, always: any page can post into a frame it does not own.
    if (event.origin !== options.hostOrigin) return;
    const message = parseHostMessage(event.data);
    if (!message || message.protocol !== PROTOCOL) return;

    switch (message.type) {
      case 'welcome': {
        if (welcome) return;
        welcome = message;
        session = message.session;
        variables = message.theme.variables;
        waiting.get(message.id)?.resolve(message);
        waiting.delete(message.id);
        settle(message);
        for (const queued of held.splice(0)) post(queued);
        return;
      }
      case 'response': {
        const entry = waiting.get(message.id);
        if (!entry) return;
        waiting.delete(message.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else
          entry.reject(
            new BridgeError(
              message.error?.code ?? 'failed',
              message.error?.message ?? 'the admin refused',
            ),
          );
        return;
      }
      case 'session':
        session = { token: message.token, expiresAt: message.expiresAt };
        emit('session', session);
        return;
      case 'theme':
        variables = message.variables;
        emit('theme', { scheme: message.scheme, variables: message.variables });
        return;
      case 'title_bar.action':
        emit('title_bar.action', message.action);
        return;
      case 'save_bar.save':
      case 'save_bar.discard':
        emit(message.type, undefined);
        return;
    }
  };

  listenOn.addEventListener('message', listener as EventListener);
  void request({ type: 'hello', versions: [VERSION] }).catch(() => {});

  return {
    ready,
    get welcome() {
      return welcome;
    },
    async sessionToken() {
      await ready;
      if (session && Date.parse(session.expiresAt) - Date.now() > 60_000) return session.token;
      const fresh = await request<{ token: string; expiresAt: string }>({
        type: 'session.request',
      });
      session = fresh;
      return fresh.token;
    },
    toast: (message, tone) => send({ type: 'toast', message, ...(tone ? { tone } : {}) }),
    loading: (on) => send({ type: 'loading', on }),
    titleBar: (bar) => send({ type: 'title_bar', ...bar }),
    saveBar: {
      dirty: (dirty) => send({ type: 'save_bar', dirty }),
      result: (ok, message) =>
        send({ type: 'save_bar.result', ok, ...(message ? { message } : {}) }),
    },
    modal: {
      open: (path, title, extra) =>
        request<{ data?: unknown }>({
          type: 'modal.open',
          path,
          title,
          ...(extra?.size ? { size: extra.size } : {}),
        }).then((result) => result?.data),
      close: (data) => send({ type: 'modal.close', ...(data === undefined ? {} : { data }) }),
    },
    confirm: (ask) =>
      request<{ confirmed: boolean }>({ type: 'confirm', ...ask }).then(
        (result) => result?.confirmed === true,
      ),
    pick: (resource, extra) =>
      request<{ selection: Picked[] }>({ type: 'picker', resource, ...extra }).then(
        (result) => result?.selection ?? [],
      ),
    navigate: (path) => send({ type: 'navigate', path }),
    appNavigate: (path) => send({ type: 'app.navigate', path }),
    redirect: (url) => send({ type: 'redirect', url }),
    resize: (height) => send({ type: 'resize', height }),
    autoResize(element) {
      if (typeof ResizeObserver === 'undefined') {
        send({ type: 'resize', height: element.scrollHeight });
        return () => {};
      }
      let last = -1;
      const observer = new ResizeObserver(() => {
        const height = Math.ceil(element.scrollHeight);
        if (height === last) return;
        last = height;
        send({ type: 'resize', height });
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as (detail: unknown) => void);
      handlers.set(event, set);
      return () => set.delete(handler as (detail: unknown) => void);
    },
    applyTheme(element) {
      for (const [name, value] of Object.entries(variables)) {
        element.style.setProperty(name, value);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listenOn.removeEventListener('message', listener as EventListener);
      for (const entry of waiting.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new BridgeError('disposed', 'the bridge was disposed'));
      }
      waiting.clear();
      held.length = 0;
      handlers.clear();
    },
  };
}
