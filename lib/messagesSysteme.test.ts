import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type Traducteur, traduire } from '../ui/messages.ts';
import { texteSysteme } from './messagesSysteme.ts';

/** Traducteur réel en français : on teste les VRAIES phrases, pas un stub. */
const t: Traducteur = (cle, params) => traduire('fr', cle, params);

describe('texteSysteme', () => {
  test('les événements d’adhésion se passent de paramètre', () => {
    assert.equal(texteSysteme(t, 'uj', 'alice'), 'a rejoint le salon');
    assert.equal(texteSysteme(t, 'ul', null), 'a quitté le salon');
  });

  test('les actions sur autrui incorporent le paramètre (`msg` = la cible)', () => {
    assert.equal(texteSysteme(t, 'au', 'bob'), 'a ajouté bob au salon');
    assert.equal(texteSysteme(t, 'ru', 'bob'), 'a retiré bob du salon');
    assert.equal(texteSysteme(t, 'r', 'nouveau-nom'), 'a renommé le salon en nouveau-nom');
    assert.equal(texteSysteme(t, 'room_changed_topic', 'Le sujet'), 'a changé le sujet : Le sujet');
  });

  test('`rm` reste neutre : `u` est l’auteur d’origine, pas le suppresseur', () => {
    assert.equal(texteSysteme(t, 'rm', null), '(message supprimé)');
  });

  test('effacer un sujet (msg vide) ne laisse pas de deux-points pendu', () => {
    assert.equal(texteSysteme(t, 'room_changed_topic', ''), 'a retiré le sujet');
    assert.equal(texteSysteme(t, 'room_changed_topic', null), 'a retiré le sujet');
  });

  test('un type inconnu rend une phrase générique, jamais rien', () => {
    assert.equal(texteSysteme(t, 'futur-type', null), '(action système « futur-type »)');
    assert.equal(texteSysteme(t, 'futur-type', 'param'), '(action système « futur-type » : param)');
  });

  test('la même clé bascule en anglais selon le traducteur injecté', () => {
    const en: Traducteur = (cle, params) => traduire('en', cle, params);
    assert.equal(texteSysteme(en, 'uj', null), 'joined the channel');
    assert.equal(texteSysteme(en, 'au', 'bob'), 'added bob to the channel');
  });
});
