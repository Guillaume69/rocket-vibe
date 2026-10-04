// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // `lib/emojis.generated.ts`: 260 KB on one line, produced by
    // `npm run emojis:generate`. Nothing to fix there by hand.
    ignores: ['dist/*', 'db/migrations/*', 'lib/emojis.generated.ts'],
  },
  {
    files: ['lib/**/*.ts', 'db/**/*.ts'],
    rules: {
      // The `lib/` and `db/` modules must stay loadable by Node, which can only
      // STRIP types, not compile them. A "parameter property"
      // (`constructor(private x: T)`) or an `enum` emit code: Node refuses the
      // file, and the tests no longer run. Bitten twice, forbidden once.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSParameterProperty',
          message:
            'Non-erasable syntax: use a plain field, otherwise Node can no longer load the module (and so no longer test it).',
        },
        {
          selector: 'TSEnumDeclaration',
          message: 'Non-erasable syntax: use an `as const` object or a union of literals.',
        },
      ],
    },
  },
]);
