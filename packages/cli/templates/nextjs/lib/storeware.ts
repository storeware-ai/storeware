import 'server-only';
import { createStorewareApp, memoryInstallationStore } from '@storeware/plugin-sdk';

/**
 * One Storeware app for the whole server. `server-only` keeps it, and the
 * client secret, out of anything sent to a browser.
 *
 * `storeware app dev` sets the environment for you.
 */
export const storeware = createStorewareApp({
  clientId: process.env.STOREWARE_CLIENT_ID ?? '',
  clientSecret: process.env.STOREWARE_CLIENT_SECRET ?? '',
  // In memory, so installs are forgotten on restart. Replace it with your own
  // store over a database: the secrets in it are handed over once and never again.
  installations: memoryInstallationStore(),
  ...(process.env.STOREWARE_API_URL ? { apiUrl: process.env.STOREWARE_API_URL } : {}),
  ...(process.env.STOREWARE_ADMIN_URL ? { adminUrl: process.env.STOREWARE_ADMIN_URL } : {}),
});

export const ADMIN_URL = process.env.STOREWARE_ADMIN_URL ?? 'https://app.storeware.ai';

storeware.webhooks
  .on<{ title: string }>('product.created.v1', (event) => {
    console.log('product created in', event.storeId, event.data.title);
  })
  .on<{ title: string }>('product.updated.v1', (event) => {
    console.log('product updated in', event.storeId, event.data.title);
  })
  .onCompliance((event) => {
    // Find and export, or delete, what you hold about the person or shop named.
    console.log('privacy request', event.event, event.data);
  });
