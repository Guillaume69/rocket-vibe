import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { providerMark } from './providerMark.ts';

test('every provider but Vibez falls back to its own mark, which is bundled', () => {
  const kinds = ['rocketchat', 'mattermost', 'kchat', 'slack', 'teams', 'whatsapp'] as const;
  for (const kind of kinds) {
    const mark = providerMark(kind);
    assert.equal(mark, kind);
    assert.ok(existsSync(new URL(`../assets/brands/${mark}.png`, import.meta.url)), kind);
  }
  assert.equal(providerMark('vibez'), null);
});
