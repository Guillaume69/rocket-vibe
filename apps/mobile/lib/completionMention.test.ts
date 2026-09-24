import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  completerMention,
  detecterJetonMention,
  type CandidatMention,
} from './completionMention.ts';

describe('detecterJetonMention', () => {
  test('repère le jeton ouvert juste avant le curseur', () => {
    assert.deepEqual(detecterJetonMention('salut @al', 9), { debut: 6, requete: 'al' });
  });

  test('le @ nu propose (requête vide)', () => {
    assert.deepEqual(detecterJetonMention('@', 1), { debut: 0, requete: '' });
  });

  test('minuscule la requête, garde le début intact', () => {
    assert.deepEqual(detecterJetonMention('@ALice', 6), { debut: 0, requete: 'alice' });
  });

  test('ne déclenche pas au milieu d’une adresse email', () => {
    assert.equal(detecterJetonMention('marc@barrut.me', 14), null);
  });

  test('une lettre accentuée avant le @ ferme aussi la porte', () => {
    assert.equal(detecterJetonMention('café@bar', 8), null);
  });

  test('une espace dans la requête ferme le jeton', () => {
    assert.equal(detecterJetonMention('@alice bonjour', 14), null);
  });

  test('le jeton est celui AVANT le curseur, pas la fin du texte', () => {
    assert.deepEqual(detecterJetonMention('@alice bonjour', 3), { debut: 0, requete: 'al' });
  });

  test('accepte points, tirets et underscores', () => {
    assert.deepEqual(detecterJetonMention('@jean.du_pont-2', 15), {
      debut: 0,
      requete: 'jean.du_pont-2',
    });
  });

  test('curseur hors bornes est ramené dans le texte', () => {
    assert.deepEqual(detecterJetonMention('@al', 99), { debut: 0, requete: 'al' });
  });
});

describe('completerMention', () => {
  const candidats: CandidatMention[] = [
    { username: 'bob', uid: 'u2' },
    { username: 'alice', uid: 'u1' },
    { username: 'ali', uid: 'u3' },
    { username: 'pascal', uid: 'u4' },
  ];

  test('exact, puis préfixe, puis sous-chaîne', () => {
    assert.deepEqual(
      completerMention('ali', candidats).map((c) => c.username),
      ['ali', 'alice'],
    );
  });

  test('requête vide : tous, dans l’ordre d’arrivée, spéciales à la fin', () => {
    assert.deepEqual(
      completerMention('', candidats).map((c) => c.username),
      ['bob', 'alice', 'ali', 'pascal', 'all', 'here'],
    );
  });

  test('une personne passe avant la mention spéciale à qualité égale', () => {
    // `al` est un préfixe d'`alice`, `ali` ET `all`.
    assert.deepEqual(
      completerMention('al', candidats).map((c) => c.username),
      ['alice', 'ali', 'all', 'pascal'],
    );
  });

  test('les spéciales matchent comme les autres', () => {
    assert.deepEqual(
      completerMention('here', []).map((c) => c.username),
      ['here'],
    );
  });

  test('insensible à la casse, username original conservé', () => {
    const r = completerMention('ALI', [{ username: 'Alice', uid: 'u1' }]);
    assert.deepEqual(
      r.map((c) => c.username),
      ['Alice'],
    );
  });

  test('déduplique par username, première occurrence gagne', () => {
    const r = completerMention('bob', [
      { username: 'bob', uid: 'u2' },
      { username: 'BOB', uid: 'u9' },
    ]);
    assert.deepEqual(r, [{ username: 'bob', uid: 'u2' }]);
  });

  test('respecte la limite', () => {
    const beaucoup = Array.from({ length: 40 }, (_, i) => ({
      username: `user${i}`,
      uid: `u${i}`,
    }));
    assert.equal(completerMention('user', beaucoup, 5).length, 5);
  });

  test('aucune correspondance : liste vide', () => {
    assert.deepEqual(completerMention('zz', candidats), []);
  });
});
