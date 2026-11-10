// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL } from '@storeware/plugin-sdk/bridge/protocol';
import {
  AppBridgeProvider,
  useAuthenticatedFetch,
  useSaveBar,
  useTitleBar,
  useWelcome,
} from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = 'https://app.storeware.test';

let posted: { type: string; id?: string; [key: string]: unknown }[] = [];
const parent = {
  postMessage: (message: unknown) => {
    posted.push(message as (typeof posted)[number]);
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  posted = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The admin answers, from its own origin. */
async function deliver(data: Record<string, unknown>, origin = HOST) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { protocol: PROTOCOL, ...data }, origin }),
    );
    await Promise.resolve();
  });
}

async function welcome(extra: Record<string, unknown> = {}) {
  const hello = posted.find((message) => message.type === 'hello')!;
  await deliver({
    type: 'welcome',
    id: hello.id,
    version: 2,
    app: { name: 'Reviews', slug: 'reviews' },
    storeId: 'store-1',
    point: 'admin.product.index.action',
    context: { selection: ['p1', 'p2'] },
    theme: { scheme: 'dark', variables: { '--sw-bg': 'black', '--sw-fg': 'white' } },
    session: { token: 'tok', expiresAt: new Date(Date.now() + 300_000).toISOString() },
    pickers: ['products'],
    modal: true,
    ...extra,
  });
}

function mount(children: React.ReactNode) {
  act(() =>
    root.render(
      <AppBridgeProvider hostOrigin={HOST} autoResize={false} options={{ parent }}>
        {children}
      </AppBridgeProvider>,
    ),
  );
}

describe('AppBridgeProvider', () => {
  it('says hello, and hands the welcome and the theme to the page', async () => {
    function Selection() {
      const welcomed = useWelcome();
      return <p>{welcomed ? (welcomed.context.selection as string[]).join(',') : 'waiting'}</p>;
    }
    mount(<Selection />);
    expect(container.textContent).toBe('waiting');
    expect(posted[0]).toMatchObject({ protocol: PROTOCOL, type: 'hello', versions: [2] });

    await welcome();
    expect(container.textContent).toBe('p1,p2');
    expect(document.documentElement.style.getPropertyValue('--sw-bg')).toBe('black');
  });

  it('believes nothing from another origin', async () => {
    function Ready() {
      return <p>{useWelcome() ? 'ready' : 'waiting'}</p>;
    }
    mount(<Ready />);
    const hello = posted[0]!;
    await deliver({ type: 'welcome', id: hello.id }, 'https://evil.test');
    expect(container.textContent).toBe('waiting');
  });
});

describe('useTitleBar', () => {
  it('sends the bar, runs a button’s handler, and clears the bar when the page goes', async () => {
    const pressed: string[] = [];
    function Page() {
      useTitleBar({
        title: 'Reviews',
        primary: { label: 'Save', onAction: () => pressed.push('save') },
        secondary: [{ label: 'Export', onAction: () => pressed.push('export') }],
      });
      return null;
    }
    mount(<Page />);
    await welcome();
    expect(posted.filter((message) => message.type === 'title_bar').at(-1)).toMatchObject({
      title: 'Reviews',
      primary: { id: 'primary', label: 'Save' },
      secondary: [{ id: 'secondary-0', label: 'Export' }],
    });

    await deliver({ type: 'title_bar.action', action: 'secondary-0' });
    await deliver({ type: 'title_bar.action', action: 'primary' });
    expect(pressed).toEqual(['export', 'save']);

    act(() =>
      root.render(
        <AppBridgeProvider hostOrigin={HOST} options={{ parent }}>
          {null}
        </AppBridgeProvider>,
      ),
    );
    expect(posted.filter((message) => message.type === 'title_bar').at(-1)).toEqual({
      protocol: PROTOCOL,
      type: 'title_bar',
    });
  });
});

describe('useSaveBar', () => {
  it('says when the page is dirty, and answers a save with how it went', async () => {
    let fail = false;
    function Form() {
      const [dirty] = useState(true);
      useSaveBar({
        dirty,
        onSave: async () => {
          if (fail) throw new Error('Name is missing');
        },
        onDiscard: () => {},
      });
      return null;
    }
    mount(<Form />);
    await welcome();
    expect(posted.some((message) => message.type === 'save_bar' && message['dirty'] === true)).toBe(
      true,
    );

    await deliver({ type: 'save_bar.save' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(posted.filter((message) => message.type === 'save_bar.result').at(-1)).toMatchObject({
      ok: true,
    });

    fail = true;
    await deliver({ type: 'save_bar.save' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(posted.filter((message) => message.type === 'save_bar.result').at(-1)).toMatchObject({
      ok: false,
      message: 'Name is missing',
    });
  });
});

describe('useAuthenticatedFetch', () => {
  it('sends the session as a bearer token', async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('{}');
    }) as typeof fetch;

    let call: (() => Promise<Response>) | null = null;
    function Page() {
      const authenticated = useAuthenticatedFetch();
      call = () => authenticated('https://reviews.test/api');
      return null;
    }
    mount(<Page />);
    await welcome();
    await act(async () => {
      await call!();
    });
    globalThis.fetch = original;
    expect(seen).toEqual(['Bearer tok']);
  });
});
