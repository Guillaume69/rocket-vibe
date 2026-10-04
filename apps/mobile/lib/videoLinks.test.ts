import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { detectVideoLinks, isVideoLink, idVideo } from './videoLinks.ts';

const ID = 'dQw4w9WgXcQ';

describe('detectVideoLinks', () => {
  test('recognizes the usual YouTube forms', () => {
    for (const text of [
      `https://www.youtube.com/watch?v=${ID}`,
      `regarde https://youtu.be/${ID} stp`,
      `youtube.com/shorts/${ID}`,
      `https://m.youtube.com/watch?feature=share&v=${ID}`,
      `(https://www.youtube.com/watch?v=${ID})`,
    ]) {
      const r = detectVideoLinks(text);
      assert.equal(r.length, 1, text);
      assert.equal(r[0]!.id, ID, text);
      assert.equal(r[0]!.url, `https://www.youtube.com/watch?v=${ID}`);
    }
  });

  test('requires a boundary: no card mid-word or inside an address', () => {
    // Rocket.Chat does not treat them as links either (empty `urls`): a card
    // here would be an untitled card on a link that does not exist.
    for (const text of [
      `notyoutube.com/watch?v=${ID}`,
      `blahyoutu.be/${ID}`,
      `ecris-moi@youtube.com/watch?v=${ID}`,
      `pasvimeo.com/12345`,
    ]) {
      assert.deepEqual(detectVideoLinks(text), [], text);
    }
  });

  test('dedupes and caps', () => {
    assert.equal(detectVideoLinks(`https://youtu.be/${ID} et https://youtu.be/${ID}`).length, 1);
    const three = `https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb https://youtu.be/ccccccccccc https://youtu.be/ddddddddddd`;
    assert.equal(detectVideoLinks(three).length, 3);
  });

  test('empty or null text → []', () => {
    assert.deepEqual(detectVideoLinks(null), []);
    assert.deepEqual(detectVideoLinks(''), []);
  });
});

describe('idVideo / isVideoLink', () => {
  test('returns the id from a raw URL, playlist and utm included', () => {
    assert.equal(idVideo(`https://www.youtube.com/watch?v=${ID}&list=PL1&utm_source=x`), ID);
    assert.equal(idVideo('https://vimeo.com/76979871'), '76979871');
  });

  test('null for non-video', () => {
    assert.equal(idVideo('https://ex.com/article'), null);
    assert.equal(isVideoLink('https://ex.com/article'), false);
    assert.equal(isVideoLink(`https://youtu.be/${ID}`), true);
  });
});
