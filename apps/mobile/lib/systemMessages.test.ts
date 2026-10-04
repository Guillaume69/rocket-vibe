import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type TranslateFn, translate } from '../ui/messages.ts';
import { systemPreview, systemText } from './systemMessages.ts';

/** Traducteur réel en français : on teste les VRAIES phrases, pas un stub. */
const t: TranslateFn = (cle, params) => translate('fr', cle, params);

describe('texteSysteme', () => {
  test('les événements d’adhésion se passent de paramètre', () => {
    assert.equal(systemText(t, 'uj', 'alice'), 'a rejoint le salon');
    assert.equal(systemText(t, 'ul', null), 'a quitté le salon');
  });

  test('les actions sur autrui incorporent le paramètre (`msg` = la cible)', () => {
    assert.equal(systemText(t, 'au', 'bob'), 'a ajouté bob au salon');
    assert.equal(systemText(t, 'ru', 'bob'), 'a retiré bob du salon');
    assert.equal(systemText(t, 'r', 'nouveau-nom'), 'a renommé le salon en nouveau-nom');
    assert.equal(systemText(t, 'room_changed_topic', 'Le sujet'), 'a changé le sujet : Le sujet');
  });

  test('`rm` reste neutre : `u` est l’auteur d’origine, pas le suppresseur', () => {
    assert.equal(systemText(t, 'rm', null), '(message supprimé)');
  });

  test('effacer un sujet (msg vide) ne laisse pas de deux-points pendu', () => {
    assert.equal(systemText(t, 'room_changed_topic', ''), 'a retiré le sujet');
    assert.equal(systemText(t, 'room_changed_topic', null), 'a retiré le sujet');
  });

  test('un type inconnu rend une phrase générique, jamais rien', () => {
    assert.equal(systemText(t, 'futur-type', null), '(action système « futur-type »)');
    assert.equal(systemText(t, 'futur-type', 'param'), '(action système « futur-type » : param)');
  });

  test('la même clé bascule en anglais selon le traducteur injecté', () => {
    const en: TranslateFn = (cle, params) => translate('en', cle, params);
    assert.equal(systemText(en, 'uj', null), 'joined the channel');
    assert.equal(systemText(en, 'au', 'bob'), 'added bob to the channel');
  });
});

describe('apercuSysteme — libellé de la liste des salons', () => {
  test('un appel vidéo a un libellé AUTONOME, pas un prédicat', () => {
    // La liste des salons n'affiche aucun nom d'auteur : y coller une phrase de
    // `texteSysteme` donnerait « a rejoint le salon », sans sujet.
    assert.equal(systemPreview(t, 'videoconf'), 'Appel vidéo');
    assert.notEqual(systemPreview(t, 'videoconf'), systemText(t, 'videoconf', null));
  });

  test('tout le reste ne dit rien : la ligne reste vide, comme avant', () => {
    for (const type of [null, 'uj', 'e2e', 'un-type-inconnu']) {
      assert.equal(systemPreview(t, type), null, `${type} ne devrait rien rendre`);
    }
  });
});
