import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ID_BARRE_NON_LUS, insererBarreNonLus,insererBarreNonLusNative } from './barreNonLus.ts';

/** Un message minimal — DESC : construire du plus récent au plus ancien. */
const m = (id: string, horodatage: number, auteurId: string) => ({ id, horodatage, auteurId });

const ids = (lignes: { id: string }[]): string[] => lignes.map((l) => l.id);

test('native opening divider uses exact sequence rather than clocks and ignores own and pending messages',()=>{
  const rows=[m('pending',100,'other'),m('newest',200,'other'),m('first',300,'other'),m('own',400,'me'),m('read',500,'other')];
  const positions=new Map([['read','9007199254740992'],['own','9007199254740993'],['first','9007199254740994'],['newest','9007199254740995']]);
  assert.deepEqual(ids(insererBarreNonLusNative(rows,'9007199254740992',positions,'me')),['pending','newest','first',ID_BARRE_NON_LUS,'own','read']);
  assert.equal(insererBarreNonLusNative(rows,null,positions,'me'),rows);
});

describe('insererBarreNonLus', () => {
  test('la barre se pose sur le plus ANCIEN non-lu d’autrui — la dernière occurrence, pas la première', () => {
    // DESC : m3 (300) puis m2 (200) puis m1 (100). Lu jusqu'à 150 : m3 et m2
    // sont non lus, le plus ancien des deux est m2. Un `break` à la première
    // occurrence poserait la barre sous m3, le plus récent — LE piège.
    const donnees = [m('m3', 300, 'bob'), m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    const resultat = insererBarreNonLus(donnees, 150, 'moi');
    assert.deepEqual(ids(resultat), ['m3', 'm2', ID_BARRE_NON_LUS, 'm1']);
  });

  test('mes propres messages ne comptent pas comme non lus', () => {
    // J'ai posté m3 après ma dernière lecture : la barre ne se pose que sur
    // le message d'autrui (m2), pas sous le mien.
    const donnees = [m('m3', 300, 'moi'), m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insererBarreNonLus(donnees, 150, 'moi')), [
      'm3',
      'm2',
      ID_BARRE_NON_LUS,
      'm1',
    ]);
    // Et si le SEUL postérieur est de moi : pas de barre du tout.
    const rienQueMoi = [m('m3', 300, 'moi'), m('m1', 100, 'bob')];
    assert.equal(insererBarreNonLus(rienQueMoi, 150, 'moi'), rienQueMoi);
  });

  test('tout est non lu → la barre sous le plus ancien ; tout est lu → pas de barre, MÊME référence', () => {
    const donnees = [m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insererBarreNonLus(donnees, 50, 'moi')), ['m2', 'm1', ID_BARRE_NON_LUS]);
    // Même référence : le useMemo de l'écran ne doit pas re-rendre pour rien.
    assert.equal(insererBarreNonLus(donnees, 300, 'moi'), donnees);
  });

  test('sans borne de lecture (undefined ou null), la liste ressort TELLE QUELLE', () => {
    // `undefined` : l'instantané de `ls` n'est pas encore lu de la base.
    // `null` : abonnement sans `ls`. Dans les deux cas, pas de barre.
    const donnees = [m('m1', 100, 'bob')];
    assert.equal(insererBarreNonLus(donnees, undefined, 'moi'), donnees);
    assert.equal(insererBarreNonLus(donnees, null, 'moi'), donnees);
  });

  test('exactement à la borne : `ls` est INCLUS dans le lu (strictement postérieur requis)', () => {
    const donnees = [m('m1', 150, 'bob')];
    assert.equal(insererBarreNonLus(donnees, 150, 'moi'), donnees);
  });

  test('liste vide : rien à faire', () => {
    const vide: { id: string; horodatage: number; auteurId: string }[] = [];
    assert.equal(insererBarreNonLus(vide, 100, 'moi'), vide);
  });

  test('CONSIGNÉ : sans uid (identifiants null), la barre peut se poser au-dessus de MES messages', () => {
    // Comportement en place, relevé par l'audit : `moiUid` undefined ne peut
    // exclure personne, donc mon propre message compte comme « d'autrui ».
    // Le test le fige pour que le jour où on le corrige, ce soit un choix.
    const donnees = [m('m2', 300, 'moi'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insererBarreNonLus(donnees, 150, undefined)), [
      'm2',
      ID_BARRE_NON_LUS,
      'm1',
    ]);
  });
});
