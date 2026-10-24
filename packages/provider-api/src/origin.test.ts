import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sameOrigin, originOf } from './origin.ts';

describe('originOf', () => {
  test('scheme + authority, without the path', () => {
    assert.equal(originOf('https://chat.barrut.me/file-upload/abc/x.pdf'), 'https://chat.barrut.me');
    assert.equal(originOf('http://10.0.2.2:3300/api/v1/me'), 'http://10.0.2.2:3300');
  });

  test('the port is part of the origin', () => {
    assert.notEqual(originOf('http://h:3300/x'), originOf('http://h:3301/x'));
  });

  test('host case does not matter', () => {
    assert.equal(originOf('https://Chat.Barrut.ME/x'), originOf('https://chat.barrut.me/x'));
  });

  test('no path, with or without a trailing slash', () => {
    assert.equal(originOf('https://chat.barrut.me'), 'https://chat.barrut.me');
    assert.equal(originOf('https://chat.barrut.me/'), 'https://chat.barrut.me');
  });

  test('a query or fragment stuck to the host does not spill into the origin', () => {
    assert.equal(originOf('https://chat.barrut.me?x=1'), 'https://chat.barrut.me');
    assert.equal(originOf('https://chat.barrut.me#a'), 'https://chat.barrut.me');
  });

  test('anything that is not web returns null', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x', 'ftp://h/x', '', '/x']) {
      assert.equal(originOf(u), null, u);
    }
  });

  test('userinfo stays IN the authority, otherwise it would hide the real host', () => {
    // Classic trap: `https://chat.barrut.me@evil.com/x` is served by evil.com.
    // Reducing its origin to `https://chat.barrut.me` would allow the very leak
    // this closes.
    assert.equal(originOf('https://chat.barrut.me@evil.com/x'), 'https://chat.barrut.me@evil.com');
  });
});

describe('sameOrigin', () => {
  test('true on the same server, whatever the path and query', () => {
    assert.equal(sameOrigin('https://h/file-upload/a/b.pdf?rc_uid=1', 'https://h'), true);
    assert.equal(sameOrigin('https://h/x', 'https://h/api/v1/'), true);
  });

  test('a host ours is a PREFIX of is refused', () => {
    // `startsWith` would have said yes: that is the defect this module avoids.
    assert.equal(sameOrigin('https://h.evil.com/x', 'https://h'), false);
    assert.equal(sameOrigin('https://chat.barrut.me.evil.com/x', 'https://chat.barrut.me'), false);
  });

  test('scheme and port count', () => {
    assert.equal(sameOrigin('http://h/x', 'https://h'), false);
    assert.equal(sameOrigin('https://h:8443/x', 'https://h'), false);
  });

  test('a userinfo imitating our host is refused', () => {
    assert.equal(sameOrigin('https://chat.barrut.me@evil.com/x', 'https://chat.barrut.me'), false);
  });

  test('a non-web URL is never of our origin', () => {
    assert.equal(sameOrigin('javascript:alert(1)', 'https://h'), false);
    assert.equal(sameOrigin('about:blank', 'https://h'), false);
  });

  test('an unreadable reference origin validates nothing', () => {
    assert.equal(sameOrigin('https://h/x', 'not-a-url'), false);
  });
});
