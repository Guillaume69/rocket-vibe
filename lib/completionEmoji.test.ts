import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  appliquerCompletion,
  completerEmoji,
  detecterJetonEmoji,
} from './completionEmoji.ts';

describe('detecterJetonEmoji', () => {
  test('repère le jeton ouvert juste avant le curseur', () => {
    assert.deepEqual(detecterJetonEmoji('bonjour :sm', 11), { debut: 8, requete: 'sm' });
  });

  test('minuscule la requête, garde le début intact', () => {
    assert.deepEqual(detecterJetonEmoji('a :SMi', 6), { debut: 2, requete: 'smi' });
  });

  test('déclenche en début de champ', () => {
    assert.deepEqual(detecterJetonEmoji(':te', 3), { debut: 0, requete: 'te' });
  });

  test('déclenche dès la première lettre', () => {
    assert.deepEqual(detecterJetonEmoji(':t', 2), { debut: 0, requete: 't' });
  });

  test('le `:` seul (aucune lettre) ne déclenche pas', () => {
    assert.equal(detecterJetonEmoji(':', 1), null);
  });

  test('un jeton déjà fermé ne déclenche pas', () => {
    assert.equal(detecterJetonEmoji(':smile:', 7), null);
  });

  test('reprend sur le SECOND jeton, pas le premier fermé', () => {
    assert.deepEqual(detecterJetonEmoji(':smile: :par', 12), { debut: 8, requete: 'par' });
  });

  test('ignore le `:` d’une URL (précédé d’une lettre)', () => {
    assert.equal(detecterJetonEmoji('voir http://ex', 14), null);
  });

  test('ignore le `:` d’une heure (précédé d’un chiffre)', () => {
    assert.equal(detecterJetonEmoji('rdv 12:34', 9), null);
  });

  test('une espace ferme le jeton', () => {
    assert.equal(detecterJetonEmoji('salut :sm ', 10), null);
  });

  test('le curseur au MILIEU borne la requête', () => {
    // Curseur après « sm », le « ile » qui suit n'en fait pas partie.
    assert.deepEqual(detecterJetonEmoji(':smile', 3), { debut: 0, requete: 'sm' });
  });

  test('déclenche après une ponctuation non alphanumérique', () => {
    assert.deepEqual(detecterJetonEmoji('(:sm', 4), { debut: 1, requete: 'sm' });
  });

  test('ignore le `:` collé à une lettre ACCENTUÉE (mot français)', () => {
    // `résumé` fait 6 caractères, le `:` est précédé de `é` : pas d'ouverture.
    assert.equal(detecterJetonEmoji('résumé:tl', 9), null);
    assert.equal(detecterJetonEmoji('Café:im', 7), null);
  });

  test('sans deux-points, rien', () => {
    assert.equal(detecterJetonEmoji('coucou', 6), null);
  });
});

describe('completerEmoji', () => {
  const STD = ['smile', 'smiley', 'sad', 'unsmiley', 'test', 'tetard'];
  const CUST = ['smirk_cat', 'party_parrot'];

  test('classe préfixe avant sous-chaîne, custom avant standard', () => {
    // `sm` : préfixe custom (smirk_cat), puis préfixes standard (smile<smiley),
    // puis sous-chaîne standard (unsmiley). `sad`/`test`/`tetard` ne matchent pas.
    assert.deepEqual(
      completerEmoji('sm', STD, CUST).map((s) => s.code),
      ['smirk_cat', 'smile', 'smiley', 'unsmiley'],
    );
  });

  test('la correspondance exacte passe devant un préfixe plus long', () => {
    assert.equal(completerEmoji('smile', STD, CUST)[0]?.code, 'smile');
  });

  test('un custom homonyme d’un standard est écarté (le glyphe gagne)', () => {
    const r = completerEmoji('smile', ['smile'], ['smile']);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.type, 'standard');
  });

  test('un custom au nom en MAJUSCULE matche une requête minuscule', () => {
    // Le serveur peut nommer un custom `PartyBlob` ; `:party` doit le trouver,
    // et le code ORIGINAL est conservé (l'URL de l'image se bâtit dessus).
    const r = completerEmoji('party', [], ['PartyBlob']);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], { code: 'PartyBlob', type: 'custom' });
  });

  test('un custom homonyme d’un standard, à la casse près, est écarté', () => {
    const r = completerEmoji('smile', ['smile'], ['Smile']);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.type, 'standard');
  });

  test('respecte le plafond', () => {
    const beaucoup = Array.from({ length: 100 }, (_, i) => `test${i}`);
    assert.equal(completerEmoji('test', beaucoup, [], 5).length, 5);
  });

  test('une seule lettre suffit désormais à classer', () => {
    // `s` : préfixe custom (smirk_cat), préfixes standard (sad<smile<smiley),
    // puis sous-chaînes standard, la plus courte d'abord (test<unsmiley).
    assert.deepEqual(
      completerEmoji('s', STD, CUST).map((s) => s.code),
      ['smirk_cat', 'sad', 'smile', 'smiley', 'test', 'unsmiley'],
    );
  });

  test('requête vide, liste vide', () => {
    assert.deepEqual(completerEmoji('', STD, CUST), []);
  });

  test('aucune correspondance, liste vide', () => {
    assert.deepEqual(completerEmoji('zzz', STD, CUST), []);
  });
});

describe('appliquerCompletion', () => {
  test('remplace le jeton, curseur après, espace ajoutée en fin', () => {
    // « hi :sm » → insérer 😄 → « hi 😄 », curseur en bout.
    const r = appliquerCompletion('hi :sm', 3, 6, '😄');
    assert.equal(r.texte, 'hi 😄 ');
    assert.equal(r.curseur, r.texte.length);
  });

  test('au milieu, ne double pas l’espace qui suit', () => {
    const r = appliquerCompletion('a :sm b', 2, 5, ':smile:');
    assert.equal(r.texte, 'a :smile: b');
    // Curseur pile après « :smile: », avant l'espace existante.
    assert.equal(r.curseur, 'a :smile:'.length);
  });

  test('insère un code court custom tel quel', () => {
    const r = appliquerCompletion(':par', 0, 4, ':party_parrot:');
    assert.equal(r.texte, ':party_parrot: ');
    assert.equal(r.curseur, ':party_parrot: '.length);
  });
});
