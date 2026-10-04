import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { databaseFileName } from './fileName.ts';

describe('nomFichier', () => {
  test('deux serveurs distincts donnent deux bases distinctes', () => {
    assert.notEqual(databaseFileName('https://chat.barrut.me'), databaseFileName('http://192.168.1.106:3000'));
  });

  test('scheme and trailing slash do not change the database', () => {
    assert.equal(databaseFileName('https://chat.barrut.me'), databaseFileName('http://chat.barrut.me/'));
  });

  test('the port is part of the server\'s identity', () => {
    assert.notEqual(databaseFileName('http://x:3000'), databaseFileName('http://x:3001'));
  });

  test('the name only contains file-safe characters', () => {
    assert.match(databaseFileName('https://héberge.me:3000/chat'), /^[a-z0-9_.-]+$/i);
    assert.match(databaseFileName('https://héberge.me:3000/chat', 'u/../x'), /^[a-z0-9_.-]+$/i);
  });

  test('two accounts on the same server give two distinct databases', () => {
    // Rooms, previews and unread counts are account data: sharing them would
    // show one account the previous one's direct messages.
    assert.notEqual(databaseFileName('http://x:3000', 'uid-alice'), databaseFileName('http://x:3000', 'uid-bob'));
    assert.notEqual(databaseFileName('http://x:3000', 'uid-alice'), databaseFileName('http://x:3000'));
  });

  test('the same account finds the same database again', () => {
    assert.equal(databaseFileName('http://x:3000/', 'u1'), databaseFileName('https://x:3000', 'u1'));
  });
});
