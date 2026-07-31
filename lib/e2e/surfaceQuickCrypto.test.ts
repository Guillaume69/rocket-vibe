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

type ContexteResolution = {
  resolveRequest: (contexte: ContexteResolution, module: string, plateforme: string | null) => unknown;
};

type ConfigMetro = {
  resolver: {
    resolveRequest?: (
      contexte: ContexteResolution,
      module: string,
      plateforme: string | null,
    ) => unknown;
    sourceExts: string[];
  };
};

// `metro.config.js` est du CommonJS : l'interop ESM le sert sous `default`.
// Son chargement exécute `getDefaultConfig(__dirname)` — le vrai, celui
// d'expo — donc ce test casse aussi si la config devient inchargeable.
const config = (await import('../../metro.config.js')).default as ConfigMetro;

function resoudre(module: string): { demandes: string[]; rendu: unknown } {
  const demandes: string[] = [];
  const sentinelle = { type: 'sourceFile' };
  const contexte: ContexteResolution = {
    resolveRequest: (_ctx, nom) => {
      demandes.push(nom);
      return sentinelle;
    },
  };
  assert.notEqual(config.resolver.resolveRequest, undefined);
  const rendu = config.resolver.resolveRequest?.(contexte, module, 'android');
  return { demandes, rendu: rendu === sentinelle ? 'sentinelle' : rendu };
}

describe('alias Metro de la crypto embarquée', () => {
  test('`crypto` se résout vers react-native-quick-crypto', () => {
    const { demandes, rendu } = resoudre('crypto');
    assert.deepEqual(demandes, ['react-native-quick-crypto']);
    // Le résultat du résolveur standard est bien RENDU, pas avalé.
    assert.equal(rendu, 'sentinelle');
  });

  test('`buffer` se résout vers l’implémentation feuille, PAS le barrel quick-crypto', () => {
    // L'aliaser vers le barrel créerait un cycle de require — voir le
    // commentaire de metro.config.js. La cible exacte fait partie du contrat.
    const { demandes } = resoudre('buffer');
    assert.deepEqual(demandes, ['@craftzdog/react-native-buffer']);
  });

  test('les deux cibles de l’alias sont installées', () => {
    // Un `npm prune` ou une migration qui retire l'une d'elles rendrait
    // l'alias pointé sur du vide — Metro n'échouerait qu'au build.
    for (const paquet of ['react-native-quick-crypto', '@craftzdog/react-native-buffer']) {
      assert.doesNotThrow(() => import.meta.resolve(paquet), `${paquet} introuvable`);
    }
  });

  test('les migrations .sql restent résolubles (sourceExts)', () => {
    assert.ok(config.resolver.sourceExts.includes('sql'));
  });
});
