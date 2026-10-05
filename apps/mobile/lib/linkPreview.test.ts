import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { linkPreviews, videoMetas } from './linkPreview.ts';

// Fixtures modeled on real `chat.getMessage` output (RC 8.5).
const IMAGE = {
  url: 'https://www.gstatic.com/webp/gallery/1.png',
  meta: {},
  headers: { contentLength: '375229', contentType: 'image/png' },
};
const ARTICLE = {
  url: 'https://github.com/RocketChat/Rocket.Chat',
  meta: {
    pageTitle: 'GitHub - RocketChat/Rocket.Chat',
    description: 'The Secure CommsOS',
    ogImage: 'https://opengraph.githubassets.com/abc/RocketChat/Rocket.Chat',
    ogSiteName: 'GitHub',
    ogTitle: 'GitHub - RocketChat/Rocket.Chat: mission-critical',
    ogDescription: 'The Secure CommsOS for mission-critical operations',
  },
  headers: { contentType: 'text/html; charset=utf-8' },
};
const YOUTUBE = {
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  meta: {
    oembedTitle: 'Rick Astley - Never Gonna Give You Up',
    oembedThumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    oembedProviderName: 'YouTube',
    oembedHtml: '<iframe src="…"></iframe>',
  },
  headers: { contentType: 'application/json' },
};
// LIVE tweet: X serves normal og tags (observed on x.com).
const LIVE_TWEET = {
  url: 'https://x.com/BarackObama/status/266031293945503744',
  meta: {
    ogSiteName: 'X (formerly Twitter)',
    ogTitle: 'Barack Obama (@BarackObama) on X',
    ogDescription: 'Four more years.',
    ogImage: 'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg:large',
  },
  headers: { contentType: 'text/html; charset=utf-8' },
};
// Bare link: deleted tweet (404) or page without tags → empty metas.
const BARE_LINK = { url: 'https://x.com/who/status/000', meta: {} };

const json = (arr: unknown[]) => JSON.stringify(arr);

