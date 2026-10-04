import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { UNREAD_BAR_ID, insertUnreadBar } from './unreadBar.ts';

/** Un message minimal — DESC : construire du plus récent au plus ancien. */
const m = (id: string, ts: number, authorId: string) => ({ id, ts, authorId });

const ids = (rows: { id: string }[]): string[] => rows.map((l) => l.id);

describe('insererBarreNonLus', () => {
  test('la barre se pose sur le plus ANCIEN non-lu d’autrui — la dernière occurrence, pas la première', () => {
    // DESC : m3 (300) puis m2 (200) puis m1 (100). Lu jusqu'à 150 : m3 et m2
    // sont non lus, le plus ancien des deux est m2. Un `break` à la première
    // occurrence poserait la barre sous m3, le plus récent — LE piège.
    const data = [m('m3', 300, 'bob'), m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    const result = insertUnreadBar(data, 150, 'moi');
    assert.deepEqual(ids(result), ['m3', 'm2', UNREAD_BAR_ID, 'm1']);
  });

  test('mes propres messages ne comptent pas comme non lus', () => {
    // J'ai posté m3 après ma dernière lecture : la barre ne se pose que sur
    // le message d'autrui (m2), pas sous le mien.
    const data = [m('m3', 300, 'moi'), m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insertUnreadBar(data, 150, 'moi')), [
      'm3',
      'm2',
      UNREAD_BAR_ID,
      'm1',
    ]);
    // Et si le SEUL postérieur est de moi : pas de barre du tout.
    const onlyMe = [m('m3', 300, 'moi'), m('m1', 100, 'bob')];
    assert.equal(insertUnreadBar(onlyMe, 150, 'moi'), onlyMe);
  });

  test('tout est non lu → la barre sous le plus ancien ; tout est lu → pas de barre, MÊME référence', () => {
    const data = [m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insertUnreadBar(data, 50, 'moi')), ['m2', 'm1', UNREAD_BAR_ID]);
    // Même référence : le useMemo de l'écran ne doit pas re-rendre pour rien.
    assert.equal(insertUnreadBar(data, 300, 'moi'), data);
  });

  test('sans borne de lecture (undefined ou null), la liste ressort TELLE QUELLE', () => {
    // `undefined` : l'instantané de `ls` n'est pas encore lu de la base.
    // `null` : abonnement sans `ls`. Dans les deux cas, pas de barre.
    const data = [m('m1', 100, 'bob')];
    assert.equal(insertUnreadBar(data, undefined, 'moi'), data);
    assert.equal(insertUnreadBar(data, null, 'moi'), data);
  });

  test('exactement à la borne : `ls` est INCLUS dans le lu (strictement postérieur requis)', () => {
    const data = [m('m1', 150, 'bob')];
    assert.equal(insertUnreadBar(data, 150, 'moi'), data);
  });

  test('liste vide : rien à faire', () => {
    const empty: { id: string; ts: number; authorId: string }[] = [];
    assert.equal(insertUnreadBar(empty, 100, 'moi'), empty);
  });

  test('CONSIGNÉ : sans uid (identifiants null), la barre peut se poser au-dessus de MES messages', () => {
    // Comportement en place, relevé par l'audit : `moiUid` undefined ne peut
    // exclure personne, donc mon propre message compte comme « d'autrui ».
    // Le test le fige pour que le jour où on le corrige, ce soit un choix.
    const data = [m('m2', 300, 'moi'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insertUnreadBar(data, 150, undefined)), [
      'm2',
      UNREAD_BAR_ID,
      'm1',
    ]);
  });
});
