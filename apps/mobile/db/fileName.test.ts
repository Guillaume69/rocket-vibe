import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { databaseFileName } from './fileName.ts';

describe('nomFichier', () => {
  test('deux serveurs distincts donnent deux bases distinctes', () => {
    assert.notEqual(databaseFileName('https://chat.barrut.me'), databaseFileName('http://192.168.1.106:3000'));
  });

  test('le schéma et la barre finale ne changent pas la base', () => {
    assert.equal(databaseFileName('https://chat.barrut.me'), databaseFileName('http://chat.barrut.me/'));
  });

  test('le port fait partie de l’identité du serveur', () => {
    assert.notEqual(databaseFileName('http://x:3000'), databaseFileName('http://x:3001'));
  });

  test('le nom ne contient que des caractères sûrs pour un fichier', () => {
    assert.match(databaseFileName('https://héberge.me:3000/chat'), /^[a-z0-9_.-]+$/i);
    assert.match(databaseFileName('https://héberge.me:3000/chat', 'u/../x'), /^[a-z0-9_.-]+$/i);
  });

  test('deux comptes du même serveur donnent deux bases distinctes', () => {
    // Salons, aperçus et non-lus sont des données du compte : les partager
    // ferait voir à un compte les messages directs du précédent.
    assert.notEqual(databaseFileName('http://x:3000', 'uid-alice'), databaseFileName('http://x:3000', 'uid-bob'));
    assert.notEqual(databaseFileName('http://x:3000', 'uid-alice'), databaseFileName('http://x:3000'));
  });

  test('le même compte retrouve la même base', () => {
    assert.equal(databaseFileName('http://x:3000/', 'u1'), databaseFileName('https://x:3000', 'u1'));
  });
});
