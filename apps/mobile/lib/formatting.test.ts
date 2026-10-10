import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { codeBlock, link, toggleLines, toggleWrap } from './formatting.ts';

// The desktop's own cases (rv-core/src/compose.rs), so both apps agree.
const edit = (text: string, start: number, end: number) => ({ text, start, end });

describe('formatting', () => {
  test('wrapping toggles', () => {
    assert.deepEqual(toggleWrap('say hi now', 4, 6, '*'), edit('say *hi* now', 5, 7));
    assert.deepEqual(toggleWrap('say *hi* now', 5, 7, '*'), edit('say hi now', 4, 6));
    assert.deepEqual(toggleWrap('say *hi* now', 4, 8, '*'), edit('say hi now', 4, 6));
    assert.deepEqual(toggleWrap('', 0, 0, '~'), edit('~~', 1, 1));
    assert.deepEqual(toggleWrap('café', 0, 4, '_'), edit('_café_', 1, 5));
  });

  test('lines toggle together', () => {
    assert.deepEqual(toggleLines('a\nb', 0, 3, 'quote'), edit('> a\n> b', 2, 7));
    assert.deepEqual(toggleLines('> a\n> b', 2, 7, 'quote'), edit('a\nb', 0, 3));
    assert.deepEqual(toggleLines('x\ny\nz', 2, 5, 'numbered'), edit('x\n1. y\n2. z', 5, 11));
    assert.deepEqual(toggleLines('- a\nb', 0, 5, 'bullet'), edit('- a\n- b', 0, 7));
    assert.deepEqual(toggleLines('', 0, 0, 'heading'), edit('# ', 2, 2));
  });

  test('blocks and links', () => {
    assert.deepEqual(codeBlock('see x', 4, 5), edit('see \n```\nx\n```', 9, 10));
    assert.deepEqual(link('site', 0, 4), edit('[site](https://)', 7, 15));
  });
});
