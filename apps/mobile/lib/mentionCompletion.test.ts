import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  completeMention,
  detectMentionToken,
  type MentionCandidate,
} from './mentionCompletion.ts';

describe('detectMentionToken', () => {
  test('finds the open token just before the cursor', () => {
    assert.deepEqual(detectMentionToken('salut @al', 9), { start: 6, query: 'al' });
  });

  test('a bare @ suggests (empty query)', () => {
    assert.deepEqual(detectMentionToken('@', 1), { start: 0, query: '' });
  });

  test('lowercases the query, keeps the start intact', () => {
    assert.deepEqual(detectMentionToken('@ALice', 6), { start: 0, query: 'alice' });
  });

  test('does not trigger in the middle of an email address', () => {
    assert.equal(detectMentionToken('marc@barrut.me', 14), null);
  });

  test('an accented letter before the @ also blocks it', () => {
    assert.equal(detectMentionToken('café@bar', 8), null);
  });

  test('a space in the query closes the token', () => {
    assert.equal(detectMentionToken('@alice bonjour', 14), null);
  });

  test('the token is the one BEFORE the cursor, not the end of the text', () => {
    assert.deepEqual(detectMentionToken('@alice bonjour', 3), { start: 0, query: 'al' });
  });

  test('accepts dots, hyphens and underscores', () => {
    assert.deepEqual(detectMentionToken('@jean.du_pont-2', 15), {
      start: 0,
      query: 'jean.du_pont-2',
    });
  });

  test('an out-of-bounds cursor is clamped into the text', () => {
    assert.deepEqual(detectMentionToken('@al', 99), { start: 0, query: 'al' });
  });
});

describe('completeMention', () => {
  const candidates: MentionCandidate[] = [
    { username: 'bob', uid: 'u2' },
    { username: 'alice', uid: 'u1' },
    { username: 'ali', uid: 'u3' },
    { username: 'pascal', uid: 'u4' },
  ];

  test('exact, then prefix, then substring', () => {
    assert.deepEqual(
      completeMention('ali', candidates).map((c) => c.username),
      ['ali', 'alice'],
    );
  });

  test('empty query: all, in arrival order, special ones last', () => {
    assert.deepEqual(
      completeMention('', candidates).map((c) => c.username),
      ['bob', 'alice', 'ali', 'pascal', 'all', 'here'],
    );
  });

  test('a person comes before a special mention at equal quality', () => {
    // `al` is a prefix of `alice`, `ali` AND `all`.
    assert.deepEqual(
      completeMention('al', candidates).map((c) => c.username),
      ['alice', 'ali', 'all', 'pascal'],
    );
  });

  test('special ones match like the others', () => {
    assert.deepEqual(
      completeMention('here', []).map((c) => c.username),
      ['here'],
    );
  });

  test('case-insensitive, original username kept', () => {
    const r = completeMention('ALI', [{ username: 'Alice', uid: 'u1' }]);
    assert.deepEqual(
      r.map((c) => c.username),
      ['Alice'],
    );
  });

  test('deduplicates by username, first occurrence wins', () => {
    const r = completeMention('bob', [
      { username: 'bob', uid: 'u2' },
      { username: 'BOB', uid: 'u9' },
    ]);
    assert.deepEqual(r, [{ username: 'bob', uid: 'u2' }]);
  });

  test('respects the limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      username: `user${i}`,
      uid: `u${i}`,
    }));
    assert.equal(completeMention('user', many, 5).length, 5);
  });

  test('no match: empty list', () => {
    assert.deepEqual(completeMention('zz', candidates), []);
  });
});
