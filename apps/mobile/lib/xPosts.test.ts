import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { detectXPosts, isXPostLink, splitXTitle, xImageKind, xPostId } from './xPosts.ts';

describe('detectXPosts', () => {
  test('x.com and twitter.com, with or without scheme and subdomain', () => {
    const r = detectXPosts(
      'a https://x.com/jack/status/20 b twitter.com/BarackObama/status/266031293945503744?s=20 ' +
        'c https://mobile.twitter.com/nasa/statuses/123/photo/1',
    );
    assert.deepEqual(r, [
      { id: '20', handle: 'jack', url: 'https://x.com/jack/status/20' },
      {
        id: '266031293945503744',
        handle: 'BarackObama',
        url: 'https://x.com/BarackObama/status/266031293945503744',
      },
      { id: '123', handle: 'nasa', url: 'https://x.com/nasa/status/123' },
    ]);
  });

  test('handle-less forms open the post by id', () => {
    assert.deepEqual(detectXPosts('https://x.com/i/web/status/42 and x.com/i/status/43'), [
      { id: '42', handle: null, url: 'https://x.com/i/status/42' },
      { id: '43', handle: null, url: 'https://x.com/i/status/43' },
    ]);
  });

  test('dedupes by post id and caps at max', () => {
    const text = 'x.com/a/status/1 twitter.com/a/status/1 x.com/b/status/2 x.com/c/status/3 x.com/d/status/4';
    assert.deepEqual(
      detectXPosts(text).map((p) => p.id),
      ['1', '2', '3'],
    );
  });

  test('a host boundary is required, and a profile is not a post', () => {
    for (const text of [
      'box.com/a/status/1',
      'me@x.com/a/status/1',
      'https://notx.com/a/status/1',
      'https://x.com/jack',
      'https://x.com/jack/status/12ab',
      '',
    ]) {
      assert.deepEqual(detectXPosts(text), [], text);
    }
    assert.deepEqual(detectXPosts(null), []);
  });

  test('a markdown link is found', () => {
    assert.equal(detectXPosts('[see](https://x.com/jack/status/20)')[0]?.id, '20');
  });
});

describe('xPostId', () => {
  test('reads the id of a server url, ignoring its query', () => {
    assert.equal(xPostId('https://twitter.com/jack/status/20?s=20&t=abc'), '20');
    assert.equal(xPostId('https://example.com/jack/status/20'), null);
    assert.equal(isXPostLink('https://x.com/jack/status/20'), true);
    assert.equal(isXPostLink('https://x.com/jack'), false);
  });
});

describe('xImageKind', () => {
  test('photo, video first image or author photo, from the path', () => {
    assert.equal(xImageKind('https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=webp&name=large'), 'photo');
    assert.equal(xImageKind('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg'), 'video');
    assert.equal(xImageKind('https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg'), 'video');
    assert.equal(xImageKind('https://pbs.twimg.com/tweet_video_thumb/a.jpg'), 'video');
    assert.equal(xImageKind('https://pbs.twimg.com/profile_images/1/a_400x400.jpg'), 'avatar');
    assert.equal(xImageKind('https://example.com/profile_images/a.jpg'), 'photo');
    assert.equal(xImageKind('not a url'), 'photo');
  });
});

describe('splitXTitle', () => {
  test('name and handle from X title, the whole title otherwise', () => {
    assert.deepEqual(splitXTitle('Barack Obama (@BarackObama) on X'), {
      name: 'Barack Obama',
      handle: 'BarackObama',
    });
    assert.deepEqual(splitXTitle('A (B) (@c_d) on Twitter'), { name: 'A (B)', handle: 'c_d' });
    assert.deepEqual(splitXTitle('Something else'), { name: 'Something else', handle: null });
  });
});
