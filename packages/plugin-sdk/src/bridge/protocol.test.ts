import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  PROTOCOL,
  PROTOCOL_V1,
  isAdminPath,
  isAppPath,
  isRedirectUrl,
  parseAppMessage,
  parseHostMessage,
  pickersFor,
} from './protocol';

const v2 = (message: Record<string, unknown>) => ({ protocol: PROTOCOL, ...message });

describe('paths an app may name', () => {
  it('takes a page of its own home and nothing that leaves it', () => {
    expect(isAppPath('/')).toBe(true);
    expect(isAppPath('/settings/billing')).toBe(true);
    expect(isAppPath('settings')).toBe(false);
    expect(isAppPath('//evil.test')).toBe(false);
    expect(isAppPath('/a/../../admin')).toBe(false);
    expect(isAppPath('/a\\b')).toBe(false);
    expect(isAppPath('/settings?tab=1')).toBe(false);
    expect(isAppPath('https://evil.test')).toBe(false);
  });

  it('takes a page of the shop with a plain query, and no other host', () => {
    expect(isAdminPath('/orders')).toBe(true);
    expect(isAdminPath('/products?status=draft&sort=title')).toBe(true);
    expect(isAdminPath('//evil.test/orders')).toBe(false);
    expect(isAdminPath('/orders?next=<script>')).toBe(false);
    expect(isAdminPath('/orders?a=1?b=2')).toBe(false);
    expect(isAdminPath('javascript:alert(1)')).toBe(false);
  });

  it('sends a merchant off Storeware only over https, or to the developer’s own machine', () => {
    expect(isRedirectUrl('https://example.com/help')).toBe(true);
    expect(isRedirectUrl('http://localhost:4000/help')).toBe(true);
    expect(isRedirectUrl('http://example.com')).toBe(false);
    expect(isRedirectUrl('javascript:alert(1)')).toBe(false);
    expect(isRedirectUrl('https://user:pass@example.com')).toBe(false);
    expect(isRedirectUrl('not a url')).toBe(false);
  });
});

describe('pickers', () => {
  it('opens for what the grant reads, counting write as read', () => {
    expect(pickersFor(['products:read'])).toEqual(['products', 'variants', 'collections']);
    expect(pickersFor(['customers:write'])).toEqual(['customers']);
    expect(pickersFor(['orders:read'])).toEqual([]);
  });
});

describe('parseAppMessage', () => {
  it('ignores what is not the bridge', () => {
    expect(parseAppMessage(null)).toBeNull();
    expect(parseAppMessage('hello')).toBeNull();
    expect(parseAppMessage({ type: 'hello' })).toBeNull();
    expect(parseAppMessage({ protocol: 'somebody.else', type: 'hello' })).toBeNull();
  });

  it('reads version 1 as the version 1 admin did', () => {
    expect(parseAppMessage({ protocol: PROTOCOL_V1, type: 'ready' })).toEqual({
      version: 1,
      message: { protocol: PROTOCOL_V1, type: 'ready' },
    });
    expect(
      parseAppMessage({ protocol: PROTOCOL_V1, type: 'toast', message: 'Hi', tone: 'warn' }),
    ).toMatchObject({ version: 1, message: { type: 'toast', tone: 'warn' } });
    expect(parseAppMessage({ protocol: PROTOCOL_V1, type: 'title_bar' })).toBeNull();
  });

  it('reads the handshake and every request', () => {
    const messages = [
      { type: 'hello', id: 'a', versions: [2] },
      { type: 'session.request', id: 'b' },
      { type: 'resize', height: 300 },
      { type: 'toast', message: 'Saved', tone: 'info' },
      { type: 'loading', on: true },
      {
        type: 'title_bar',
        title: 'Reviews',
        primary: { id: 'save', label: 'Save' },
        secondary: [{ id: 'export', label: 'Export' }],
      },
      { type: 'save_bar', dirty: true },
      { type: 'save_bar.result', ok: false, message: 'Name is missing' },
      { type: 'modal.open', id: 'c', path: '/reviews/new', title: 'New review', size: 'large' },
      { type: 'modal.close', data: { saved: 3 } },
      { type: 'confirm', id: 'd', title: 'Delete it?', message: 'This cannot be undone.' },
      { type: 'picker', id: 'e', resource: 'variants', multiple: true, max: 10 },
      { type: 'navigate', path: '/orders' },
      { type: 'app.navigate', path: '/settings' },
      { type: 'redirect', url: 'https://example.com' },
    ];
    for (const message of messages) {
      expect(parseAppMessage(v2(message)), message.type).toEqual({
        version: 2,
        message: v2(message),
      });
    }
  });

  it('answers a malformed request by its id, so it is not left waiting', () => {
    expect(parseAppMessage(v2({ type: 'picker', id: 'p1', resource: 'orders' }))).toMatchObject({
      version: 2,
      id: 'p1',
      invalid: expect.stringContaining('resource'),
    });
    expect(parseAppMessage(v2({ type: 'nonsense' }))).toMatchObject({ version: 2, id: null });
  });

  it('holds every message to its bounds', () => {
    const refused = [
      { type: 'hello', versions: [2] },
      { type: 'toast', message: 'x'.repeat(LIMITS.message + 1) },
      { type: 'toast', message: '   ' },
      { type: 'title_bar', secondary: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, label: 'A' })) },
      { type: 'title_bar', primary: { id: 'has space', label: 'Save' } },
      { type: 'title_bar', primary: { id: 'save', label: 'Save', onClick: 'steal()' } },
      { type: 'modal.open', id: 'm', path: '//evil.test', title: 'Hi' },
      { type: 'modal.open', id: 'm', path: '/ok', title: '' },
      { type: 'modal.close', data: 'x'.repeat(LIMITS.modalData) },
      { type: 'picker', id: 'p', resource: 'products', max: LIMITS.pick + 1 },
      { type: 'navigate', path: 'https://evil.test' },
      { type: 'app.navigate', path: '/../admin' },
      { type: 'redirect', url: 'http://evil.test' },
      { type: 'resize', height: Number.POSITIVE_INFINITY },
    ];
    for (const message of refused) {
      expect(parseAppMessage(v2(message)), JSON.stringify(message)).toHaveProperty('invalid');
    }
  });
});

describe('parseHostMessage', () => {
  it('reads a welcome, and drops one that is not from the bridge', () => {
    const welcome = {
      protocol: PROTOCOL,
      type: 'welcome',
      id: 'h1',
      version: 2,
      app: { name: 'Reviews', slug: 'reviews' },
      storeId: 'store-1',
      point: 'admin.product.index.action',
      context: { selection: ['a', 'b'] },
      theme: { scheme: 'dark', variables: { '--sw-bg': '#000' } },
      session: { token: 't', expiresAt: '2026-10-28T12:00:00.000Z' },
      pickers: ['products'],
      modal: true,
    };
    expect(parseHostMessage(welcome)).toEqual(welcome);
    expect(parseHostMessage({ ...welcome, protocol: 'other' })).toBeNull();
    expect(parseHostMessage({ ...welcome, pickers: ['orders'] })).toBeNull();
  });

  it('reads version 1’s context message', () => {
    const context = { protocol: PROTOCOL_V1, type: 'context', storeId: 's', context: {} };
    expect(parseHostMessage(context)).toEqual(context);
  });
});
