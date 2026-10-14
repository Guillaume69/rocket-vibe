import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fetchXPost, parseSyndication, syndicationToken } from './xSyndication.ts';

// Cut from X's real `tweet-result` answers (probed 2026-10-14).
const PHOTO = {
  __typename: 'Tweet',
  text: 'Four more years. http://t.co/bAJE6Vom',
  display_text_range: [0, 37],
  entities: { urls: [] },
  user: {
    name: 'Barack Obama',
    screen_name: 'BarackObama',
    profile_image_url_https: 'https://pbs.twimg.com/profile_images/1329647526807543809/2SGvnHYV_normal.jpg',
  },
  mediaDetails: [{ type: 'photo', indices: [17, 37], media_url_https: 'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg' }],
  photos: [{ url: 'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg' }],
};
const VIDEO = {
  __typename: 'Tweet',
  text: 'Entering Twitter HQ – let that sink in! https://t.co/D68z4K2wq7',
  display_text_range: [0, 39],
  user: { name: 'Elon Musk', screen_name: 'elonmusk' },
  mediaDetails: [
    { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1585341912877146112/pu/img/DwJ7wlGIe9iryk6N.jpg' },
  ],
  video: { poster: 'https://pbs.twimg.com/ext_tw_video_thumb/1585341912877146112/pu/img/DwJ7wlGIe9iryk6N.jpg' },
};

describe('syndicationToken', () => {
  test("X widget's formula", () => {
    // Computed with the widget's own JavaScript; rv-core's tests share these.
    assert.equal(syndicationToken('20'), '6dq1a2xwd93');
    assert.equal(syndicationToken('266031293945503744'), 'n7rfhxzwhkd');
    assert.equal(syndicationToken('1585341984679469056'), '3uchycv2wqc');
  });
});

describe('parseSyndication', () => {
  test('a post with a picture: author, photo, text without its media link', () => {
    assert.deepEqual(parseSyndication(PHOTO), {
      name: 'Barack Obama',
      handle: 'BarackObama',
      text: 'Four more years.',
      image: 'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg',
      imageKind: 'photo',
      avatar: 'https://pbs.twimg.com/profile_images/1329647526807543809/2SGvnHYV_bigger.jpg',
    });
  });

  test('a video: its first image, marked as video', () => {
    const r = parseSyndication(VIDEO)!;
    assert.equal(r.text, 'Entering Twitter HQ – let that sink in!');
    assert.equal(r.imageKind, 'video');
    assert.equal(r.avatar, null);
  });

  test('display range counts code points of the ESCAPED text, links show expanded, entities decoded', () => {
    const r = parseSyndication({
      __typename: 'Tweet',
      text: '@bob 🚀 see https://t.co/abc &amp; more',
      display_text_range: [5, 38],
      entities: { urls: [{ url: 'https://t.co/abc', display_url: 'example.com/page', expanded_url: 'https://example.com/page' }] },
      user: { screen_name: 'alice' },
    })!;
    assert.equal(r.text, '🚀 see example.com/page & more');
    assert.equal(r.name, 'alice');
    assert.equal(r.image, null);
    assert.equal(r.imageKind, null);
  });

  test("X's real answer for a post with an ampersand (escaped indices, probed 2026-10-14)", () => {
    const r = parseSyndication({
      __typename: 'Tweet',
      text: 'To an exciting &amp; inspiring future! https://t.co/WUIqN7B2F6',
      display_text_range: [0, 38],
      user: { screen_name: 'a' },
      mediaDetails: [{ type: 'photo', indices: [39, 62], media_url_https: 'https://pbs.twimg.com/media/b.jpg' }],
    })!;
    assert.equal(r.text, 'To an exciting & inspiring future!');
  });

  test('fallbacks: photos[0], a poster without mediaDetails, an animated GIF', () => {
    const photo = parseSyndication({ __typename: 'Tweet', text: 'p', photos: [{ url: 'https://pbs.twimg.com/media/p.jpg' }] })!;
    assert.deepEqual([photo.image, photo.imageKind], ['https://pbs.twimg.com/media/p.jpg', 'photo']);
    const poster = parseSyndication({ __typename: 'Tweet', text: 'v', video: { poster: 'https://pbs.twimg.com/v.jpg' } })!;
    assert.deepEqual([poster.image, poster.imageKind], ['https://pbs.twimg.com/v.jpg', 'video']);
    const gif = parseSyndication({
      __typename: 'Tweet',
      text: 'g',
      mediaDetails: [{ type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/g.jpg' }],
    })!;
    assert.equal(gif.imageKind, 'video');
  });

  test('a tombstone, an empty answer or garbage is not a post', () => {
    assert.equal(parseSyndication({ __typename: 'TweetTombstone' }), null);
    assert.equal(parseSyndication({}), null);
    assert.equal(parseSyndication(null), null);
    assert.equal(parseSyndication('x'), null);
  });

  test('only https images are kept', () => {
    const r = parseSyndication({
      ...PHOTO,
      user: { ...PHOTO.user, profile_image_url_https: 'file:///etc/x.jpg' },
      mediaDetails: [{ type: 'photo', media_url_https: 'javascript:alert(1)' }],
      photos: [],
    })!;
    assert.equal(r.avatar, null);
    assert.equal(r.image, null);
  });
});

describe('fetchXPost', () => {
  test('one request per post, a 404 remembered, a failure retried only after a pause', async () => {
    const calls: string[] = [];
    const answers: (() => Response)[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return answers.shift()!();
    }) as typeof fetch;
    try {
      answers.push(() => new Response(JSON.stringify({ __typename: 'Tweet', text: 'hi', user: { screen_name: 'a' } })));
      const [a, b] = await Promise.all([fetchXPost('9001'), fetchXPost('9001')]);
      assert.equal(a?.text, 'hi');
      assert.equal(b, a);
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?id=9001&token=\w+&lang=en$/);

      answers.push(() => new Response('<html>', { status: 404 }));
      assert.equal(await fetchXPost('9002'), null);
      assert.equal(await fetchXPost('9002'), null);
      assert.equal(calls.length, 2);

      answers.push(() => new Response('', { status: 503 }));
      await assert.rejects(fetchXPost('9003', 1_000));
      await assert.rejects(fetchXPost('9003', 30_000));
      assert.equal(calls.length, 3, 'no new request within the pause');
      answers.push(() => new Response(JSON.stringify({ __typename: 'Tweet', text: 'back', user: {} })));
      assert.equal((await fetchXPost('9003', 62_000))?.text, 'back');
      assert.equal(calls.length, 4);
    } finally {
      globalThis.fetch = real;
    }
  });
});
