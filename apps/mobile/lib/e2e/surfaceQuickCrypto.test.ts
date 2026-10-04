import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * L'ALIAS Metro est la ligne dont dépend toute la crypto embarquée : si
 * `crypto` cesse de se résoudre vers `react-native-quick-crypto`, l'app charge
 * un polyfill pur JS (ou rien), et l'E2EE meurt sans qu'aucun test ne bouge.
 * On exécute ici le VRAI `metro.config.js` — pas une copie de sa logique —
 * avec un contexte factice qui enregistre ce que le résolveur demande.
 *
 * La surface de l'API quick-crypto, elle, est verrouillée par les assertions
 * de types de `surfaceQuickCrypto.ts` (vérifiées par `npx tsc --noEmit`) : le
 * module natif ne peut pas se CHARGER sous Node, on ne peut donc pas rejouer
 * les vecteurs de `crypto.test.ts` contre lui ici.
 */

type ResolutionContext = {
  resolveRequest: (context: ResolutionContext, module: string, platform: string | null) => unknown;
};

type MetroConfig = {
  resolver: {
    resolveRequest?: (
      context: ResolutionContext,
      module: string,
      platform: string | null,
    ) => unknown;
    sourceExts: string[];
  };
};

// `metro.config.js` est du CommonJS : l'interop ESM le sert sous `default`.
// Son chargement exécute `getDefaultConfig(__dirname)` — le vrai, celui
// d'expo — donc ce test casse aussi si la config devient inchargeable.
const config = (await import('../../metro.config.js')).default as MetroConfig;

function resolve(module: string): { requests: string[]; rendered: unknown } {
  const requests: string[] = [];
  const sentinel = { type: 'sourceFile' };
  const context: ResolutionContext = {
    resolveRequest: (_ctx, name) => {
      requests.push(name);
      return sentinel;
    },
  };
  assert.notEqual(config.resolver.resolveRequest, undefined);
  const rendered = config.resolver.resolveRequest?.(context, module, 'android');
  return { requests, rendered: rendered === sentinel ? 'sentinelle' : rendered };
}

describe('alias Metro de la crypto embarquée', () => {
  test('`crypto` se résout vers react-native-quick-crypto', () => {
    const { requests, rendered } = resolve('crypto');
    assert.deepEqual(requests, ['react-native-quick-crypto']);
    // Le résultat du résolveur standard est bien RENDU, pas avalé.
    assert.equal(rendered, 'sentinelle');
  });

  test('`buffer` se résout vers l’implémentation feuille, PAS le barrel quick-crypto', () => {
    // L'aliaser vers le barrel créerait un cycle de require — voir le
    // commentaire de metro.config.js. La cible exacte fait partie du contrat.
    const { requests } = resolve('buffer');
    assert.deepEqual(requests, ['@craftzdog/react-native-buffer']);
  });

  test('les deux cibles de l’alias sont installées', () => {
    // Un `npm prune` ou une migration qui retire l'une d'elles rendrait
    // l'alias pointé sur du vide — Metro n'échouerait qu'au build.
    for (const pkg of ['react-native-quick-crypto', '@craftzdog/react-native-buffer']) {
      assert.doesNotThrow(() => import.meta.resolve(pkg), `${pkg} introuvable`);
    }
  });

  test('les migrations .sql restent résolubles (sourceExts)', () => {
    assert.ok(config.resolver.sourceExts.includes('sql'));
  });
});
