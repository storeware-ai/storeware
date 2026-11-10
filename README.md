<!--
  This repository is generated from the Storeware monorepo, where these packages
  are developed. It is where they are released from, not the working copy, so a
  change made here is lost on the next sync.

  Issues are read and very welcome. If you want to send a patch, open an issue
  first and we will point you at how it lands upstream.
-->

# Storeware developer packages

Build apps for [Storeware](https://storeware.ai) shops.

- [`@storeware/plugin-sdk`](https://www.npmjs.com/package/@storeware/plugin-sdk) (`packages/plugin-sdk`): Build plugins for Storeware. Verify webhooks, call the API, stay in scope.
- [`@storeware/app-ui`](https://www.npmjs.com/package/@storeware/app-ui) (`packages/app-ui`): React components for pages the Storeware admin frames, styled only by the admin's 13 --sw-* variables.
- [`@storeware/app-bridge-react`](https://www.npmjs.com/package/@storeware/app-bridge-react) (`packages/app-bridge-react`): React hooks for App Bridge: toasts, the title bar, the save bar, modals and pickers in the Storeware admin.
- [`@storeware/cli`](https://www.npmjs.com/package/@storeware/cli) (`packages/cli`): Scaffold, run, check and ship Storeware apps.

```bash
npx @storeware/cli init my-app --template react-router
```

Docs: [storeware.ai/docs](https://storeware.ai/docs).

## How a release is made

Each tag `packages-v<version>` runs `.github/workflows/release-packages.yml`. It packs all four
packages, scaffolds every `storeware init` template from the packed CLI, installs each from the
tarballs and builds it (`scripts/pack-smoke.mjs`), and then publishes those same tarballs to npm
through trusted publishing, with provenance. No npm token is stored in this repository.

`packages/config` and `packages/theme-schema` are here only to build the others.

MIT licensed. Copyright Crawlog LLC.
