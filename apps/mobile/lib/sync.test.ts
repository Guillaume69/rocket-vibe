import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DdpEvent } from './ddp.ts';
import {
  toSubscription,
  toEpoch,
  toMessage,
  toRoom,
  type LocalSubscription,
  type LocalMessage,
  type LocalRoom,
} from './normalize.ts';
import { withTransactionTrap } from './testStore.ts';
import { SyncEngine, type E2EDecryptor, type Store } from './sync.ts';
import { AVATAR_NO_PHOTO } from './upload.ts';
import { RcTranslator } from '../providers/rocketchat/translator.ts';

describe('toEpoch', () => {
  test('accepts Rocket.Chat EJSON', () => {
    assert.equal(toEpoch({ $date: 1_700_000_000_000 }), 1_700_000_000_000);
  });
  test('accepts an ISO string', () => {
    assert.equal(toEpoch('2026-07-10T00:00:00.000Z'), Date.parse('2026-07-10T00:00:00.000Z'));
  });
  test('accepts a raw number', () => {
    assert.equal(toEpoch(42), 42);
  });
  test('returns null on what it does not understand, rather than NaN', () => {
    assert.equal(toEpoch(undefined), null);
    assert.equal(toEpoch('not a date'), null);
    assert.equal(toEpoch({}), null);
  });
});

describe('toMessage', () => {
  const base = {
    _id: 'm1',
    rid: 'r1',
    msg: 'hello',
    ts: { $date: 1000 },
    u: { _id: 'u1', username: 'alice' },
    _updatedAt: { $date: 2000 },
  };

  test('translates an ordinary message', () => {
    const m = toMessage(base) as LocalMessage;
    assert.equal(m.id, 'm1');
    assert.equal(m.text, 'hello');
    assert.equal(m.ts, 1000);
    assert.equal(m.updatedAt, 2000);
    assert.equal(m.authorName, 'alice');
    assert.equal(m.systemType, null);
  });

  test('an encrypted message NEVER stores its content', () => {
    const m = toMessage({ ...base, t: 'e2e', msg: 'blob-base64-opaque' }) as LocalMessage;
    assert.equal(m.systemType, 'e2e');
    assert.equal(m.text, null, 'the blob must not reach the database');
    assert.equal(m.md, null);
    assert.equal(m.attachments, null);
  });

  test('missing `_updatedAt` falls back to the message timestamp', () => {
    const { _updatedAt, ...without } = base;
    void _updatedAt;
    const m = toMessage(without) as LocalMessage;
    assert.equal(m.updatedAt, 1000);
  });

  test('a document without `_id`, `rid`, `ts` or author is rejected', () => {
    assert.equal(toMessage({ ...base, _id: undefined }), null);
    assert.equal(toMessage({ ...base, rid: undefined }), null);
    assert.equal(toMessage({ ...base, ts: undefined }), null);
    assert.equal(toMessage({ ...base, u: {} }), null);
  });

  test('`md` and `attachments` are serialized, `undefined` becomes null', () => {
    const m = toMessage({ ...base, md: [{ type: 'PARAGRAPH' }] }) as LocalMessage;
    assert.equal(m.md, '[{"type":"PARAGRAPH"}]');
    assert.equal(m.attachments, null);
  });

  test('`urls` (server link metadata) is serialized; missing → null', () => {
    const withValue = toMessage({ ...base, urls: [{ url: 'https://x', meta: { ogTitle: 'T' } }] }) as LocalMessage;
    assert.equal(withValue.urls, '[{"url":"https://x","meta":{"ogTitle":"T"}}]');
    assert.equal((toMessage(base) as LocalMessage).urls, null);
    // An encrypted room never stores a preview.
    assert.equal((toMessage({ ...base, t: 'e2e', urls: [{ url: 'https://x' }] }) as LocalMessage).urls, null);
  });

  test('threads: `tmid`, `tcount`, `tlm` and `tshow` are captured (8.3)', () => {
    const root = toMessage({
      ...base,
      tcount: 3,
      tlm: { $date: 5000 },
    }) as LocalMessage;
    assert.equal(root.threadCount, 3);
    assert.equal(root.threadLast, 5000);
    assert.equal(root.threadId, null);
    assert.equal(root.threadShown, false);

    const response = toMessage({ ...base, _id: 'm2', tmid: 'm1', tshow: true }) as LocalMessage;
    assert.equal(response.threadId, 'm1');
    assert.equal(response.threadShown, true, 'tshow = also visible in the main timeline');
  });
});

