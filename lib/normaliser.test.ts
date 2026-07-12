import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { versMessage } from './normaliser.ts';

const base = { _id: 'm1', rid: 'r1', ts: 1000, u: { _id: 'u1', username: 'alice' } };

describe('versMessage — message de visioconférence', () => {
  test('extrait le callId du bloc video_conf (pas du _id)', () => {
    // Sur la source RC, le callId vit dans le bloc ; le _id du message diffère.
    const m = versMessage({
      ...base,
      t: 'videoconf',
      msg: '',
      blocks: [
        { type: 'video_conf', blockId: 'call-abc', callId: 'call-abc', appId: 'videoconf-core' },
      ],
    });
    assert.equal(m?.typeSysteme, 'videoconf');
    assert.equal(m?.appelId, 'call-abc');
  });

  test('un bloc sans callId ni type attendu laisse appelId à null', () => {
    const m = versMessage({ ...base, t: 'videoconf', blocks: [{ type: 'section' }] });
    assert.equal(m?.appelId, null);
  });

  test('un message ordinaire n’a pas d’appelId, même avec des blocks', () => {
    // On ne lit les blocs QUE pour un `t: 'videoconf'` : pas de faux positif.
    const m = versMessage({
      ...base,
      msg: 'coucou',
      blocks: [{ type: 'video_conf', callId: 'call-xyz' }],
    });
    assert.equal(m?.typeSysteme, null);
    assert.equal(m?.appelId, null);
  });
});
