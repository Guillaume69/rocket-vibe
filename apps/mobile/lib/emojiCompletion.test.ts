import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyCompletion,
  completeEmoji,
  detectEmojiToken,
} from './emojiCompletion.ts';

describe('detecterJetonEmoji', () => {
  test('repère le jeton ouvert juste avant le curseur', () => {
    assert.deepEqual(detectEmojiToken('bonjour :sm', 11), { start: 8, query: 'sm' });
  });

  test('minuscule la requête, garde le début intact', () => {
    assert.deepEqual(detectEmojiToken('a :SMi', 6), { start: 2, query: 'smi' });
  });

  test('déclenche en début de champ', () => {
    assert.deepEqual(detectEmojiToken(':te', 3), { start: 0, query: 'te' });
  });

  test('déclenche dès la première lettre', () => {
    assert.deepEqual(detectEmojiToken(':t', 2), { start: 0, query: 't' });
  });

  test('le `:` seul (aucune lettre) ne déclenche pas', () => {
    assert.equal(detectEmojiToken(':', 1), null);
  });

  test('un jeton déjà fermé ne déclenche pas', () => {
    assert.equal(detectEmojiToken(':smile:', 7), null);
  });

  test('reprend sur le SECOND jeton, pas le premier fermé', () => {
    assert.deepEqual(detectEmojiToken(':smile: :par', 12), { start: 8, query: 'par' });
  });

  test('ignore le `:` d’une URL (précédé d’une lettre)', () => {
    assert.equal(detectEmojiToken('voir http://ex', 14), null);
  });

  test('ignore le `:` d’une heure (précédé d’un chiffre)', () => {
    assert.equal(detectEmojiToken('rdv 12:34', 9), null);
  });

  test('une espace ferme le jeton', () => {
    assert.equal(detectEmojiToken('salut :sm ', 10), null);
  });

  test('le curseur au MILIEU borne la requête', () => {
    // Curseur après « sm », le « ile » qui suit n'en fait pas partie.
    assert.deepEqual(detectEmojiToken(':smile', 3), { start: 0, query: 'sm' });
  });

  test('déclenche après une ponctuation non alphanumérique', () => {
    assert.deepEqual(detectEmojiToken('(:sm', 4), { start: 1, query: 'sm' });
  });

  test('ignore le `:` collé à une lettre ACCENTUÉE (mot français)', () => {
    // `résumé` fait 6 caractères, le `:` est précédé de `é` : pas d'ouverture.
    assert.equal(detectEmojiToken('résumé:tl', 9), null);
    assert.equal(detectEmojiToken('Café:im', 7), null);
  });

  test('sans deux-points, rien', () => {
    assert.equal(detectEmojiToken('coucou', 6), null);
  });
});

describe('completerEmoji', () => {
  const STD = ['smile', 'smiley', 'sad', 'unsmiley', 'test', 'tetard'];
  const CUST = ['smirk_cat', 'party_parrot'];

  test('classe préfixe avant sous-chaîne, custom avant standard', () => {
    // `sm` : préfixe custom (smirk_cat), puis préfixes standard (smile<smiley),
    // puis sous-chaîne standard (unsmiley). `sad`/`test`/`tetard` ne matchent pas.
    assert.deepEqual(
      completeEmoji('sm', STD, CUST).map((s) => s.code),
      ['smirk_cat', 'smile', 'smiley', 'unsmiley'],
    );
  });

  test('la correspondance exacte passe devant un préfixe plus long', () => {
    assert.equal(completeEmoji('smile', STD, CUST)[0]?.code, 'smile');
  });

  test('un custom homonyme d’un standard est écarté (le glyphe gagne)', () => {
    const r = completeEmoji('smile', ['smile'], ['smile']);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.type, 'standard');
  });

  test('un custom au nom en MAJUSCULE matche une requête minuscule', () => {
    // Le serveur peut nommer un custom `PartyBlob` ; `:party` doit le trouver,
    // et le code ORIGINAL est conservé (l'URL de l'image se bâtit dessus).
    const r = completeEmoji('party', [], ['PartyBlob']);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], { code: 'PartyBlob', type: 'custom' });
  });

  test('un custom homonyme d’un standard, à la casse près, est écarté', () => {
    const r = completeEmoji('smile', ['smile'], ['Smile']);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.type, 'standard');
  });

  test('respecte le plafond', () => {
    const beaucoup = Array.from({ length: 100 }, (_, i) => `test${i}`);
    assert.equal(completeEmoji('test', beaucoup, [], 5).length, 5);
  });

  test('une seule lettre suffit désormais à classer', () => {
    // `s` : préfixe custom (smirk_cat), préfixes standard (sad<smile<smiley),
    // puis sous-chaînes standard, la plus courte d'abord (test<unsmiley).
    assert.deepEqual(
      completeEmoji('s', STD, CUST).map((s) => s.code),
      ['smirk_cat', 'sad', 'smile', 'smiley', 'test', 'unsmiley'],
    );
  });

  test('requête vide, liste vide', () => {
    assert.deepEqual(completeEmoji('', STD, CUST), []);
  });

  test('aucune correspondance, liste vide', () => {
    assert.deepEqual(completeEmoji('zzz', STD, CUST), []);
  });
});

describe('appliquerCompletion', () => {
  test('remplace le jeton, curseur après, espace ajoutée en fin', () => {
    // « hi :sm » → insérer 😄 → « hi 😄 », curseur en bout.
    const r = applyCompletion('hi :sm', 3, 6, '😄');
    assert.equal(r.text, 'hi 😄 ');
    assert.equal(r.cursor, r.text.length);
  });

  test('au milieu, ne double pas l’espace qui suit', () => {
    const r = applyCompletion('a :sm b', 2, 5, ':smile:');
    assert.equal(r.text, 'a :smile: b');
    // Curseur pile après « :smile: », avant l'espace existante.
    assert.equal(r.cursor, 'a :smile:'.length);
  });

  test('insère un code court custom tel quel', () => {
    const r = applyCompletion(':par', 0, 4, ':party_parrot:');
    assert.equal(r.text, ':party_parrot: ');
    assert.equal(r.cursor, ':party_parrot: '.length);
  });
});
