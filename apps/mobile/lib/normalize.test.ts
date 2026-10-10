import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toSubscription, toEpoch, toMessage, toRoom } from './normalize.ts';

const base = { _id: 'm1', rid: 'r1', ts: 1000, u: { _id: 'u1', username: 'alice' } };

describe('toMessage: video conference message', () => {
  test('takes the callId from the video_conf block (not from _id)', () => {
    // In the RC source the callId lives in the block; the message _id differs.
    const m = toMessage({
      ...base,
      t: 'videoconf',
      msg: '',
      blocks: [
        { type: 'video_conf', blockId: 'call-abc', callId: 'call-abc', appId: 'videoconf-core' },
      ],
    });
    assert.equal(m?.systemType, 'videoconf');
    assert.equal(m?.callId, 'call-abc');
  });

  test('a block without callId or the expected type leaves callId null', () => {
    const m = toMessage({ ...base, t: 'videoconf', blocks: [{ type: 'section' }] });
    assert.equal(m?.callId, null);
  });

  test('an ordinary message has no callId, even with blocks', () => {
    // Blocks are read ONLY for a `t: 'videoconf'`: no false positive.
    const m = toMessage({
      ...base,
      msg: 'hey',
      blocks: [{ type: 'video_conf', callId: 'call-xyz' }],
    });
    assert.equal(m?.systemType, null);
    assert.equal(m?.callId, null);
  });
});

describe('toMessage: pins and stars', () => {
  test('reads `pinned` and reduces `starred` to uids', () => {
    const m = toMessage({ ...base, msg: 'x', pinned: true, starred: [{ _id: 'u1' }, { _id: 'u2' }] });
    assert.equal(m?.pinned, true);
    assert.equal(m?.starred, '["u1","u2"]');
  });

  test('absent or empty: neither pinned nor starred', () => {
    const m = toMessage({ ...base, msg: 'x', starred: [] });
    assert.equal(m?.pinned, false);
    assert.equal(m?.starred, null);
  });

  test("a root's `replies` are its followers' uids", () => {
    const m = toMessage({ ...base, msg: 'x', tcount: 2, replies: ['u1', 'u2'] });
    assert.equal(m?.threadFollowers, '["u1","u2"]');
    assert.equal(toMessage({ ...base, msg: 'x' })?.threadFollowers, null);
  });
});

describe('toEpoch: the three shapes the server sends', () => {
  test('a number passes through', () => {
    assert.equal(toEpoch(1_700_000_000_000), 1_700_000_000_000);
  });

  test('an ISO string is parsed', () => {
    assert.equal(toEpoch('2026-07-25T10:00:00.000Z'), Date.parse('2026-07-25T10:00:00.000Z'));
  });

  test('the EJSON { $date } shape is unwrapped, number or string', () => {
    assert.equal(toEpoch({ $date: 1234 }), 1234);
    assert.equal(toEpoch({ $date: '2026-07-25T10:00:00.000Z' }), Date.parse('2026-07-25T10:00:00.000Z'));
  });

  test('everything else returns null, never NaN', () => {
    // A NaN written to the database stays there: SQLite accepts it, and every
    // timestamp comparison silently becomes false.
    for (const v of [undefined, null, '', 'not a date', {}, { $date: 'not a date' }, [], true, NaN, Infinity]) {
      assert.equal(toEpoch(v), null, `${JSON.stringify(v) ?? String(v)} should return null`);
    }
  });
});

