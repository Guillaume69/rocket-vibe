import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { e2eStorageKey, legacyE2eStorageKey, sessionStorageKey, withoutTrailingSlash } from './storageKeys.ts';

/** Ce que fait `expo-crypto` côté app : SHA-256 hexadécimal minuscule. */
const hash = async (t: string) => createHash('sha256').update(t).digest('hex');

describe('clesStockage — forme des clés', () => {
  test('les clés respectent l’alphabet imposé par expo-secure-store', async () => {
    // `[A-Za-z0-9._-]` seulement : une URL brute (`:`, `/`) ferait échouer
    // l'écriture au Keystore, donc perdre la session sans un mot d'erreur.
    for (const key of [
      await sessionStorageKey('https://héberge.me:3000/chat/', hash),
      await e2eStorageKey('https://héberge.me:3000/chat/', 'uid/../x', hash),
      await legacyE2eStorageKey('https://héberge.me:3000/chat/', hash),
    ]) {
      assert.match(key, /^[A-Za-z0-9._-]+$/);
    }
  });

  test('le préfixe distingue les deux portées', async () => {
    assert.match(await sessionStorageKey('https://x', hash), /^session-/);
    assert.match(await e2eStorageKey('https://x', 'u1', hash), /^e2e-/);
  });
});

describe('clesStockage — la session est par SERVEUR', () => {
  test('la barre finale ne change pas la clé', async () => {
    assert.equal(await sessionStorageKey('https://x', hash), await sessionStorageKey('https://x/', hash));
  });

  test('deux serveurs distincts donnent deux clés distinctes', async () => {
    assert.notEqual(
      await sessionStorageKey('https://a.example', hash),
      await sessionStorageKey('https://b.example', hash),
    );
  });

  test('le compte ne rentre PAS dans la clé de session', async () => {
    // Volontaire : plusieurs serveurs cohabitent, et c'est la session qui dit
    // quel compte. Le pointeur « dernier serveur » n'a que l'URL sous la main.
    const expected = `session-${(await hash('https://x')).slice(0, 32)}`;
    assert.equal(await sessionStorageKey('https://x/', hash), expected);
  });
});

describe('clesStockage — la clé E2EE est par (SERVEUR, COMPTE)', () => {
  test('deux comptes du MÊME serveur ne partagent pas leur clé privée', async () => {
    // Le défaut corrigé : `e2e.reprendre()` réimportait le JWK du compte
    // précédent pour le suivant. L'import RÉUSSIT (c'est un JWK valide),
    // `estDeverrouille` passe à vrai, et le déchiffrement des clés de salon
    // échoue en silence — « chiffré, lecture seule », sans chemin de sortie.
    assert.notEqual(
      await e2eStorageKey('https://x', 'uid-alice', hash),
      await e2eStorageKey('https://x', 'uid-bob', hash),
    );
  });

  test('le même compte sur le même serveur retrouve sa clé', async () => {
    assert.equal(await e2eStorageKey('https://x/', 'u1', hash), await e2eStorageKey('https://x', 'u1', hash));
  });

  test('le même compte sur deux serveurs a deux clés', async () => {
    // Deux workspaces Rocket.Chat peuvent attribuer le même `_id` : sans le
    // serveur dans la matière, une clé irait déverrouiller l'autre instance.
    assert.notEqual(
      await e2eStorageKey('https://a.example', 'u1', hash),
      await e2eStorageKey('https://b.example', 'u1', hash),
    );
  });

  test('le séparateur empêche la confusion serveur/compte', async () => {
    // Sans `|`, ('https://x/a', 'b') et ('https://x/ab', '') se condenseraient
    // sur la même clé : un compte lirait la clé privée d'un autre.
    assert.notEqual(await e2eStorageKey('https://x/a', 'b', hash), await e2eStorageKey('https://x/ab', '', hash));
  });

  test('la clé E2EE d’un compte n’est JAMAIS la clé héritée du serveur', async () => {
    // Si elles coïncidaient, la migration serait un no-op et le trou resterait.
    assert.notEqual(await e2eStorageKey('https://x', 'u1', hash), await legacyE2eStorageKey('https://x', hash));
  });
});

describe('clesStockage — la clé héritée reste dérivable pour être effacée', () => {
  test('elle vaut exactement ce que l’ancien code écrivait', async () => {
    // Reproduction littérale de l'ancien `cleE2E(baseUrl)` de sessionStore.ts.
    // Ce test est le seul gardien de l'entrée orpheline : `expo-secure-store`
    // n'énumère pas ses clés, donc si cette dérivation dérive, le JWK RSA
    // DÉCHIFFRÉ d'une session passée reste sur l'appareil pour toujours.
    const old = `e2e-${(await hash('https://chat.barrut.me')).slice(0, 32)}`;
    assert.equal(await legacyE2eStorageKey('https://chat.barrut.me/', hash), old);
  });
});

describe('sansSlashFinal', () => {
  test('plusieurs barres finales tombent, le reste est intact', () => {
    assert.equal(withoutTrailingSlash('https://x/chat///'), 'https://x/chat');
    assert.equal(withoutTrailingSlash('https://x/chat'), 'https://x/chat');
    assert.equal(withoutTrailingSlash('https://x'), 'https://x');
  });
});
