import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { threadLoadedUnder, markThreadLoaded, forgetLoadedThreads } from './loadedThreads.ts';
import { sessionToken } from './sessionToken.ts';

describe('filsCharges', () => {
  beforeEach(() => forgetLoadedThreads());

  test('un fil jamais ouvert n’est pas chargé', () => {
    assert.equal(threadLoadedUnder('f1', 3), false);
  });

  test('rouvrir sous la MÊME génération : rien à recharger', () => {
    // Le gaspillage évité : `chat.getMessage` puis toute la pagination du fil,
    // rejoués à CHAQUE raccordement parce que `generation` est dans les deps.
    markThreadLoaded('f1', 3, sessionToken());
    assert.equal(threadLoadedUnder('f1', 3), true);
  });

  test('après un raccordement, la garde tombe', () => {
    markThreadLoaded('f1', 3, sessionToken());
    assert.equal(threadLoadedUnder('f1', 4), false);
  });

  test('les fils sont indépendants, et n’ont rien à voir avec les salons', () => {
    markThreadLoaded('f1', 3, sessionToken());
    assert.equal(threadLoadedUnder('f2', 3), false);
  });

  test('fin de session : tout le cache est oublié', () => {
    markThreadLoaded('f1', 3, sessionToken());
    forgetLoadedThreads();
    assert.equal(threadLoadedUnder('f1', 3), false);
  });

  test('un chargement qui ABOUTIT après la fin de session ne repeuple rien', () => {
    const jeton = sessionToken();
    forgetLoadedThreads();
    markThreadLoaded('f1', 3, jeton);
    assert.equal(threadLoadedUnder('f1', 3), false);
  });
});