describe('toRoom', () => {
  test('an encrypted room exposes no preview', () => {
    const s = toRoom({
      _id: 'r1',
      t: 'p',
      name: 'laprivitude',
      encrypted: true,
      lastMessage: { msg: 'ciphertext', ts: { $date: 5 } },
      _updatedAt: { $date: 9 },
    }) as LocalRoom;
    assert.equal(s.encrypted, true);
    assert.equal(s.lastMessage, null, "an encrypted room's preview is ciphertext");
    assert.equal(s.lastMessageTs, 5, 'but its timestamp is used for sorting');
  });

  test('a message WITHOUT TEXT (attachment only) still yields a preview', () => {
    // Probed on 8.5: a message that is only a file has `msg: ''`. Without a
    // fallback, the list kept the preview of the PREVIOUS message: it announced
    // an exchange that was no longer the latest.
    const withoutCaption = toRoom({
      _id: 'r1',
      t: 'c',
      lastMessage: { msg: '', attachments: [{ title: 'photo.jpg' }] },
    }) as LocalRoom;
    assert.equal(withoutCaption.lastMessage, 'photo.jpg');

    const withCaption = toRoom({
      _id: 'r1',
      t: 'c',
      lastMessage: { msg: '', attachments: [{ title: 'photo.jpg', description: 'the cat' }] },
    }) as LocalRoom;
    assert.equal(withCaption.lastMessage, 'the cat', 'the caption wins over the file name');
  });

  test('EMPTIED room: `lastMessage` disappears, the preview must become null', () => {
    // Deleting the last message removes the field from the Room document. It is the
    // only signal available: the UPSERT uses it to CLEAR the preview.
    const s = toRoom({ _id: 'r1', t: 'c', lm: { $date: 5 } }) as LocalRoom;
    assert.equal(s.lastMessage, null);
    assert.equal(s.lastMessageTs, 5, 'but `lm` survives, and sorting with it');
  });

  test('`fname` wins over `name` for display', () => {
    const s = toRoom({ _id: 'r1', t: 'c', name: 'slug', fname: 'Display Name' }) as LocalRoom;
    assert.equal(s.displayName, 'Display Name');
    assert.equal(s.name, 'slug');
  });

  test('without `fname`, we fall back to `name`', () => {
    const s = toRoom({ _id: 'r1', t: 'c', name: 'slug' }) as LocalRoom;
    assert.equal(s.displayName, 'slug');
  });

  test('a DM without a name is named from `usernames`, excluding oneself', () => {
    // `rooms.get` returns DMs without `name` or `fname`: only `usernames`
    // can name them, and it ALSO contains the current user.
    const s = toRoom({ _id: 'r1', t: 'd', usernames: ['alice', 'bob'] }, 'alice') as LocalRoom;
    assert.equal(s.displayName, 'bob');
  });

  test('a DM with oneself keeps its own name', () => {
    const s = toRoom({ _id: 'r1', t: 'd', usernames: ['alice'] }, 'alice') as LocalRoom;
    assert.equal(s.displayName, 'alice');
  });

  test('a group DM joins the other participants', () => {
    const s = toRoom(
      { _id: 'r1', t: 'd', usernames: ['alice', 'bob', 'carol'] },
      'alice',
    ) as LocalRoom;
    assert.equal(s.displayName, 'bob, carol');
  });
});

