'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BridgeError,
  createAppBridge,
  type AppBridge,
  type AppBridgeOptions,
} from '@storeware/plugin-sdk/bridge';
import type { Picked, PickerResource, Welcome } from '@storeware/plugin-sdk/bridge/protocol';

/**
 * App Bridge for React: the Storeware admin's toasts, title bar, save bar,
 * modals, confirm and resource picker, as a provider and hooks.
 *
 * Wrap the page the admin frames in `AppBridgeProvider`, then call the hooks
 * from anything inside it. Built on `createAppBridge` from
 * `@storeware/plugin-sdk/bridge`, which speaks the protocol; this package only
 * ties it to React's lifecycle, so a title bar goes when its component does.
 */

export { BridgeError };
export type { AppBridge, Picked, PickerResource, Welcome };

interface Connection {
  bridge: AppBridge | null;
  welcome: Welcome | null;
}

const Context = createContext<Connection | null>(null);

export interface AppBridgeProviderProps {
  /** The admin's origin, such as https://app.storeware.ai. Nothing from any other is believed. */
  hostOrigin: string;
  /** Write the admin's 13 `--sw-*` variables onto the page's root, and again when they change. On by default. */
  applyTheme?: boolean;
  /** Keep the frame as tall as the page. On by default; an app's home fills the page whatever it says. */
  autoResize?: boolean;
  /** Passed to `createAppBridge`, for tests: the window to listen on and where to post. */
  options?: Omit<AppBridgeOptions, 'hostOrigin'>;
  children: ReactNode;
}

/**
 * Connects the page to the admin while it is mounted.
 *
 * Says hello once mounted in the browser and renders its children at once:
 * hooks that need the admin's answer read null until it arrives.
 */
export function AppBridgeProvider({
  hostOrigin,
  applyTheme = true,
  autoResize = true,
  options,
  children,
}: AppBridgeProviderProps) {
  const [connection, setConnection] = useState<Connection>({ bridge: null, welcome: null });
  const extra = useRef(options);

  useEffect(() => {
    const bridge = createAppBridge({ hostOrigin, ...extra.current });
    setConnection({ bridge, welcome: null });
    let live = true;

    const paint = () => {
      if (applyTheme) bridge.applyTheme(document.documentElement);
    };
    void bridge.ready.then((welcome) => {
      if (!live) return;
      paint();
      setConnection({ bridge, welcome });
    });
    const stopTheme = bridge.on('theme', paint);
    const stopResize = autoResize ? bridge.autoResize(document.body) : () => {};

    return () => {
      live = false;
      stopTheme();
      stopResize();
      bridge.dispose();
    };
  }, [hostOrigin, applyTheme, autoResize]);

  return <Context value={connection}>{children}</Context>;
}

function useConnection(): Connection {
  const connection = useContext(Context);
  if (!connection) throw new Error('App Bridge hooks must be used inside AppBridgeProvider');
  return connection;
}

/** The bridge itself, or null until the provider has mounted. */
export function useAppBridge(): AppBridge | null {
  return useConnection().bridge;
}

/**
 * The admin's answer to the handshake, or null until it arrives: the store,
 * the point the page is framed at, the record in `context` (and, on a list's
 * action, `context.selection`), and which pickers the app may open.
 */
export function useWelcome(): Welcome | null {
  return useConnection().welcome;
}

/** Calls `use` with the bridge once there is one, or fails as the SDK does. */
function useCall() {
  const { bridge } = useConnection();
  const current = useRef(bridge);
  current.current = bridge;
  return useCallback(<T,>(use: (bridge: AppBridge) => T): T => {
    if (!current.current) throw new BridgeError('not_ready', 'App Bridge is not connected yet');
    return use(current.current);
  }, []);
}

/** A session token for your own server. Fresh whenever the current one is close to expiring. */
export function useSessionToken(): () => Promise<string> {
  const call = useCall();
  return useCallback(() => call((bridge) => bridge.sessionToken()), [call]);
}

/**
 * `fetch`, with the session token as a bearer token. For calls to your own
 * server, which verifies it with `verifySession` before answering.
 */
