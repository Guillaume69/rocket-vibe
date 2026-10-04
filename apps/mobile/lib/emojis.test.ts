import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { unicodeDeCodeCourt } from './emojis.ts';
import { CODES_EMOJI } from './emojis.generated.ts';

describe('unicodeDeCodeCourt', () => {
  test('résout les codes courts usuels', () => {
    assert.equal(unicodeDeCodeCourt('smile'), '😄');
    assert.equal(unicodeDeCodeCourt('tada'), '🎉');
    assert.equal(unicodeDeCodeCourt('rocket'), '🚀');
  });

  test('résout les alias, dont `+1` — celui de la barre de réactions', () => {
    assert.equal(unicodeDeCodeCourt('+1'), '👍');
    assert.equal(unicodeDeCodeCourt('thumbsup'), unicodeDeCodeCourt('+1'));
  });

  test('`:heart:` porte son sélecteur de variante, sinon la police le rend en NOIR', () => {
    assert.equal(unicodeDeCodeCourt('heart'), '❤️');
  });

  test('les teintes de peau sont des codes à part entière', () => {
    // Elles ne se DÉRIVENT pas : dans une séquence ZWJ le modificateur
    // s'insère derrière le personnage, pas à la fin (`🧑🏻‍🎨`, pas `🧑‍🎨🏻`).
    assert.equal(unicodeDeCodeCourt('thumbsup_tone2'), '👍🏼');
    assert.equal(unicodeDeCodeCourt('artist_tone1'), '🧑🏻‍🎨');
  });

  test('un code inconnu vaut `null` — c’est ainsi qu’on sait que ce n’est pas un emoji', () => {
    assert.equal(unicodeDeCodeCourt('pas_un_emoji_du_tout'), null);
    assert.equal(unicodeDeCodeCourt(''), null);
    // Un emoji personnalisé du serveur : inconnu de la table, et c'est voulu.
    assert.equal(unicodeDeCodeCourt('shipit'), null);
  });

  test('les membres du prototype d’Object ne remontent pas', () => {
    // `:constructor:` est un code court légal pour le parseur du serveur.
    assert.equal(unicodeDeCodeCourt('constructor'), null);
    assert.equal(unicodeDeCodeCourt('__proto__'), null);
    assert.equal(unicodeDeCodeCourt('toString'), null);
  });
});

describe('la table générée', () => {
  test('reste ASCII pure — sinon Hermes double son poids dans le bundle', () => {
    assert.match(CODES_EMOJI, /^[\x00-\x7f]*$/);
  });

  test('les 6222 entrées se décodent toutes en un glyphe non vide', () => {
    // `String.fromCodePoint` lève sur un point de code invalide : un artefact
    // de génération corrompu doit tomber ICI, pas dans le rendu d'un message.
    const codes = Object.keys(JSON.parse(CODES_EMOJI) as Record<string, string>);
    assert.equal(codes.length, 6222);
    for (const code of codes) {
      const glyphe = unicodeDeCodeCourt(code);
      assert.ok(
        glyphe !== null && glyphe.length > 0,
        `le code court « ${code} » ne se décode pas`,
      );
    }
  });
});