describe('toRoom: the DM and its correspondent', () => {
  const ME = 'guillaume';
  const MY_UID = 'uMoi';
  const dm = (o: Record<string, unknown> = {}) => ({
    _id: 'r1',
    t: 'd',
    _updatedAt: { $date: 100 },
    uids: [MY_UID, 'uBob'],
    usernames: [ME, 'bob'],
    ...o,
  });

  test('the correspondent is whichever of the two is not me', () => {
    const s = toRoom(dm(), ME, MY_UID);
    assert.equal(s?.dmOtherUid, 'uBob');
    assert.equal(s?.dmOtherUsername, 'bob');
    assert.equal(s?.displayName, 'bob');
  });

  test('uids and usernames are NOT aligned: matching is not by index', () => {
    // Checked on 8.5. Positional matching would return "guillaume" here for
    // Bob's uid, so MY username, and my avatar, pinned on him.
    const s = toRoom(dm({ uids: [MY_UID, 'uBob'], usernames: ['bob', ME] }), ME, MY_UID);
    assert.equal(s?.dmOtherUid, 'uBob');
    assert.equal(s?.dmOtherUsername, 'bob');
  });

  test('STALE me (renamed from the web): no guessing, say nothing', () => {
    // The heart of the bug: `me` is frozen when the translator is built.
    // Without proof that I am in `usernames`, excluding "whoever is not me"
    // keeps the FIRST one, me half the time, and that username goes to the
    // database under the other user's uid, WITHOUT a timestamp guard.
    const s = toRoom(dm({ usernames: ['old-username', 'bob'] }), ME, MY_UID);
    assert.equal(s?.dmOtherUid, 'uBob', 'the uid stays reliable');
    assert.equal(s?.dmOtherUsername, null, 'no made-up identity');
  });

  test('session without a username (empty): same caution', () => {
    assert.equal(toRoom(dm(), '', MY_UID)?.dmOtherUsername, null);
    assert.equal(toRoom(dm(), null, MY_UID)?.dmOtherUsername, null);
    assert.equal(toRoom(dm(), undefined, MY_UID)?.dmOtherUsername, null);
  });

  test('DM with oneself: I am my own correspondent', () => {
    const s = toRoom(dm({ uids: [MY_UID], usernames: [ME] }), ME, MY_UID);
    assert.equal(s?.dmOtherUid, MY_UID);
    assert.equal(s?.dmOtherUsername, ME);
    assert.equal(s?.displayName, ME);
  });

  test('GROUP DM: no SINGLE presence to show, so no correspondent', () => {
    const s = toRoom(dm({ uids: [MY_UID, 'uBob', 'uCarol'], usernames: [ME, 'bob', 'carol'] }), ME, MY_UID);
    assert.equal(s?.dmOtherUid, null);
    assert.equal(s?.dmOtherUsername, null);
    assert.equal(s?.displayName, 'bob, carol');
  });

  test('without my uid, no correspondent is derived', () => {
    assert.equal(toRoom(dm(), ME)?.dmOtherUid, null);
    assert.equal(toRoom(dm(), ME)?.dmOtherUsername, null);
  });

  test('fname wins over the name derived from usernames', () => {
    assert.equal(toRoom(dm({ fname: 'Bob Martin' }), ME, MY_UID)?.displayName, 'Bob Martin');
  });
});

