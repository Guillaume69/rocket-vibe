import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type TranslateFn, translate } from '../ui/messages.ts';
import { systemPreview, systemText } from './systemMessages.ts';

/** Real French translator: the REAL sentences are tested, not a stub. */
const t: TranslateFn = (key, params) => translate('fr', key, params);

describe('systemText', () => {
  test('membership events need no parameter', () => {
    assert.equal(systemText(t, 'uj', 'alice'), 'a rejoint le salon');
    assert.equal(systemText(t, 'ul', null), 'a quitté le salon');
  });

  test('actions on others include the parameter (`msg` = the target)', () => {
    assert.equal(systemText(t, 'au', 'bob'), 'a ajouté bob au salon');
    assert.equal(systemText(t, 'ru', 'bob'), 'a retiré bob du salon');
    assert.equal(systemText(t, 'r', 'nouveau-nom'), 'a renommé le salon en nouveau-nom');
    assert.equal(systemText(t, 'room_changed_topic', 'Le sujet'), 'a changé le sujet : Le sujet');
  });

  test('`rm` stays neutral: `u` is the original author, not the deleter', () => {
    assert.equal(systemText(t, 'rm', null), '(message supprimé)');
  });

  test('clearing a topic (empty msg) leaves no dangling colon', () => {
    assert.equal(systemText(t, 'room_changed_topic', ''), 'a retiré le sujet');
    assert.equal(systemText(t, 'room_changed_topic', null), 'a retiré le sujet');
  });

  test('an unknown type yields a generic sentence, never nothing', () => {
    assert.equal(systemText(t, 'futur-type', null), '(action système « futur-type »)');
    assert.equal(systemText(t, 'futur-type', 'param'), '(action système « futur-type » : param)');
  });

  test('the same key switches to English with the injected translator', () => {
    const en: TranslateFn = (key, params) => translate('en', key, params);
    assert.equal(systemText(en, 'uj', null), 'joined the channel');
    assert.equal(systemText(en, 'au', 'bob'), 'added bob to the channel');
  });
});

describe('systemPreview: room list label', () => {
  test('a video call has a STANDALONE label, not a predicate', () => {
    // The room list shows no author name: a `systemText` sentence there would
    // read "joined the room", with no subject.
    assert.equal(systemPreview(t, 'videoconf'), 'Appel vidéo');
    assert.notEqual(systemPreview(t, 'videoconf'), systemText(t, 'videoconf', null));
  });

  test('everything else says nothing: the row stays empty, as before', () => {
    for (const type of [null, 'uj', 'e2e', 'un-type-inconnu']) {
      assert.equal(systemPreview(t, type), null, `${type} should yield nothing`);
    }
  });
});
