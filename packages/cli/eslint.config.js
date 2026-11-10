import base from '@storeware/config/eslint/base';

export default [
  ...base,
  // The apps `storeware init` writes. They are the developer's code, under
  // their own rules, and `scripts/pack-smoke.mjs` installs, typechecks and
  // builds every one against the packages as published.
  { ignores: ['templates/**'] },
];