describe('toRoom: dmOtherUid (8.4)', () => {
  test('extracts the other uid of a two-person DM; never for a group or without myUid', () => {
    const raw = { _id: 'r1', t: 'd', uids: ['me-uid', 'them-uid'], usernames: ['alice', 'bob'] };
    assert.equal(toRoom(raw, 'alice', 'me-uid')?.dmOtherUid, 'them-uid');
    // DM with oneself: the other one is me.
    assert.equal(
      toRoom({ ...raw, uids: ['me-uid'] }, 'alice', 'me-uid')?.dmOtherUid,
      'me-uid',
    );
    // GROUP DM (3+): not ONE presence to show.
    assert.equal(
      toRoom({ ...raw, uids: ['me-uid', 'them-uid', 'others-uid'] }, 'alice', 'me-uid')
        ?.dmOtherUid,
      null,
    );
    // Without myUid (old callers): null, no guessing.
    assert.equal(toRoom(raw, 'alice')?.dmOtherUid, null);
    // A channel never has one.
    assert.equal(toRoom({ ...raw, t: 'c' }, 'alice', 'me-uid')?.dmOtherUid, null);
  });

  test('ALSO extracts their username: without it, the avatar of a never-opened DM stays frozen', () => {
    // Seen on the emulator: the list shows alice's avatar while none of
    // her messages has been ingested. Since `updateAvatar` only designates the user
    // by username, it found NO row to update.
    const raw = { _id: 'r1', t: 'd', uids: ['me-uid', 'them-uid'], usernames: ['alice', 'bob'] };
    assert.equal(toRoom(raw, 'alice', 'me-uid')?.dmOtherUsername, 'bob');
    // DM with oneself: the other one is me, on both sides.
    assert.equal(
      toRoom({ ...raw, uids: ['me-uid'], usernames: ['alice'] }, 'alice', 'me-uid')
        ?.dmOtherUsername,
      'alice',
    );
    // No username without a paired uid: we do not invent an identity.
    assert.equal(toRoom({ ...raw, uids: undefined }, 'alice', 'me-uid')?.dmOtherUsername, null);
    assert.equal(toRoom({ ...raw, usernames: undefined }, 'alice', 'me-uid')?.dmOtherUsername, null);
  });
});

describe('toSubscription', () => {
  test('missing counters are 0, not NaN', () => {
    const a = toSubscription({ rid: 'r1' }) as LocalSubscription;
    assert.equal(a.unread, 0);
    assert.equal(a.mentions, 0);
    assert.equal(a.favorite, false);
    assert.equal(a.lastSeen, null);
  });
});

