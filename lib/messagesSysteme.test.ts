import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { texteSysteme } from './messagesSysteme.ts';

describe('texteSysteme', () => {
  test('les événements d’adhésion se passent de paramètre', () => {
    assert.equal(texteSysteme('uj', 'alice'), 'a rejoint le salon');
    assert.equal(texteSysteme('ul', null), 'a quitté le salon');
  });

  test('les actions sur autrui incorporent le paramètre (`msg` = la cible)', () => {
    assert.equal(texteSysteme('au', 'bob'), 'a ajouté bob au salon');
    assert.equal(texteSysteme('ru', 'bob'), 'a retiré bob du salon');
    assert.equal(texteSysteme('r', 'nouveau-nom'), 'a renommé le salon en nouveau-nom');
    assert.equal(texteSysteme('room_changed_topic', 'Le sujet'), 'a changé le sujet : Le sujet');
  });

  test('`rm` reste neutre : `u` est l’auteur d’origine, pas le suppresseur', () => {
    assert.equal(texteSysteme('rm', null), '(message supprimé)');
  });

  test('effacer un sujet (msg vide) ne laisse pas de deux-points pendu', () => {
    assert.equal(texteSysteme('room_changed_topic', ''), 'a retiré le sujet');
    assert.equal(texteSysteme('room_changed_topic', null), 'a retiré le sujet');
  });

  test('un type inconnu rend une phrase générique, jamais rien', () => {
    assert.equal(texteSysteme('futur-type', null), '(action système « futur-type »)');
    assert.equal(texteSysteme('futur-type', 'param'), '(action système « futur-type » : param)');
  });
});
