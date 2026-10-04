import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { detectVideoLinks, isVideoLink, idVideo } from './videoLinks.ts';

const ID = 'dQw4w9WgXcQ';

describe('detecterLiensVideo', () => {
  test('reconnaît les formes YouTube usuelles', () => {
    for (const texte of [
      `https://www.youtube.com/watch?v=${ID}`,
      `regarde https://youtu.be/${ID} stp`,
      `youtube.com/shorts/${ID}`,
      `https://m.youtube.com/watch?feature=share&v=${ID}`,
      `(https://www.youtube.com/watch?v=${ID})`,
    ]) {
      const r = detectVideoLinks(texte);
      assert.equal(r.length, 1, texte);
      assert.equal(r[0]!.id, ID, texte);
      assert.equal(r[0]!.url, `https://www.youtube.com/watch?v=${ID}`);
    }
  });

  test('exige une frontière : pas de carte au milieu d’un mot ni dans une adresse', () => {
    // Rocket.Chat ne les tient pas pour des liens non plus (`urls` vide) : une
    // carte ici serait une carte sans titre, sur un lien qui n'existe pas.
    for (const texte of [
      `notyoutube.com/watch?v=${ID}`,
      `blahyoutu.be/${ID}`,
      `ecris-moi@youtube.com/watch?v=${ID}`,
      `pasvimeo.com/12345`,
    ]) {
      assert.deepEqual(detectVideoLinks(texte), [], texte);
    }
  });

  test('déduplique et plafonne', () => {
    assert.equal(detectVideoLinks(`https://youtu.be/${ID} et https://youtu.be/${ID}`).length, 1);
    const trois = `https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb https://youtu.be/ccccccccccc https://youtu.be/ddddddddddd`;
    assert.equal(detectVideoLinks(trois).length, 3);
  });

  test('texte vide ou nul → []', () => {
    assert.deepEqual(detectVideoLinks(null), []);
    assert.deepEqual(detectVideoLinks(''), []);
  });
});

describe('idVideo / estLienVideo', () => {
  test('rend l’identifiant d’une URL brute, playlist et utm compris', () => {
    assert.equal(idVideo(`https://www.youtube.com/watch?v=${ID}&list=PL1&utm_source=x`), ID);
    assert.equal(idVideo('https://vimeo.com/76979871'), '76979871');
  });

  test('null hors vidéo', () => {
    assert.equal(idVideo('https://ex.com/article'), null);
    assert.equal(isVideoLink('https://ex.com/article'), false);
    assert.equal(isVideoLink(`https://youtu.be/${ID}`), true);
  });
});