/** In-memory store: we observe what the engine decides to write. */
function makeStore() {
  const messages: LocalMessage[] = [];
  const rooms: LocalRoom[] = [];
  const subscriptions: LocalSubscription[] = [];
  const deleted: string[] = [];
  const deletedRooms: string[] = [];
  const deletedBySubId: string[] = [];
  const cursors = new Map<string, number>();
  /** Avatar versions written, key `u:<username>` or `r:<rid>`. */
  const avatars = new Map<string, string>();
  const identities: { uid: string; username: string; avatarEtag: string | null }[] = [];
  // The trap replays the `db/store.ts` invariant: during a transaction,
  // only writes through the received `tx` go through; the store's own throw.
  const store: Store = withTransactionTrap({
    upsertMessage: async (m) => void messages.push(m),
    upsertRoom: async (s) => void rooms.push(s),
    upsertSubscription: async (a) => void subscriptions.push(a),
    deleteMessage: async (id) => void deleted.push(id),
    deleteRoom: async (rid) => void deletedRooms.push(rid),
    deleteSubscription: async () => {},
    deleteBySubId: async (subId) => void deletedBySubId.push(subId),
    listKnownRids: async () => [],
    purgeMissingRooms: async () => {},
    applyRetention: async () => {},
    readCursor: async (p, f) => cursors.get(`${p}|${f}`) ?? null,
    writeCursor: async (p, f, v) => void cursors.set(`${p}|${f}`, v),
    lastMessageUpdatedAt: async () => null,
    listRoomKeys: async () =>
      subscriptions
        .filter((a): a is LocalSubscription & { e2eKey: string } => a.e2eKey !== null)
        .map((a) => ({ rid: a.rid, e2eKey: a.e2eKey })),
    messagesToDecrypt: async () =>
      messages
        .filter((m): m is LocalMessage & { encryptedRaw: string } => m.encryptedRaw !== null && m.text === null)
        .map((m) => ({ id: m.id, rid: m.rid, encryptedRaw: m.encryptedRaw })),
    updateMessageText: async (id, text, attachments) => {
      const m = messages.find((x) => x.id === id);
      if (m !== undefined) Object.assign(m, { text, attachments: attachments ?? m.attachments });
    },
    updateMessageMarks: async (id, pinned, starred) => {
      const m = messages.find((x) => x.id === id);
      if (m !== undefined) Object.assign(m, { pinned, starred });
    },
    clearRoomMessages: async (rid) => {
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.rid === rid && messages[i]!.updatedAt > 0) messages.splice(i, 1);
    },
    updateMessageStarred: async (id, starred) => {
      const m = messages.find((x) => x.id === id);
      if (m !== undefined) Object.assign(m, { starred });
    },
    updateThreadFollowers: async (id, threadFollowers) => {
      const m = messages.find((x) => x.id === id);
      if (m !== undefined) Object.assign(m, { threadFollowers });
    },
    hideEncryptedMessages: async () => {
      for (const m of messages) if (m.encryptedRaw !== null) Object.assign(m, { text: null, attachments: null });
    },
    updateEncryptedPreview: async () => {},
    updateUserAvatar: async (username, etag) => void avatars.set(`u:${username}`, etag),
    updateRoomAvatar: async (rid, etag) => void avatars.set(`r:${rid}`, etag),
    saveIdentity: async (i) => void identities.push(i),
  });
  return {
    store,
    messages,
    rooms,
    subscriptions,
    deleted,
    deletedRooms,
    deletedBySubId,
    avatars,
    identities,
  };
}

const event = (collection: string, eventKey: string, args: unknown[]): DdpEvent => ({
  collection,
  eventKey,
  args,
});

