import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { knownUserId, mediaHeaders, mediaSource, rememberUserId, setMediaBearer } from './mediaAuth.ts';

describe('mediaAuth', () => {
  test('the bearer goes with its own origin only', () => {
    setMediaBearer('https://mm.example.org', 'tok');
    assert.deepEqual(mediaHeaders('https://mm.example.org/api/v4/files/f1'), { Authorization: 'Bearer tok' });
    assert.equal(mediaHeaders('https://mm.example.org.evil.com/x'), undefined);
    assert.equal(mediaHeaders('https://evil.com/?u=https://mm.example.org'), undefined);
    assert.deepEqual(mediaSource('https://other.org/a.png'), { uri: 'https://other.org/a.png' });
    setMediaBearer('https://mm.example.org', null);
    assert.equal(mediaHeaders('https://mm.example.org/api/v4/files/f1'), undefined);
  });

  test('a username maps to its id per server', () => {
    rememberUserId('http://10.0.2.2:8065', 'bob', 'u-bob');
    assert.equal(knownUserId('http://10.0.2.2:8065/', 'bob'), 'u-bob');
    assert.equal(knownUserId('https://elsewhere.org', 'bob'), null);
  });
});
