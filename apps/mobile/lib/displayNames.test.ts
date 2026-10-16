import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { displayNames, mentionNames, mountDisplayNames, setDisplayNames } from './displayNames.ts';

describe('display names', () => {
  test('a source with mention names publishes them, and unmounting clears them', () => {
    const unmount = mountDisplayNames({
      names: () => new Map([['u1', 'Bob Builder']]),
      statuses: () => new Map(),
      mentions: () => new Map([['bob', 'Bob Builder']]),
      subscribe: () => () => {},
    });
    assert.equal(mentionNames().get('bob'), 'Bob Builder');
    unmount();
    assert.equal(mentionNames().size, 0);
  });

  test('a source without them (Rocket.Chat real names) leaves mentions as written', () => {
    setDisplayNames(new Map([['u1', 'Bob']]));
    assert.equal(displayNames().get('u1'), 'Bob');
    assert.equal(mentionNames().size, 0);
  });
});
