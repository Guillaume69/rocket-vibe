import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { clearMediaSession, isMediaLeaseCurrent, knownUserId, mediaHeaders, mediaLease, mediaSource, rememberUserId, requiresMediaBearer, setMediaBearer } from './mediaAuth.ts';

describe('mediaAuth', () => {
  test('logout removes the bearer and usernames without revoking a replacement', () => {
    const origin = 'https://logout.example';
    setMediaBearer(origin, 'old', 'alice');
    const old = mediaLease(origin)!;
    rememberUserId(origin, 'bob', 'old-bob', 'old');
    setMediaBearer(origin, 'new', 'carol');
    assert.equal(isMediaLeaseCurrent(old), false);
    assert.equal(knownUserId(origin, 'bob'), null);
    rememberUserId(origin, 'bob', 'stale-bob', 'old');
    assert.equal(knownUserId(origin, 'bob'), null);
    clearMediaSession(origin, 'alice', 'old');
    assert.deepEqual(mediaHeaders(`${origin}/file`), { Authorization: 'Bearer new' });
    clearMediaSession(origin, 'carol', 'new');
    assert.equal(mediaHeaders(`${origin}/file`), undefined);
    assert.equal(requiresMediaBearer(`${origin}/file`), true);
  });

  test('leaving one server preserves another server media session', () => {
    setMediaBearer('https://one.example', 'one', 'me');
    setMediaBearer('https://two.example', 'two', 'me');
    clearMediaSession('https://one.example', 'me', 'one');
    assert.equal(mediaHeaders('https://one.example/file'), undefined);
    assert.deepEqual(mediaHeaders('https://two.example/file'), { Authorization: 'Bearer two' });
  });
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
