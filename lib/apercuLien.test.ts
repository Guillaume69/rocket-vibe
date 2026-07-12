import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { apercusDeLien } from './apercuLien.ts';

// Fixtures calquées sur le relevé réel de `chat.getMessage` (RC 8.5).
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
// Tweet VIVANT : X sert des balises og normales (relevé réel sur x.com).
const TWEET_VIVANT = {
  url: 'https://x.com/BarackObama/status/266031293945503744',
  meta: {
    ogSiteName: 'X (formerly Twitter)',
    ogTitle: 'Barack Obama (@BarackObama) on X',
    ogDescription: 'Four more years.',
    ogImage: 'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg:large',
  },
  headers: { contentType: 'text/html; charset=utf-8' },
};
// Lien nu : tweet supprimé (404) ou page sans balises → métas vides.
const LIEN_NU = { url: 'https://x.com/qui/status/000', meta: {} };

const json = (arr: unknown[]) => JSON.stringify(arr);

describe('apercusDeLien', () => {
  test('un lien image (content-type image/*) devient un aperçu image', () => {
    const r = apercusDeLien(json([IMAGE]));
    assert.deepEqual(r, [{ type: 'image', url: IMAGE.url }]);
  });

  test('un lien image sans headers est reconnu par son extension', () => {
    const r = apercusDeLien(json([{ url: 'https://ex.com/chat.jpg', meta: {} }]));
    assert.deepEqual(r, [{ type: 'image', url: 'https://ex.com/chat.jpg' }]);
  });

  test("l'extension image tolère une query et un fragment", () => {
    const r = apercusDeLien(json([{ url: 'https://ex.com/p.png?v=2#x', meta: {} }]));
    assert.equal(r.length, 1);
    assert.equal(r[0]!.type, 'image');
  });

  test('un SVG n’est PAS traité comme image (Image RN ne le rend pas)', () => {
    const svg = { url: 'https://ex.com/logo.svg', meta: {}, headers: { contentType: 'image/svg+xml' } };
    assert.deepEqual(apercusDeLien(json([svg])), []);
  });

  test('un article OpenGraph devient une carte, og prioritaire sur pageTitle', () => {
    const r = apercusDeLien(json([ARTICLE]));
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], {
      type: 'carte',
      url: ARTICLE.url,
      titre: 'GitHub - RocketChat/Rocket.Chat: mission-critical',
      description: 'The Secure CommsOS for mission-critical operations',
      image: ARTICLE.meta.ogImage,
      site: 'GitHub',
    });
  });

  test('repli sur les balises twitter quand og manque', () => {
    const tw = {
      url: 'https://ex.com/a',
      meta: {
        twitterTitle: 'Titre TW',
        twitterImage: 'https://ex.com/tw.jpg',
        twitterDescription: 'desc tw',
      },
      headers: { contentType: 'text/html' },
    };
    const r = apercusDeLien(json([tw]));
    assert.equal(r[0]!.type, 'carte');
    assert.equal((r[0] as { titre: string }).titre, 'Titre TW');
    assert.equal((r[0] as { image: string }).image, 'https://ex.com/tw.jpg');
  });

  test("le nom de site retombe sur l'hôte (sans www) si absent des métas", () => {
    const a = { url: 'https://www.lemonde.fr/article', meta: { ogTitle: 'T' }, headers: { contentType: 'text/html' } };
    const r = apercusDeLien(json([a]));
    assert.equal((r[0] as { site: string }).site, 'lemonde.fr');
  });

  test('un lien vidéo (YouTube) est EXCLU — il a déjà sa carte dédiée', () => {
    assert.deepEqual(apercusDeLien(json([YOUTUBE])), []);
  });

  test('un tweet VIVANT rend une carte avec image ET texte (og génériques)', () => {
    const r = apercusDeLien(json([TWEET_VIVANT]));
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], {
      type: 'carte',
      url: TWEET_VIVANT.url,
      titre: 'Barack Obama (@BarackObama) on X',
      description: 'Four more years.',
      image: TWEET_VIVANT.meta.ogImage,
      site: 'X (formerly Twitter)',
    });
  });

  test('un lien nu (tweet supprimé, page sans balises) est ignoré', () => {
    assert.deepEqual(apercusDeLien(json([LIEN_NU])), []);
  });

  test('mélange réaliste : image + article + tweet, la vidéo et le lien nu sautés', () => {
    const r = apercusDeLien(json([IMAGE, ARTICLE, YOUTUBE, TWEET_VIVANT, LIEN_NU]));
    assert.deepEqual(
      r.map((a) => a.type),
      ['image', 'carte', 'carte'],
    );
  });

  test('déduplique par URL', () => {
    const r = apercusDeLien(json([IMAGE, IMAGE]));
    assert.equal(r.length, 1);
  });

  test('plafonne au maximum demandé', () => {
    const liens = Array.from({ length: 5 }, (_, i) => ({
      url: `https://ex.com/${i}`,
      meta: { ogTitle: `T${i}` },
      headers: { contentType: 'text/html' },
    }));
    assert.equal(apercusDeLien(json(liens), 3).length, 3);
  });

  test('décode les entités HTML des métas', () => {
    const a = {
      url: 'https://ex.com/x',
      meta: { ogTitle: 'Tom &amp; Jerry &#39;96&#39;', ogImage: 'https://ex.com/i.jpg' },
      headers: { contentType: 'text/html' },
    };
    const r = apercusDeLien(json([a]));
    assert.equal((r[0] as { titre: string }).titre, "Tom & Jerry '96'");
  });

  test('entrées invalides : null, JSON cassé, non-tableau → []', () => {
    assert.deepEqual(apercusDeLien(null), []);
    assert.deepEqual(apercusDeLien(''), []);
    assert.deepEqual(apercusDeLien('{pas du json'), []);
    assert.deepEqual(apercusDeLien('{"a":1}'), []);
  });

  test('une entrée sans titre ni image (lien nu) est ignorée', () => {
    const nu = { url: 'https://ex.com/nu', meta: {}, headers: { contentType: 'text/html' } };
    assert.deepEqual(apercusDeLien(json([nu])), []);
  });
});
