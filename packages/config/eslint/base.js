import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Base ESLint flat config shared by every package and app.
 *
 * The custom rules below are not style preferences. Each one guards an
 * invariant from the architecture plan, so violations are errors rather
 * than warnings.
 */
export default tseslint.config(
  {
    /*
     * `.open-next/**` and `.wrangler/**` are build output from the Cloudflare
     * adapter, and they contain COPIES of the app's own source. Without them
     * here, every rule runs a second time against a generated duplicate and
     * reports errors at paths nobody can edit.
     *
     * The last entry is not build output and is not tidiness. Vitest writes
     * `vitest.config.ts.timestamp-<n>.mjs` beside the config while it loads it
     * and deletes it moments later, and turbo runs `lint` and `test` in the same
     * package concurrently. So ESLint enumerates the file, the file goes, and
     * the read fails:
     *
     *     Error: ENOENT: no such file or directory, open
     *     '.../packages/core/vitest.config.ts.timestamp-1788278649695-….mjs'
     *
     * It took down the storefront's Worker build on 2026-09-01 and left the shop
     * front a commit behind, and it is a race rather than a defect: the same
     * commit built the API fine, minutes apart. Nothing about it is
     * reproducible, which is exactly why it has to be excluded rather than
     * waited out.
     */
    ignores: [
      'dist/**',
      '.next/**',
      '.open-next/**',
      '.wrangler/**',
      '.turbo/**',
      'coverage/**',
      'node_modules/**',
      '**/*.timestamp-*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Resolves each file to its nearest tsconfig, which is what gives the
      // rule above the types it needs. Costs lint time; worth it for one rule
      // whose failure mode is silent.
      parserOptions: { projectService: true },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // On, and type-aware, which is why the parserOptions block below exists.
      // It was off because the rule needs type information and nothing here
      // provided any. That gap let a promise-returning guard be called without
      // `await` in five setup files, where the only consequence would have been
      // the guard silently not running: no error, no failure, just destructive
      // tests proceeding unchecked. Exactly the class of mistake a person
      // should not be the last line of defence against.
      //
      // Only this rule is enabled type-aware rather than the whole
      // recommendedTypeChecked set, which would be a much larger change to
      // absorb in one go.
      '@typescript-eslint/no-floating-promises': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Money is stored in minor units as bigint. Float arithmetic on money
      // is a correctness bug, so parseFloat on amounts is banned outright.
      /*
       * Tailwind utilities that pick a side of the screen rather than a side of
       * the text.
       *
       * `pl-4` is padding on the left in every language; `ps-4` is padding
       * before the text starts, which is the left in English and the right in
       * Arabic. Setting `dir` on `<html>` mirrors a layout for free, but only
       * the logical utilities follow it, and one `mr-3` left behind is a gap on
       * the wrong side of a label with nothing on screen to explain it.
       *
       * A hundred and sixty of these were converted in one pass. This is what
       * stops the hundred and sixty-first, because the failure is invisible to
       * anybody not reading the page in Arabic.
       *
       * Deliberately narrow on the suffix, so `pl-PL` in a locale list is not a
       * padding utility. Deliberately silent about `origin-` and `translate-`,
       * which have no logical form: an element centred with `left-1/2` and
       * `-translate-x-1/2` is centred in both directions and both halves have
       * to stay physical.
       */
      'no-restricted-syntax': [
        'error',
        {
          selector: String.raw`Literal[value=/(?:^|[^\w-])(?:-?(?:pl|pr|ml|mr)-(?:\d|(?:px|auto|full)(?![\w-])|\[)|-?(?:left|right)-(?:\d|(?:px|auto|full)(?![\w-])|\[)|text-(?:left|right)(?![\w-])|float-(?:left|right)(?![\w-])|border-[lr](?:-|$|[^\w-])|rounded-(?:l|r|tl|tr|bl|br)(?:-|$|[^\w-]))/]`,
          message:
            'Use the logical Tailwind utility so the layout follows the reader: ps/pe, ms/me, start/end, text-start/text-end, border-s/border-e, rounded-s/rounded-e.',
        },
        {
          selector: String.raw`TemplateElement[value.raw=/(?:^|[^\w-])(?:-?(?:pl|pr|ml|mr)-(?:\d|(?:px|auto|full)(?![\w-])|\[)|-?(?:left|right)-(?:\d|(?:px|auto|full)(?![\w-])|\[)|text-(?:left|right)(?![\w-])|float-(?:left|right)(?![\w-])|border-[lr](?:-|$|[^\w-])|rounded-(?:l|r|tl|tr|bl|br)(?:-|$|[^\w-]))/]`,
          message:
            'Use the logical Tailwind utility so the layout follows the reader: ps/pe, ms/me, start/end, text-start/text-end, border-s/border-e, rounded-s/rounded-e.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is bigint minor units. Do not parse amounts as float.',
        },
      ],
    },
  },
  {
    // Build config files sit outside every tsconfig's `include`, so the
    // project service cannot type them and errors out trying. They are
    // configuration rather than application code and have no promises to
    // float, so exempting them from the type-aware rules costs nothing.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