describe('SyncEngine', () => {
  test('a stream message is written', async () => {
    const { store, messages } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(
      event('stream-room-messages', 'r1', [
        { _id: 'm1', rid: 'r1', msg: 'hi', ts: { $date: 1 }, u: { _id: 'u1' } },
      ]),
    );
    assert.equal(messages.length, 1);
    assert.equal(engine.stats.messages, 1);
  });

  test('`subscriptions-changed` delivers [action, document]: the document is the SECOND argument', async () => {
    // Recorded against an 8.5 server: args[0] is the string "updated".
    // Treating args[0] as the document would silently drop every
    // subscription change, and so every unread counter.
    const { store, subscriptions } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(
      event('stream-notify-user', 'u1/subscriptions-changed', [
        'updated',
        { rid: 'r1', unread: 3, _updatedAt: { $date: 7 } },
      ]),
    );
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].unread, 3);
    assert.equal(engine.stats.ignores, 0);
  });

  test('the form without action is accepted too', async () => {
    const { store, subscriptions } = makeStore();
    await new SyncEngine(store, new RcTranslator()).apply(
      event('stream-notify-user', 'u1/subscriptions-changed', [{ rid: 'r1', unread: 1 }]),
    );
    assert.equal(subscriptions.length, 1);
  });

  test('`rooms-changed` writes a room', async () => {
    const { store, rooms } = makeStore();
    await new SyncEngine(store, new RcTranslator()).apply(
      event('stream-notify-user', 'u1/rooms-changed', ['updated', { _id: 'r1', t: 'c' }]),
    );
    assert.equal(rooms.length, 1);
  });

  test('`subscriptions-changed` action "removed" deletes by subId: no more ghost', async () => {
    // The historical bug: the 'removed' action was consumed then IGNORED, and
    // the document (just { _id }) attempted an upsert. A room deleted server-side
    // therefore stayed in the cache forever. Here we check the deletion.
    const { store, deletedBySubId, subscriptions } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(
      event('stream-notify-user', 'u1/subscriptions-changed', ['removed', { _id: 'sub1' }]),
    );
    assert.deepEqual(deletedBySubId, ['sub1']);
    assert.equal(subscriptions.length, 0, 'no upsert: the room does not come back to life');
    assert.equal(engine.stats.deletions, 1);
  });

  test('`rooms-changed` action "removed" deletes the room', async () => {
    const { store, deletedRooms, rooms } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(
      event('stream-notify-user', 'u1/rooms-changed', ['removed', { _id: 'r1' }]),
    );
    assert.deepEqual(deletedRooms, ['r1']);
    assert.equal(rooms.length, 0);
    assert.equal(engine.stats.deletions, 1);
  });

  test('`deleteMessage` deletes', async () => {
    const { store, deleted } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(event('stream-notify-room', 'r1/deleteMessage', [{ _id: 'm1' }]));
    assert.deepEqual(deleted, ['m1']);
    assert.equal(engine.stats.deletions, 1);
  });

  test('`updateAvatar` sets the photo version of a user, by USERNAME', async () => {
    // The stream never designates the user by uid (recorded on 8.5):
    // that is what forces indexing versions by username TOO.
    const { store, avatars } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(
      event('stream-notify-logged', 'updateAvatar', [{ username: 'bob', etag: 'e1' }]),
    );
    assert.equal(avatars.get('u:bob'), 'e1');
    assert.equal(engine.stats.ignores, 0, 'an avatar is not an anomaly');
  });

  test('`updateAvatar` of a ROOM targets the rid', async () => {
    const { store, avatars } = makeStore();
    await new SyncEngine(store, new RcTranslator()).apply(
      event('stream-notify-logged', 'updateAvatar', [{ rid: 'r1', etag: 'e2' }]),
    );
    assert.equal(avatars.get('r:r1'), 'e2');
  });

  test('a REMOVED photo (missing etag) still sets a marker', async () => {
    // `users.resetAvatar` sends no etag. Without a marker, the URL would fall back
    // to its previous form, the one the image cache serves with the OLD
    // photo: the deleted avatar would stay displayed.
    const { store, avatars } = makeStore();
    await new SyncEngine(store, new RcTranslator()).apply(
      event('stream-notify-logged', 'updateAvatar', [{ username: 'bob' }]),
    );
    assert.equal(avatars.get('u:bob'), AVATAR_NO_PHOTO);
  });

  test('presence goes through the same stream but is NOT an anomaly', async () => {
    const { store } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(
      event('stream-notify-logged', 'user-status', [['u1', 'alice', 1, '']]),
    );
    assert.equal(engine.stats.ignores, 0, 'otherwise each round trip inflates the counter');
  });

  test('an unknown stream is ignored, but counted', async () => {
    const { store } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(event('stream-livechat-inquiry', 'x', [{}]));
    await engine.apply(event('stream-notify-user', 'u1/webrtc', ['updated', {}]));
    assert.equal(engine.stats.ignores, 2, 'ignored does not mean invisible');
  });

  test('a malformed payload does not interrupt the stream', async () => {
    const { store, messages } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.apply(event('stream-room-messages', 'r1', ['not an object']));
    await engine.apply(event('stream-room-messages', 'r1', [{ _id: 'no-rid' }]));
    assert.equal(messages.length, 0);
    assert.equal(engine.stats.ignores, 2);
  });

  test('a REST batch goes through the same upserts as the WebSocket', async () => {
    const { store, messages } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator());
    await engine.ingestMessages([
      { _id: 'm1', rid: 'r1', msg: 'a', ts: { $date: 1 }, u: { _id: 'u1' } },
      { _id: 'm2', rid: 'r1', msg: 'b', ts: { $date: 2 }, u: { _id: 'u1' } },
      { not: 'a message' },
    ]);
    assert.equal(messages.length, 2);
    assert.equal(engine.stats.ignores, 1);
  });
});

