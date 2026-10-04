import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isWebLink, canLeaveProcess, carriesCredentials } from './externalLink.ts';

describe('isWebLink', () => {
  test('http and https, whatever the case', () => {
    assert.equal(isWebLink('https://example.org/a'), true);
    assert.equal(isWebLink('HTTP://example.org'), true);
  });

  test('any other scheme is refused', () => {
    for (const u of [
      'javascript:alert(1)',
      'intent://scan#Intent;scheme=zxing;end',
      'file:///data/data/com.rocketvibe.app/databases/x.db',
      'content://media/external/images/1',
      'data:text/html,<script>x</script>',
      'rocketvibe://room/abc',
      '//example.org/a',
      ' https://example.org',
    ]) {
      assert.equal(isWebLink(u), false, u);
    }
  });

  test('anything that is not a string is refused', () => {
    for (const v of [null, undefined, 42, {}, ['https://x']]) {
      assert.equal(isWebLink(v), false, JSON.stringify(v));
    }
  });
});

describe('carriesCredentials', () => {
  test('recognises our two parameters, wherever they are in the query', () => {
    assert.equal(carriesCredentials('https://h/f?rc_uid=u&rc_token=t'), true);
    assert.equal(carriesCredentials('https://h/f?etag=1&rc_token=t'), true);
    assert.equal(carriesCredentials('https://h/f?RC_TOKEN=t'), true);
  });

  test('an ordinary URL carries none', () => {
    assert.equal(carriesCredentials('https://h/f?etag=abc'), false);
    assert.equal(carriesCredentials('https://github.com/RocketChat/Rocket.Chat'), false);
  });
});

describe('canLeaveProcess', () => {
  test('an ordinary web link may leave', () => {
    assert.equal(canLeaveProcess('https://github.com/RocketChat/Rocket.Chat'), true);
  });

  test('NO URL carrying the token leaves, the invariant of this workstream', () => {
    // The exact form `protectedFileUrl` produced before the fix: it went into a
    // VIEW intent, hence into Chrome and its history.
    const leak =
      'https://chat.barrut.me/file-upload/BsN3iJ/report.pdf?rc_uid=uid-alice&rc_token=token-alice';
    assert.equal(isWebLink(leak), true, 'it is indeed web...');
    assert.equal(canLeaveProcess(leak), false, '...and yet it does not leave');
  });

  test('a non-web scheme does not leave either', () => {
    assert.equal(canLeaveProcess('file:///sdcard/x.pdf'), false);
  });
});
