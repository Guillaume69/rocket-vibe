// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // `lib/emojis.generated.ts` : 260 Ko sur une ligne, produits par
    // `npm run emojis:generate`. Rien à y corriger à la main.
    ignores: ['dist/*', 'db/migrations/*', 'lib/emojis.generated.ts'],
  },
  {
    files: ['lib/**/*.ts', 'db/**/*.ts'],
    rules: {
      // Les modules de `lib/` et `db/` doivent rester chargeables par Node,
      // qui ne sait que DÉPOUILLER les types, pas les compiler. Une
      // « parameter property » (`constructor(private x: T)`) ou une `enum`
      // émettent du code : Node refuse le fichier, et les tests ne tournent
      // plus. Deux fois piégé, une fois interdit.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSParameterProperty',
          message:
            'Syntaxe non effaçable : utilise un champ ordinaire, sinon Node ne peut plus charger le module (et donc plus le tester).',
        },
        {
          selector: 'TSEnumDeclaration',
          message: 'Syntaxe non effaçable : utilise un objet `as const` ou une union de littéraux.',
        },
      ],
    },
  },
]);