export function useAuthenticatedFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  const token = useSessionToken();
  return useCallback(
    async (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${await token()}`);
      return fetch(input, { ...init, headers });
    },
    [token],
  );
}

/** A toast, shown with your app's name in front of it. Three per ten seconds. */
export function useToast(): (message: string, tone?: 'info' | 'error') => void {
  const call = useCall();
  return useCallback((message, tone) => call((bridge) => bridge.toast(message, tone)), [call]);
}

/** The loading bar across the top of the frame, while `on` is true. */
export function useLoading(on: boolean): void {
  const { bridge } = useConnection();
  useEffect(() => {
    if (!bridge || !on) return;
    bridge.loading(true);
    return () => bridge.loading(false);
  }, [bridge, on]);
}

export interface TitleBarButton {
  label: string;
  onAction: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/**
 * A heading and buttons above the frame, drawn by the admin. Up to three
 * secondary buttons beside the primary one. Cleared when the component goes.
 */
export function useTitleBar(bar: {
  title?: string;
  primary?: TitleBarButton;
  secondary?: TitleBarButton[];
}): void {
  const { bridge } = useConnection();
  const handlers = useRef(new Map<string, () => void>());

  const wire = (button: TitleBarButton, id: string) => {
    handlers.current.set(id, button.onAction);
    return {
      id,
      label: button.label,
      ...(button.disabled ? { disabled: true } : {}),
      ...(button.destructive ? { destructive: true } : {}),
    };
  };
  handlers.current.clear();
  const sent = {
    ...(bar.title ? { title: bar.title } : {}),
    ...(bar.primary ? { primary: wire(bar.primary, 'primary') } : {}),
    ...(bar.secondary?.length
      ? { secondary: bar.secondary.map((button, index) => wire(button, `secondary-${index}`)) }
      : {}),
  };
  const key = JSON.stringify(sent);

  useEffect(() => {
    if (!bridge) return;
    bridge.titleBar(JSON.parse(key) as Parameters<AppBridge['titleBar']>[0]);
  }, [bridge, key]);

  useEffect(() => {
    if (!bridge) return;
    const stop = bridge.on('title_bar.action', (id) => handlers.current.get(id)?.());
    return () => {
      stop();
      bridge.titleBar({});
    };
  }, [bridge]);
}

/**
 * The admin's save bar, for a page with unsaved changes.
 *
 * While `dirty` is true the bar shows and leaving the page is questioned. When
 * the merchant presses Save, `onSave` runs: resolve when saved, throw to say it
 * was not (the error's message is shown). `onDiscard` puts the page back.
 */
export function useSaveBar({
  dirty,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  onSave: () => Promise<void> | void;
  onDiscard: () => void;
}): void {
  const { bridge } = useConnection();
  const latest = useRef({ onSave, onDiscard });
  latest.current = { onSave, onDiscard };

  useEffect(() => {
    bridge?.saveBar.dirty(dirty);
  }, [bridge, dirty]);

  useEffect(() => {
    if (!bridge) return;
    const stopSave = bridge.on('save_bar.save', () => {
      void Promise.resolve()
        .then(() => latest.current.onSave())
        .then(
          () => bridge.saveBar.result(true),
          (error: unknown) =>
            bridge.saveBar.result(
              false,
              error instanceof Error ? error.message.slice(0, 200) : undefined,
            ),
        );
    });
    const stopDiscard = bridge.on('save_bar.discard', () => latest.current.onDiscard());
    return () => {
      stopSave();
      stopDiscard();
      bridge.saveBar.dirty(false);
    };
  }, [bridge]);
}

/**
 * Pages of your app's home in a window over the admin. `open` resolves with
 * what the page passed to `close`, or undefined when the merchant closed it.
 */
export function useModal(): {
  open: (
    path: string,
    title: string,
    options?: { size?: 'small' | 'medium' | 'large' },
  ) => Promise<unknown>;
  close: (data?: unknown) => void;
} {
  const call = useCall();
  return useMemo(
    () => ({
      open: (path, title, options) => call((bridge) => bridge.modal.open(path, title, options)),
      close: (data) => call((bridge) => bridge.modal.close(data)),
    }),
    [call],
  );
}

/** Asks the merchant, in a window titled with your app's name. */
export function useConfirm(): (options: {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
}) => Promise<boolean> {
  const call = useCall();
  return useCallback((options) => call((bridge) => bridge.confirm(options)), [call]);
}

/**
 * The resource picker. Resolves with what the merchant chose, empty when they
 * cancelled; rejects with `not_granted` for records your grant cannot read.
 * `useWelcome()?.pickers` says which you may open.
 */
export function useResourcePicker(): (
  resource: PickerResource,
  options?: { multiple?: boolean; max?: number },
) => Promise<Picked[]> {
  const call = useCall();
  return useCallback(
    (resource, options) => call((bridge) => bridge.pick(resource, options)),
    [call],
  );
}

/**
 * Moving the merchant: `navigate` to a page of this shop's admin (`/orders`),
 * `appNavigate` to a page of your home (`/settings`), and `redirect` off
 * Storeware, which the merchant is shown first.
 */
export function useNavigate(): {
  navigate: (path: string) => void;
  appNavigate: (path: string) => void;
  redirect: (url: string) => void;
} {
  const call = useCall();
  return useMemo(
    () => ({
      navigate: (path) => call((bridge) => bridge.navigate(path)),
      appNavigate: (path) => call((bridge) => bridge.appNavigate(path)),
      redirect: (url) => call((bridge) => bridge.redirect(url)),
    }),
    [call],
  );
}