describe('toRoom: last message preview', () => {
  const room = (lastMessage?: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    toRoom({ _id: 'r1', t: 'c', _updatedAt: { $date: 100 }, ...o, ...(lastMessage ? { lastMessage } : {}) });

  test('the message text', () => {
    const s = room({ _id: 'm1', msg: 'hey', ts: { $date: 50 } });
    assert.equal(s?.lastMessage, 'hey');
    assert.equal(s?.lastMessageType, null);
    assert.equal(s?.lastMessageTs, 50);
  });

  test('a message that is ONLY an attachment falls back on its caption, else its name', () => {
    // `msg: ''` is the shape of an upload, probed on 8.5.
    assert.equal(
      room({ _id: 'm1', msg: '', attachments: [{ title: 'note.pdf', description: 'the minutes' }] })
        ?.lastMessage,
      'the minutes',
    );
    assert.equal(
      room({ _id: 'm1', msg: '', attachments: [{ title: 'note.pdf' }] })?.lastMessage,
      'note.pdf',
    );
  });

  test('VIDEO CALL: no text but a type, so the row will not be empty', () => {
    // Its content lives in `blocks`. Without the type the preview dropped to
    // null and the room rose to the top of the list with a blank row.
    const s = room({ _id: 'm1', msg: '', t: 'videoconf', ts: { $date: 50 } });
    assert.equal(s?.lastMessage, null);
    assert.equal(s?.lastMessageType, 'videoconf');
  });

  test('EMPTIED room: no lastMessage at all, both null', () => {
    // The only way to learn that a room was emptied, not to be confused with
    // "last message with no text to show".
    const s = room(undefined, { lm: { $date: 40 } });
    assert.equal(s?.lastMessage, null);
    assert.equal(s?.lastMessageType, null);
    assert.equal(s?.lastMessageTs, 40, 'lm survives the deletion');
  });

  test('ENCRYPTED room: no preview or type, the server only holds ciphertext', () => {
    const s = room({ _id: 'm1', msg: 'AAAAbase64==', t: 'e2e', ts: { $date: 50 } }, { encrypted: true });
    assert.equal(s?.encrypted, true);
    assert.equal(s?.lastMessage, null);
    assert.equal(s?.lastMessageType, null);
  });

  test('ABSENT avatarETag is null: "nothing to say", not "clear"', () => {
    assert.equal(room()?.avatarEtag, null);
    assert.equal(toRoom({ _id: 'r1', t: 'c', avatarETag: 'abc' })?.avatarEtag, 'abc');
  });

  test('without _updatedAt, updatedAt is 0: the oldest possible document', () => {
    // It settles the UPSERT's `WHERE excluded.updated_at >=`: defaulting to
    // "now" would let a partial document win over a fresh one.
    assert.equal(toRoom({ _id: 'r1', t: 'c' })?.updatedAt, 0);
  });

  test('a document without _id or t cannot be normalized', () => {
    assert.equal(toRoom({ t: 'c' }), null);
    assert.equal(toRoom({ _id: 'r1' }), null);
  });
});

describe('toSubscription', () => {
  test("a two-person DM carries its peer's real name, a channel none", () => {
    assert.equal(toSubscription({ rid: 'd1', t: 'd', name: 'bob', fname: 'Bob Durand' })?.dmName, 'Bob Durand');
    assert.equal(toSubscription({ rid: 'c1', t: 'c', name: 'general', fname: 'General' })?.dmName, null);
  });

  test('absent counters are 0, flags false', () => {
    const a = toSubscription({ rid: 'r1' });
    assert.deepEqual(a, {
      rid: 'r1',
      subId: null,
      unread: 0,
      mentions: 0,
      groupMentions: 0,
      alert: false,
      open: false,
      favorite: false,
      lastSeen: null,
      e2eKey: null,
      e2eKeyId: null,
      roles: null,
      groupId: null,
      groupName: null,
      groupRank: null,
      dmName: null,
      updatedAt: 0,
    });
  });

  test('a full subscription is copied field by field', () => {
    const a = toSubscription({
      _id: 's1',
      rid: 'r1',
      unread: 3,
      userMentions: 1,
      groupMentions: 2,
      alert: true,
      open: true,
      f: true,
      ls: { $date: 900 },
      E2EKey: 'kid+base64',
      e2eKeyId: 'kid',
      roles: ['owner', 7],
      _updatedAt: { $date: 1000 },
    });
    assert.deepEqual(a, {
      rid: 'r1',
      subId: 's1',
      unread: 3,
      mentions: 1,
      groupMentions: 2,
      alert: true,
      open: true,
      favorite: true,
      lastSeen: 900,
      e2eKey: 'kid+base64',
      e2eKeyId: 'kid',
      roles: '["owner"]',
      groupId: null,
      groupName: null,
      groupRank: null,
      dmName: null,
      updatedAt: 1000,
    });
  });

  test('without rid, nothing to write', () => {
    assert.equal(toSubscription({ _id: 's1' }), null);
  });

  test('a "truthy" flag that is not true stays false', () => {
    // `boolean` compares with `true`: a 1 or a string from an unexpected
    // payload must not light an unread badge.
    const a = toSubscription({ rid: 'r1', alert: 1, open: 'yes' });
    assert.equal(a?.alert, false);
    assert.equal(a?.open, false);
  });
});
