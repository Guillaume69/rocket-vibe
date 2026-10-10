import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { listBreak, typedBreak } from './listBreak.ts';

describe('listBreak', () => {
  // The desktop's own cases (rv-core/src/compose.rs), so both apps agree.
  const atEnd = (t: string) => {
    const r = listBreak(t, t.length);
    return r === null ? null : [r.text, r.cursor];
  };

  test('bullets and numbers continue, indented ones too', () => {
    assert.deepEqual(atEnd('- one'), ['- one\n- ', 8]);
    assert.deepEqual(atEnd('intro\n* one'), ['intro\n* one\n* ', 14]);
    assert.deepEqual(atEnd('9. nine'), ['9. nine\n10. ', 12]);
    assert.deepEqual(atEnd('  - sub'), ['  - sub\n  - ', 12]);
  });

  test('a break on an empty item ends the list', () => {
    assert.deepEqual(atEnd('- one\n- '), ['- one\n', 6]);
    assert.deepEqual(atEnd('- one\n3. '), ['- one\n', 6]);
  });

  test('nothing outside a list, inside a code fence, or before the marker', () => {
    assert.equal(atEnd('plain'), null);
    assert.equal(atEnd('-dash'), null);
    assert.equal(atEnd('```\n- in code'), null);
    assert.deepEqual(atEnd('```\ncode\n```\n- after'), ['```\ncode\n```\n- after\n- ', 23]);
    assert.equal(listBreak('- one two', 5)?.text, '- one\n-  two');
    assert.equal(listBreak('- one', 1), null);
  });
});

describe('typedBreak', () => {
  test('one line break typed at the cursor', () => {
    assert.equal(typedBreak('- one', '- one\n', 5), 5);
    assert.equal(typedBreak('- one two', '- one\n two', 5), 5);
  });

  test('anything else is not a typed break', () => {
    assert.equal(typedBreak('- one', '- one\nx', 5), null);
    assert.equal(typedBreak('- one', '- onex', 5), null);
    assert.equal(typedBreak('- one', '- on\ne', 5), null);
  });
});
