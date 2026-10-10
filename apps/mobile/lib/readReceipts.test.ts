import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comparePositions, readReceipt, readersAt, receiptAnchor, receiptLine, type ReceiptRow } from './readReceipts.ts';

const none = new Set<string>();
const names: Record<string, string> = { bob: 'Bob', carol: 'Carol', dave: 'Dave', erin: 'Erin', frank: 'Frank' };
const name = (uid: string) => names[uid] ?? null;

test('positions compare as numbers, beyond 2^53 too', () => {
  assert.equal(comparePositions('9', '10'), -1);
  assert.equal(comparePositions('10', '9'), 1);
  assert.equal(comparePositions('42', '42'), 0);
  // 2^53 + 1 and 2^53 + 2: equal as JS numbers, distinct as positions.
  assert.equal(comparePositions('9007199254740993', '9007199254740994'), -1);
  assert.equal(comparePositions('18446744073709551615', '9007199254740993'), 1);
  assert.equal(comparePositions('123456789012345678901', '123456789012345678901'), 0);
});

test('the anchor is my latest confirmed root message, skipping the others', () => {
  const rows: ReceiptRow[] = [
    { id: 'pending', authorId: 'me' },
    { id: 'theirs', authorId: 'bob' },
    { id: 'system', authorId: 'me', systemType: 'room_renamed' },
    { id: 'reply', authorId: 'me', threadId: 'root' },
    { id: 'unconfirmed', authorId: 'me' },
    { id: 'mine', authorId: 'me' },
    { id: 'older', authorId: 'me' },
  ];
  const positions = new Map([
    ['pending', '9'], ['theirs', '8'], ['system', '7'], ['reply', '6'], ['mine', '4'], ['older', '3'],
  ]);
  assert.deepEqual(receiptAnchor(rows, 'me', positions, new Set(['pending'])), { id: 'mine', position: '4' });
  assert.equal(receiptAnchor(rows.slice(0, 5), 'me', positions, new Set(['pending'])), null);
  assert.equal(receiptAnchor([], 'me', positions, none), null);
});

test('readers are the marks at or past the message, big positions included', () => {
  const marks = [
    { user_id: 'bob', root_position: '9007199254740993' },
    { user_id: 'carol', root_position: '9007199254740992' },
    { user_id: 'dave', root_position: '10000000000000000' },
  ];
  assert.deepEqual(readersAt(marks, '9007199254740993').map((m) => m.user_id), ['bob', 'dave']);
  assert.deepEqual(readersAt(marks, '99999999999999999').map((m) => m.user_id), []);
});

test('a direct room says Seen, a group names up to three then counts the rest', () => {
  const marks = (...ids: string[]) => ids.map((user_id) => ({ user_id, root_position: '5' }));
  assert.equal(receiptLine([], true, name), null);
  assert.equal(receiptLine([], false, name), null);
  assert.deepEqual(receiptLine(marks('bob'), true, name), { kind: 'seen' });
  assert.deepEqual(receiptLine(marks('bob', 'carol'), false, name), { kind: 'seenBy', names: ['Bob', 'Carol'], others: 0 });
  assert.deepEqual(receiptLine(marks('bob', 'carol', 'dave'), false, name), { kind: 'seenBy', names: ['Bob', 'Carol', 'Dave'], others: 0 });
  assert.deepEqual(receiptLine(marks('bob', 'carol', 'dave', 'erin', 'frank'), false, name), { kind: 'seenBy', names: ['Bob', 'Carol', 'Dave'], others: 2 });
  // A reader the frame has no profile for is counted, never shown as an id.
  assert.deepEqual(receiptLine(marks('ghost', 'bob'), false, name), { kind: 'seenBy', names: ['Bob'], others: 1 });
});

test('the whole rule: nothing without a reader, nothing for an older message', () => {
  const rows: ReceiptRow[] = [
    { id: 'theirs', authorId: 'bob' },
    { id: 'mine', authorId: 'me' },
    { id: 'older', authorId: 'me' },
  ];
  const positions = new Map([['theirs', '12'], ['mine', '11'], ['older', '10']]);
  const base = { rowsDesc: rows, me: 'me', positions, pending: none, direct: false, name };
  assert.equal(readReceipt({ ...base, marks: [] }), null);
  // Carol stopped at the older one: the line stays off, and is never put under it.
  assert.equal(readReceipt({ ...base, marks: [{ user_id: 'carol', root_position: '10' }] }), null);
  assert.deepEqual(
    readReceipt({ ...base, marks: [{ user_id: 'carol', root_position: '10' }, { user_id: 'bob', root_position: '12' }] }),
    { messageId: 'mine', line: { kind: 'seenBy', names: ['Bob'], others: 0 } },
  );
  assert.deepEqual(
    readReceipt({ ...base, direct: true, marks: [{ user_id: 'bob', root_position: '11' }] }),
    { messageId: 'mine', line: { kind: 'seen' } },
  );
});