describe('linkPreviews', () => {
  test('an image link (content-type image/*) becomes an image preview', () => {
    const r = linkPreviews(json([IMAGE]));
    assert.deepEqual(r, [{ type: 'image', url: IMAGE.url }]);
  });

  test('an image link without headers is recognized by its extension', () => {
    const r = linkPreviews(json([{ url: 'https://ex.com/chat.jpg', meta: {} }]));
    assert.deepEqual(r, [{ type: 'image', url: 'https://ex.com/chat.jpg' }]);
  });

  test("the image extension tolerates a query and a fragment", () => {
    const r = linkPreviews(json([{ url: 'https://ex.com/p.png?v=2#x', meta: {} }]));
    assert.equal(r.length, 1);
    assert.equal(r[0]!.type, 'image');
  });

  test('a non-web link becomes NOTHING: neither image nor card', () => {
    // `message.urls` is stored raw: without this filter, `file:///…jpg`
    // showed in the timeline (reading the app's disk) and `javascript:`
    // became tappable, while markdown kept its guard.
    for (const u of [
      'file:///data/data/com.rocketvibe.app/files/x.jpg',
      'javascript:alert(1)',
      'intent://scan#Intent;scheme=zxing;end',
      'data:image/png;base64,iVBORw0KGgo=',
      'content://media/external/images/1',
    ]) {
      assert.deepEqual(linkPreviews(json([{ url: u, meta: { ogTitle: 'Trap' } }])), [], u);
    }
  });

  test('a non-web thumbnail is removed, the card stays', () => {
    const r = linkPreviews(
      json([{ url: 'https://ex.com/a', meta: { ogTitle: 'Title', ogImage: 'file:///etc/x.png' } }]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0]!.type === 'card' ? r[0]!.image : 'absent', null);
  });

  test('an untitled card whose thumbnail is removed disappears', () => {
    const r = linkPreviews(json([{ url: 'https://ex.com/a', meta: { ogImage: 'file:///x.png' } }]));
    assert.deepEqual(r, []);
  });

  test('an SVG is NOT treated as an image (RN Image does not render it)', () => {
    const svg = { url: 'https://ex.com/logo.svg', meta: {}, headers: { contentType: 'image/svg+xml' } };
    assert.deepEqual(linkPreviews(json([svg])), []);
  });

  test('an OpenGraph article becomes a card, og taking precedence over pageTitle', () => {
    const r = linkPreviews(json([ARTICLE]));
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], {
      type: 'card',
      url: ARTICLE.url,
      title: 'GitHub - RocketChat/Rocket.Chat: mission-critical',
      description: 'The Secure CommsOS for mission-critical operations',
      image: ARTICLE.meta.ogImage,
      site: 'GitHub',
    });
  });

  test('falls back on twitter tags when og is missing', () => {
    const tw = {
      url: 'https://ex.com/a',
      meta: {
        twitterTitle: 'TW title',
        twitterImage: 'https://ex.com/tw.jpg',
        twitterDescription: 'desc tw',
      },
      headers: { contentType: 'text/html' },
    };
    const r = linkPreviews(json([tw]));
    assert.equal(r[0]!.type, 'card');
    assert.equal((r[0] as { title: string }).title, 'TW title');
    assert.equal((r[0] as { image: string }).image, 'https://ex.com/tw.jpg');
  });

  test("the site name falls back on the host (without www) if missing from metas", () => {
    const a = { url: 'https://www.lemonde.fr/article', meta: { ogTitle: 'T' }, headers: { contentType: 'text/html' } };
    const r = linkPreviews(json([a]));
    assert.equal((r[0] as { site: string }).site, 'lemonde.fr');
  });

  test('a video link (YouTube) is EXCLUDED: it already has its dedicated card', () => {
    assert.deepEqual(linkPreviews(json([YOUTUBE])), []);
  });

  test('a LIVE tweet yields a card with image AND text (generic og)', () => {
    const r = linkPreviews(json([LIVE_TWEET]));
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], {
      type: 'card',
      url: LIVE_TWEET.url,
      title: 'Barack Obama (@BarackObama) on X',
      description: 'Four more years.',
      image: LIVE_TWEET.meta.ogImage,
      site: 'X (formerly Twitter)',
    });
  });

  test('a bare link (deleted tweet, page without tags) is ignored', () => {
    assert.deepEqual(linkPreviews(json([BARE_LINK])), []);
  });

  test('realistic mix: image + article + tweet, video and bare link skipped', () => {
    const r = linkPreviews(json([IMAGE, ARTICLE, YOUTUBE, LIVE_TWEET, BARE_LINK]));
    assert.deepEqual(
      r.map((a) => a.type),
      ['image', 'card', 'card'],
    );
  });

  test('dedupes by URL', () => {
    const r = linkPreviews(json([IMAGE, IMAGE]));
    assert.equal(r.length, 1);
  });

  test('caps at the requested maximum', () => {
    const links = Array.from({ length: 5 }, (_, i) => ({
      url: `https://ex.com/${i}`,
      meta: { ogTitle: `T${i}` },
      headers: { contentType: 'text/html' },
    }));
    assert.equal(linkPreviews(json(links), 3).length, 3);
  });

  test('decodes HTML entities in metas', () => {
    const a = {
      url: 'https://ex.com/x',
      meta: { ogTitle: 'Tom &amp; Jerry &#39;96&#39;', ogImage: 'https://ex.com/i.jpg' },
      headers: { contentType: 'text/html' },
    };
    const r = linkPreviews(json([a]));
    assert.equal((r[0] as { title: string }).title, "Tom & Jerry '96'");
  });

  test('invalid input: null, broken JSON, non-array → []', () => {
    assert.deepEqual(linkPreviews(null), []);
    assert.deepEqual(linkPreviews(''), []);
    assert.deepEqual(linkPreviews('{not json'), []);
    assert.deepEqual(linkPreviews('{"a":1}'), []);
  });

  test('an entry without title or image (bare link) is ignored', () => {
    const bare = { url: 'https://ex.com/nu', meta: {}, headers: { contentType: 'text/html' } };
    assert.deepEqual(linkPreviews(json([bare])), []);
  });
});

describe('videoMetas', () => {
  // The server's raw URL carries playlist and `utm_*`: the id is what matches.
  const YT = {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&utm_source=x',
    meta: {
      oembedTitle: 'Rick Astley - Never Gonna Give You Up',
      oembedAuthorName: 'Rick Astley &amp; co',
      oembedThumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    },
  };

  test('indexes title and author by video id, entities decoded', () => {
    const m = videoMetas(json([YT]));
    assert.deepEqual(m.get('dQw4w9WgXcQ'), {
      title: 'Rick Astley - Never Gonna Give You Up',
      author: 'Rick Astley & co',
    });
  });

  test('ignores non-videos, and videos without meta', () => {
    const bare = { url: 'https://youtu.be/aaaaaaaaaaa', meta: {} };
    const m = videoMetas(json([ARTICLE, bare]));
    assert.equal(m.size, 0);
  });

  test('invalid input → empty map', () => {
    assert.equal(videoMetas(null).size, 0);
    assert.equal(videoMetas('{not json').size, 0);
  });
});
