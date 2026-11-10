import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, createAppBridge } from './bridge';
import { PROTOCOL, type AppMessage } from './bridge/protocol';

const HOST = 'https://app.storeware.test';

/** A frame's window and its parent, without a browser. */
function frame() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: { message: AppMessage; origin: string }[] = [];
  const window = {
    addEventListener: (_: string, listener: EventListener) =>
      listeners.add(listener as (event: MessageEvent) => void),
    removeEventListener: (_: string, listener: EventListener) =>
      listeners.delete(listener as (event: MessageEvent) => void),
  };
  const parent = {
    postMessage: (message: unknown, origin: string) => {
      posted.push({ message: message as AppMessage, origin });
    },
  };
  const deliver = (data: unknown, origin = HOST) => {
    for (const listener of listeners) listener({ data, origin } as MessageEvent);
  };
  return { window, parent, posted, deliver, listeners };
}

function welcome(id: string, extra: Record<string, unknown> = {}) {
  return {
    protocol: PROTOCOL,
    type: 'welcome',
    id,
    version: 2,
    app: { name: 'Reviews', slug: 'reviews' },
    storeId: 'store-1',
    point: 'admin.app.home',
    context: {},
    theme: { scheme: 'dark', variables: { '--sw-bg': '#101010' } },
    session: { token: 'first', expiresAt: new Date(Date.now() + 300_000).toISOString() },
    pickers: ['products'],
    modal: false,
    ...extra,
  };
}

function connected() {
  const f = frame();
  const bridge = createAppBridge({ hostOrigin: HOST, window: f.window, parent: f.parent });
  const hello = f.posted[0]!.message as Extract<AppMessage, { type: 'hello' }>;
  return { ...f, bridge, hello };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAppBridge', () => {
  it('says hello to the admin’s exact origin, with the versions it speaks', () => {
    const { posted, hello } = connected();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.origin).toBe(HOST);
    expect(hello).toMatchObject({ protocol: PROTOCOL, type: 'hello', versions: [2] });
  });

  it('holds what is sent before the welcome, and sends it after', async () => {
    const { bridge, posted, deliver, hello } = connected();
    bridge.toast('Ready');
    bridge.loading(true);
    expect(posted).toHaveLength(1);

    deliver(welcome(hello.id));
    const answered = await bridge.ready;
    expect(answered.app.name).toBe('Reviews');
    expect(posted.map((p) => p.message.type)).toEqual(['hello', 'toast', 'loading']);
  });

  it('believes nothing from another origin', async () => {
    const { bridge, deliver, hello } = connected();
    deliver(welcome(hello.id), 'https://evil.test');
    expect(bridge.welcome).toBeNull();
    deliver(welcome(hello.id));
    expect((await bridge.ready).storeId).toBe('store-1');
  });

  it('throws in the app’s own code on a message the admin would refuse', async () => {
    const { bridge, deliver, hello } = connected();
    deliver(welcome(hello.id));
    expect(() => bridge.navigate('https://evil.test')).toThrow(BridgeError);
    await expect(bridge.modal.open('//evil.test', 'Hi')).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('answers a request with its response, and a refusal with its code', async () => {
    const { bridge, posted, deliver, hello } = connected();
    deliver(welcome(hello.id));

    const choosing = bridge.pick('products', { multiple: true });
    const ask = posted.at(-1)!.message as { id: string };
    deliver({
      protocol: PROTOCOL,
      type: 'response',
      id: ask.id,
      ok: true,
      result: { selection: [{ id: 'p1', title: 'Mug' }] },
    });
    expect(await choosing).toEqual([{ id: 'p1', title: 'Mug' }]);

    const refused = bridge.pick('customers');
    const second = posted.at(-1)!.message as { id: string };
    deliver({
      protocol: PROTOCOL,
      type: 'response',
      id: second.id,
      ok: false,
      error: { code: 'not_granted', message: 'This app cannot read customers.' },
    });
    await expect(refused).rejects.toMatchObject({ code: 'not_granted' });
  });

  it('uses the session it has while it lasts, and asks for a fresh one after', async () => {
    const { bridge, posted, deliver, hello } = connected();
    deliver(
      welcome(hello.id, {
        session: { token: 'old', expiresAt: new Date(Date.now() + 30_000).toISOString() },
      }),
    );
    const asking = bridge.sessionToken();
    await Promise.resolve();
    await Promise.resolve();
    const request = posted.at(-1)!.message as { id: string; type: string };
    expect(request.type).toBe('session.request');
    deliver({
      protocol: PROTOCOL,
      type: 'response',
      id: request.id,
      ok: true,
      result: { token: 'new', expiresAt: new Date(Date.now() + 300_000).toISOString() },
    });
    expect(await asking).toBe('new');
    expect(await bridge.sessionToken()).toBe('new');
  });

  it('gives up on the admin’s code after the timeout, but waits on the merchant', async () => {
    vi.useFakeTimers();
    const f = frame();
    const bridge = createAppBridge({
      hostOrigin: HOST,
      window: f.window,
      parent: f.parent,
      timeoutMs: 50,
    });
    const hello = f.posted[0]!.message as { id: string };
    f.deliver(welcome(hello.id, { session: { token: 't', expiresAt: '2000-01-01T00:00:00Z' } }));
    await bridge.ready;

    const token = bridge.sessionToken();
    const confirm = bridge.confirm({ title: 'Sure?', message: 'Really.' });
    let confirmed: boolean | null = null;
    void confirm.then((answer) => (confirmed = answer));
    const rejected = expect(token).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(confirmed).toBeNull();
  });

  it('passes the admin’s events on, and stops when disposed', async () => {
    const { bridge, deliver, hello, listeners } = connected();
    deliver(welcome(hello.id));
    const actions: string[] = [];
    let saves = 0;
    bridge.on('title_bar.action', (action) => actions.push(action));
    bridge.on('save_bar.save', () => (saves += 1));

    deliver({ protocol: PROTOCOL, type: 'title_bar.action', action: 'export' });
    deliver({ protocol: PROTOCOL, type: 'save_bar.save' });
    expect(actions).toEqual(['export']);
    expect(saves).toBe(1);

    const pending = bridge.confirm({ title: 'Sure?', message: 'Really.' });
    bridge.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'disposed' });
    expect(listeners.size).toBe(0);
  });

  it('writes the theme onto an element', async () => {
    const { bridge, deliver, hello } = connected();
    deliver(welcome(hello.id));
    const set: Record<string, string> = {};
    bridge.applyTheme({
      style: { setProperty: (name: string, value: string) => (set[name] = value) },
    } as unknown as HTMLElement);
    expect(set).toEqual({ '--sw-bg': '#101010' });
  });
});