/** `rc.v2.aes-sha2` encrypted message: ciphertext in `content`, empty `msg`. */
const encryptedMsg = (id: string, ct: string): Record<string, unknown> => ({
  _id: id,
  rid: 'r1',
  t: 'e2e',
  msg: '',
  ts: { $date: 1 },
  u: { _id: 'u1' },
  content: { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: 'iv', ciphertext: ct },
  _updatedAt: 1,
});

describe('SyncEngine: E2EE decryption', () => {
  test('decrypts at ingestion when the key is available', async () => {
    const { store, messages } = makeStore();
    const decryptor: E2EDecryptor = {
      decryptContent: (_rid, content) =>
        content.ciphertext === 'CT' ? { text: 'plaintext!', attachments: null } : null,
      saveRoomKey: () => {},
    };
    const engine = new SyncEngine(store, new RcTranslator('me', 'uid'), decryptor);
    await engine.ingestMessages([encryptedMsg('m1', 'CT')]);
    assert.equal(messages[0].text, 'plaintext!');
    assert.notEqual(messages[0].encryptedRaw, null); // ciphertext kept
  });

  test('locked: stays unreadable, then the unlock pass makes it readable', async () => {
    const { store, messages } = makeStore();
    let unlocked = false;
    const decryptor: E2EDecryptor = {
      decryptContent: (_rid, content) =>
        unlocked && content.ciphertext === 'CT' ? { text: 'plaintext!', attachments: null } : null,
      saveRoomKey: () => {},
    };
    const engine = new SyncEngine(store, new RcTranslator('me', 'uid'), decryptor);
    await engine.ingestMessages([encryptedMsg('m1', 'CT')]);
    assert.equal(messages[0].text, null); // locked → placeholder

    unlocked = true;
    const n = await engine.e2eUnlocked();
    assert.equal(n, 1);
    assert.equal(messages[0].text, 'plaintext!');
  });

  test('an encrypted file: its attachments come from the plaintext, at ingestion as at unlock', async () => {
    const attachments = JSON.stringify([{ title: 'photo.jpg', encryption: { iv: 'aXY=' } }]);
    const { store, messages } = makeStore();
    let unlocked = false;
    const decryptor: E2EDecryptor = {
      decryptContent: () => (unlocked ? { text: '', attachments } : null),
      saveRoomKey: () => {},
    };
    const engine = new SyncEngine(store, new RcTranslator('me', 'uid'), decryptor);
    await engine.ingestMessages([{ ...encryptedMsg('m1', 'CT'), attachments: [{ title: 'hashed.bin' }] }]);
    assert.equal(messages[0].attachments, null, 'never the server ones, opaque');

    unlocked = true;
    await engine.e2eUnlocked();
    assert.equal(messages[0].attachments, attachments);

    await engine.ingestMessages([encryptedMsg('m2', 'CT')]);
    assert.equal(messages[1].attachments, attachments);
  });

  test('without a decryptor, an encrypted message keeps its ciphertext and stays unreadable', async () => {
    const { store, messages } = makeStore();
    const engine = new SyncEngine(store, new RcTranslator('me', 'uid')); // no decryptor
    await engine.ingestMessages([encryptedMsg('m1', 'CT')]);
    assert.equal(messages[0].text, null);
    assert.notEqual(messages[0].encryptedRaw, null);
    assert.equal(await engine.e2eUnlocked(), 0);
  });
});
