import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  completeMention,
  detectMentionToken,
  type MentionCandidate,
} from './mentionCompletion.ts';

describe('detecterJetonMention', () => {
  test('repère le jeton ouvert juste avant le curseur', () => {
    assert.deepEqual(detectMentionToken('salut @al', 9), { start: 6, query: 'al' });
  });

  test('le @ nu propose (requête vide)', () => {
    assert.deepEqual(detectMentionToken('@', 1), { start: 0, query: '' });
  });

  test('minuscule la requête, garde le début intact', () => {
    assert.deepEqual(detectMentionToken('@ALice', 6), { start: 0, query: 'alice' });
  });

  test('ne déclenche pas au milieu d’une adresse email', () => {
    assert.equal(detectMentionToken('marc@barrut.me', 14), null);
  });

  test('une lettre accentuée avant le @ ferme aussi la porte', () => {
    assert.equal(detectMentionToken('café@bar', 8), null);
  });

  test('une espace dans la requête ferme le jeton', () => {
    assert.equal(detectMentionToken('@alice bonjour', 14), null);
  });

  test('le jeton est celui AVANT le curseur, pas la fin du texte', () => {
    assert.deepEqual(detectMentionToken('@alice bonjour', 3), { start: 0, query: 'al' });
  });

  test('accepte points, tirets et underscores', () => {
    assert.deepEqual(detectMentionToken('@jean.du_pont-2', 15), {
      start: 0,
      query: 'jean.du_pont-2',
    });
  });

  test('curseur hors bornes est ramené dans le texte', () => {
    assert.deepEqual(detectMentionToken('@al', 99), { start: 0, query: 'al' });
  });
});

describe('completerMention', () => {
  const candidats: MentionCandidate[] = [
    { username: 'bob', uid: 'u2' },
    { username: 'alice', uid: 'u1' },
    { username: 'ali', uid: 'u3' },
    { username: 'pascal', uid: 'u4' },
  ];

  test('exact, puis préfixe, puis sous-chaîne', () => {
    assert.deepEqual(
      completeMention('ali', candidats).map((c) => c.username),
      ['ali', 'alice'],
    );
  });

  test('requête vide : tous, dans l’ordre d’arrivée, spéciales à la fin', () => {
    assert.deepEqual(
      completeMention('', candidats).map((c) => c.username),
      ['bob', 'alice', 'ali', 'pascal', 'all', 'here'],
    );
  });

  test('une personne passe avant la mention spéciale à qualité égale', () => {
    // `al` est un préfixe d'`alice`, `ali` ET `all`.
    assert.deepEqual(
      completeMention('al', candidats).map((c) => c.username),
      ['alice', 'ali', 'all', 'pascal'],
    );
  });

  test('les spéciales matchent comme les autres', () => {
    assert.deepEqual(
      completeMention('here', []).map((c) => c.username),
      ['here'],
    );
  });

  test('insensible à la casse, username original conservé', () => {
    const r = completeMention('ALI', [{ username: 'Alice', uid: 'u1' }]);
    assert.deepEqual(
      r.map((c) => c.username),
      ['Alice'],
    );
  });

  test('déduplique par username, première occurrence gagne', () => {
    const r = completeMention('bob', [
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
    assert.equal(completeMention('user', beaucoup, 5).length, 5);
  });

  test('aucune correspondance : liste vide', () => {
    assert.deepEqual(completeMention('zz', candidats), []);
  });
});
