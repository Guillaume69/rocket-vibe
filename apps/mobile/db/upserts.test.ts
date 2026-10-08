import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { toRoom } from '../lib/normalize.ts';
import type { LocalSubscription, LocalMessage, LocalRoom } from '../lib/normalize.ts';
import {
  APPLY_RETENTION,
  INSERT_CUSTOM_EMOJI,
  INSERT_OUTBOX,
  INSERT_UPLOAD,
  READ_DRAFT,
  READ_CURSOR,
  LIST_KNOWN_RIDS,
  DELETE_DRAFT,
  DELETE_ROOM_DRAFTS,
  DELETE_ROOM_CURSORS,
  DELETE_ROOM_OUTBOX,
  DELETE_ROOM_UPLOADS,
  UPSERT_DRAFT,
  RECORD_EMOJI_USE,
  PRUNE_EMOJI_USAGE,
  LIST_EMOJI_USAGE,
  LIST_CUSTOM_EMOJIS,
  LIST_OUTBOX_TO_SEND,
  LIST_UPLOADS_TO_SEND,
  MARK_OUTBOX_FAILED,
  MARK_UPLOAD_FAILED,
  MARK_UPLOAD_IN_FLIGHT,
  MESSAGE_WITH_FILE,
  RECORD_FILE_ID,
  REARM_UPLOAD,
  REARM_IN_FLIGHT_UPLOADS,
  DELETE_UPLOAD,
  PURGE_MISSING_SUBSCRIPTIONS,
  PURGE_MISSING_DRAFTS,
  PURGE_MISSING_CURSORS,
  PURGE_MISSING_MESSAGES,
  PURGE_MISSING_ROOMS,
  PURGE_MISSING_OUTBOX,
  PURGE_MISSING_UPLOADS,
  UPDATE_ENCRYPTED_PREVIEW,
  HIDE_ENCRYPTED_PREVIEW,
  UPDATE_MESSAGE_TEXT,
  HIDE_ENCRYPTED_MESSAGES,
  UPDATE_ROOM_AVATAR,
  UPDATE_MESSAGE_MARKS,
  UPDATE_USER_AVATAR,
  DELETE_MESSAGE,
  DELETE_OPTIMISTIC_MESSAGE,
  DELETE_OUTBOX,
  UPSERT_SUBSCRIPTION,
  UPSERT_CURSOR,
  UPSERT_IDENTITY,
  UPSERT_MESSAGE,
  UPSERT_ROOM,
  UPSERT_USER,
  CLEAR_CUSTOM_EMOJIS,
  subscriptionParams,
  customEmojiParams,
  identityParams,
  messageParams,
  roomParams,
  userParams,
} from './upserts.ts';

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * `node:sqlite` returns `null`-prototype objects, which `assert.deepEqual` in
 * strict mode refuses to compare to a literal. We flatten them.
 */
function row(v: unknown): Record<string, unknown> {
  return { ...(v as Record<string, unknown>) };
}

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(FOLDER).filter((x) => x.endsWith('.sql')).sort()) {
    for (const r of readFileSync(join(FOLDER, f), 'utf8').split('--> statement-breakpoint')) {
      if (r.trim() !== '') db.exec(r.trim());
    }
  }
  return db;
}

/**
 * Parameters are built with `messageParams` from `db/upserts.ts`, the very
 * function the app uses: a column order drifting from the value order would
 * fail these tests, instead of silently corrupting the database.
 */
function msg(o: Partial<LocalMessage> & { id: string; updatedAt: number }) {
  return messageParams({
    rid: 'rid-1',
    text: 'hello',
    ts: 1000,
    authorId: 'u1',
    authorName: 'alice',
    systemType: null,
    threadId: null,
    threadCount: 0,
    threadLast: null,
    threadShown: false,
    editedAt: null,
    md: null,
    attachments: null,
    reactions: null,
    urls: null,
    callId: null,
    encryptedRaw: null,
    pinned: false,
    starred: null,
    ...o,
  });
}

function room(o: Partial<LocalRoom> & { rid: string; updatedAt: number }) {
  return roomParams({
    type: 'c',
    name: 'name',
    displayName: 'name',
    encrypted: false,
    readOnly: false,
    dmOtherUid: null,
    dmOtherUsername: null,
    lastMessage: null,
    lastMessageType: null,
    lastMessageTs: null,
    avatarEtag: null,
    ...o,
  });
}

function sub(o: Partial<LocalSubscription> & { rid: string; updatedAt: number }) {
  return subscriptionParams({
    subId: null,
    unread: 0,
    mentions: 0,
    groupMentions: 0,
    alert: false,
    open: true,
    favorite: false,
    lastSeen: null,
    e2eKey: null,
    e2eKeyId: null,
    roles: null,
    groupId: null,
    groupName: null,
    groupRank: null,
    ...o,
  });
}

let db: DatabaseSync;
beforeEach(() => {
  db = migratedDb();
});

describe('upserts idempotents', () => {
  test('replaying the same message creates no duplicate', () => {
    const p = msg({ id: 'm1', updatedAt: 100 });
    db.prepare(UPSERT_MESSAGE).run(...p);
    db.prepare(UPSERT_MESSAGE).run(...p);
    db.prepare(UPSERT_MESSAGE).run(...p);
    const n = db.prepare('SELECT count(*) c FROM messages').get() as { c: number };
    assert.equal(n.c, 1);
  });

  test('a more recent event does update the message', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'v1', updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'v2', updatedAt: 200 }));
    const m = row(db.prepare('SELECT text, updated_at FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { text: 'v2', updated_at: 200 });
  });

  test('an OLDER event does not overwrite a more recent state', () => {
    // Real scenario: a REST catch-up, started after a reconnection, delivers the
    // version of a message that the WebSocket has updated since.
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'recent', updatedAt: 200 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'old', updatedAt: 100 }));
    const m = row(db.prepare('SELECT text, updated_at FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { text: 'recent', updated_at: 200 }, 'the past must not win');
  });

  test('threads (8.3): threadLast and threadShown round-trip, NON-default values', () => {
    // Guard against silently swapping two neighbouring parameters of the same
    // type in messageParams: only distinct, non-default values detect it.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({
        id: 'm1',
        threadId: 'root',
        threadCount: 7,
        threadLast: 4242,
        threadShown: true,
        editedAt: 9999,
        updatedAt: 100,
      }),
    );
    const m = row(
      db
        .prepare(
          'SELECT thread_id, thread_count, thread_last, thread_shown, edited_at FROM messages WHERE id = ?',
        )
        .get('m1'),
    );
    assert.deepEqual(m, {
      thread_id: 'root',
      thread_count: 7,
      thread_last: 4242,
      thread_shown: 1,
      edited_at: 9999,
    });
  });

  test('call message: the callId round-trips through the database', () => {
    // The `callId` is NOT the message's `_id`: it must be persisted separately
    // so the "Join" button knows which call to open.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', systemType: 'videoconf', callId: 'call-xyz', updatedAt: 100 }),
    );
    const m = row(
      db.prepare('SELECT system_type, call_id FROM messages WHERE id = ?').get('m1'),
    );
    assert.deepEqual(m, { system_type: 'videoconf', call_id: 'call-xyz' });
  });

  test('pinning and stars: round trip, then local set overwritten by the next server version', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', pinned: true, starred: '["u1"]', updatedAt: 100 }),
    );
    const read = () =>
      row(db.prepare('SELECT pinned, starred, updated_at FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(read(), { pinned: 1, starred: '["u1"]', updated_at: 100 });

    db.prepare(UPDATE_MESSAGE_MARKS).run(0, null, 'm1');
    assert.deepEqual(read(), { pinned: 0, starred: null, updated_at: 100 });

    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', pinned: true, starred: '["u2"]', updatedAt: 101 }),
    );
    assert.deepEqual(read(), { pinned: 1, starred: '["u2"]', updated_at: 101 });
  });

  test('an event with the same timestamp is applied (idempotent replay)', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'a', updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'b', updatedAt: 100 }));
    const m = row(db.prepare('SELECT text FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { text: 'b' }, '>= and not >: two writes in the same ms');
  });

  test('a room written without its last message keeps the stored preview', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', lastMessage: 'hello', lastMessageType: null, lastMessageTs: 1, updatedAt: 1 }));
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', lastMessage: null, lastMessageTs: 2, keepPreview: true, updatedAt: 2 }));
    assert.deepEqual(row(db.prepare('SELECT last_message, last_message_ts FROM rooms WHERE rid = ?').get('r1')), { last_message: 'hello', last_message_ts: 2 });
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', lastMessage: null, lastMessageTs: 3, updatedAt: 3 }));
    assert.deepEqual(row(db.prepare('SELECT last_message FROM rooms WHERE rid = ?').get('r1')), { last_message: null });
  });

  test('rooms follow the same precedence rule', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', name: 'recent', updatedAt: 200 }));
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', name: 'old', updatedAt: 100 }));
    const s = row(db.prepare('SELECT name FROM rooms WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { name: 'recent' });
  });

  test('a MORE RECENT partial document erases neither the name nor the timestamp', () => {
    // `rooms-changed` sometimes delivers a document without `usernames`: toRoom
    // then returns a null `displayName`. It means "absent", not "erase": a DM's
    // derived name must survive. Same for the timestamp, which drives the list's
    // sort.
    db.prepare(UPSERT_ROOM).run(
      ...room({
        rid: 'r1',
        displayName: 'bob',
        lastMessage: 'hi',
        lastMessageTs: 50,
        updatedAt: 100,
      }),
    );
    db.prepare(UPSERT_ROOM).run(
      ...room({
        rid: 'r1',
        displayName: null,
        lastMessage: 'hi',
        lastMessageTs: null,
        updatedAt: 200,
      }),
    );
    const s = row(
      db
        .prepare(
          'SELECT display_name, last_message_ts, updated_at FROM rooms WHERE rid = ?',
        )
        .get('r1'),
    );
    assert.deepEqual(s, {
      display_name: 'bob',
      last_message_ts: 50,
      updated_at: 200,
    });
  });

  test('EMPTIED room: a missing preview ERASES the preview, it does not preserve it', () => {
    // Deleting a room's last message removes `lastMessage` from the Room
    // document: it is the ONLY signal that a room was emptied (probed on 8.5,
    // stream and `rooms.get`). Preserving it froze the deleted message in the
    // list for life: no catch-up could dislodge it anymore.
    db.prepare(UPSERT_ROOM).run(
      ...room({ rid: 'r1', lastMessage: 'the last one', updatedAt: 100 }),
    );
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', lastMessage: null, updatedAt: 200 }));
    const s = row(db.prepare('SELECT last_message FROM rooms WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { last_message: null });
  });

  test('ENCRYPTED room: the server cannot erase a preview it knows nothing about', () => {
    // The server only holds ciphertext: `toRoom` always returns null for an
    // encrypted room. Its preview comes from UPDATE_ENCRYPTED_PREVIEW, on the
    // locally decrypted messages; a `rooms-changed` must not sweep it away in
    // passing.
    db.prepare(UPSERT_ROOM).run(
      ...room({ rid: 'r1', encrypted: true, lastMessage: 'local plaintext', updatedAt: 100 }),
    );
    db.prepare(UPSERT_ROOM).run(
      ...room({ rid: 'r1', encrypted: true, lastMessage: null, updatedAt: 200 }),
    );
    const s = row(db.prepare('SELECT last_message FROM rooms WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { last_message: 'local plaintext' });
  });

  test('a more recent non-null name does replace the old one', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', displayName: 'before', updatedAt: 100 }));
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', displayName: 'after', updatedAt: 200 }));
    const s = row(db.prepare('SELECT display_name FROM rooms WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { display_name: 'after' });
  });

  test('subscriptions too: unread counts reset to zero do not reappear', () => {
    db.prepare(UPSERT_SUBSCRIPTION).run(...sub({ rid: 'r1', unread: 0, updatedAt: 200 })); // I just read it
    db.prepare(UPSERT_SUBSCRIPTION).run(...sub({ rid: 'r1', unread: 7, updatedAt: 100 })); // catch-up
    const a = row(db.prepare('SELECT unread FROM subscriptions WHERE rid = ?').get('r1'));
    assert.deepEqual(a, { unread: 0 });
  });

  test('room roles: a document without roles keeps them, an empty list removes them', () => {
    const read = () => row(db.prepare('SELECT roles FROM subscriptions WHERE rid = ?').get('r1'));
    db.prepare(UPSERT_SUBSCRIPTION).run(...sub({ rid: 'r1', roles: '["owner"]', updatedAt: 100 }));
    db.prepare(UPSERT_SUBSCRIPTION).run(...sub({ rid: 'r1', roles: null, updatedAt: 200 }));
    assert.deepEqual(read(), { roles: '["owner"]' });
    db.prepare(UPSERT_SUBSCRIPTION).run(...sub({ rid: 'r1', roles: '[]', updatedAt: 300 }));
    assert.deepEqual(read(), { roles: '[]' });
  });

  test('a catch-up cursor never goes back', () => {
    db.prepare(UPSERT_CURSOR).run('r1', 'messages', 500);
    db.prepare(UPSERT_CURSOR).run('r1', 'messages', 300);
    const c = row(
      db
        .prepare('SELECT updated_since FROM cursors WHERE scope = ? AND stream = ?')
        .get('r1', 'messages'),
    );
    assert.deepEqual(c, { updated_since: 500 }, 'a regressing cursor downloads everything again');

    db.prepare(UPSERT_CURSOR).run('r1', 'messages', 700);
    const d = row(
      db
        .prepare('SELECT updated_since FROM cursors WHERE scope = ? AND stream = ?')
        .get('r1', 'messages'),
    );
    assert.deepEqual(d, { updated_since: 700 });
  });

  test('two streams of the same room have independent cursors', () => {
    db.prepare(UPSERT_CURSOR).run('r1', 'messages', 500);
    db.prepare(UPSERT_CURSOR).run('r1', 'subscriptions', 100);
    const n = db.prepare('SELECT count(*) c FROM cursors').get() as { c: number };
    assert.equal(n.c, 2);
  });

  test('deletion is idempotent', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', updatedAt: 100 }));
    db.prepare(DELETE_MESSAGE).run('m1');
    db.prepare(DELETE_MESSAGE).run('m1'); // must not throw
    const n = db.prepare('SELECT count(*) c FROM messages').get() as { c: number };
    assert.equal(n.c, 0);
  });

  test('an optimistic message (updated_at = 0) is ALWAYS overwritten by the server', () => {
    // The optimistic UI inserts with 0: any server version (>= 0) must win, and
    // the optimistic one must never overwrite a real version.
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'optimistic', updatedAt: 0 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'server', updatedAt: 5 }));
    let m = row(db.prepare('SELECT text FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { text: 'server' });

    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'optimistic-replayed', updatedAt: 0 }));
    m = row(db.prepare('SELECT text FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { text: 'server' }, "the optimistic one never downgrades the real one");
  });

  test('the server `ts` corrects the optimistic timestamp (suspicious local clock)', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ts: 9999, updatedAt: 0 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ts: 5000, updatedAt: 7 }));
    const m = row(db.prepare('SELECT ts FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { ts: 5000 }, 'without this, the sort would stay wrong forever');
  });

  test('discarding only erases a message that is still optimistic', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', updatedAt: 0 }));
    db.prepare(DELETE_OPTIMISTIC_MESSAGE).run('m1');
    assert.equal(db.prepare('SELECT count(*) c FROM messages').get()!.c, 0);

    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm2', updatedAt: 42 })); // delivered
    db.prepare(DELETE_OPTIMISTIC_MESSAGE).run('m2');
    assert.equal(
      db.prepare('SELECT count(*) c FROM messages').get()!.c,
      1,
      'a delivered message cannot be discarded',
    );
  });
});

describe('outbox', () => {
  test('the cycle pending -> failed -> resend -> deleted', () => {
    db.prepare(INSERT_OUTBOX).run('a'.repeat(24), 'r1', 'hello', null, 1000);

    let wait = db.prepare(LIST_OUTBOX_TO_SEND).all().map(row);
    assert.equal(wait.length, 1);
    assert.equal(wait[0].status, 'pending');

    db.prepare(MARK_OUTBOX_FAILED).run('500 oops', 'a'.repeat(24));
    wait = db.prepare(LIST_OUTBOX_TO_SEND).all().map(row);
    assert.equal(wait.length, 1, 'a failure stays a replay candidate');
    assert.equal(wait[0].status, 'failed');
    assert.equal(wait[0].attempts, 1);

    db.prepare(DELETE_OUTBOX).run('a'.repeat(24));
    assert.equal(db.prepare(LIST_OUTBOX_TO_SEND).all().length, 0);
  });

  test('the replay lists in creation order', () => {
    db.prepare(INSERT_OUTBOX).run('b'.repeat(24), 'r1', 'second', null, 2000);
    db.prepare(INSERT_OUTBOX).run('c'.repeat(24), 'r1', 'first', null, 1000);
    const orders = db.prepare(LIST_OUTBOX_TO_SEND).all().map((l) => row(l).text);
    assert.deepEqual(orders, ['first', 'second']);
  });
});

/**
 * The FILE queue was exercised by no test: `db/store.ts` returned
 * `getAllAsync` directly as `UploadRow[]`, a type assertion nothing checked:
 * a column renamed in the SQL would have produced silent `undefined`s all the
 * way into the uploaded URI.
 *
 * Here we insert with EXACTLY the parameters `db/store.ts` passes, in the
 * same order; a mismatch between column order and value order fails these
 * tests instead of corrupting the database.
 */
function upload(o: Partial<Record<string, unknown>> & { id: string }) {
  const v = { rid: 'r1', uri: 'file:///a.png', name: 'a.png', type: 'image/png', caption: null, createdAt: 1000, tmid: null, ...o };
  return [v.id, v.rid, v.uri, v.name, v.type, v.caption, v.createdAt, v.tmid ?? null] as const;
}

describe('upload queue', () => {
  test('the columns read back are EXACTLY those of the `UploadRow` type', () => {
    db.prepare(INSERT_UPLOAD).run(
      ...upload({ id: 't1', caption: 'my caption', uri: 'file:///photo.jpg' }),
    );
    const rows = db.prepare(LIST_UPLOADS_TO_SEND).all().map(row);
    assert.equal(rows.length, 1);
    // deepEqual and not a series of `equal`: an EXTRA column fails it too. It is
    // the only safeguard against db/store.ts's cast.
    assert.deepEqual(rows[0], {
      id: 't1',
      rid: 'r1',
      uri: 'file:///photo.jpg',
      name: 'a.png',
      type: 'image/png',
      caption: 'my caption',
      tmid: null,
      status: 'pending',
      // SNAKE column: `db/store.ts` must map it to `fileId`, as it already does
      // for `thread_id` in the outbox.
      file_id: null,
    });
  });

  test('a missing caption stays NULL, not the string "null"', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 't1' }));
    const l = row(db.prepare(LIST_UPLOADS_TO_SEND).all()[0]);
    assert.equal(l.caption, null, 'the engine passes `caption ?? undefined` to confirm');
  });

  /**
   * The heart of the finding: a failure must NO LONGER restart on its own.
   * This test forbids going back to `status IN ('pending','failed')`.
   */
  test('a failure leaves the automatic replay and only comes back through "Retry"', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 't1' }));
    assert.equal(db.prepare(LIST_UPLOADS_TO_SEND).all().length, 1);

    db.prepare(MARK_UPLOAD_FAILED).run('413 too large', 't1');
    assert.equal(
      db.prepare(LIST_UPLOADS_TO_SEND).all().length,
      0,
      'otherwise the refused video pushes all its bytes again at every connection setup',
    );
    // The row still EXISTS: it is what the banner shows.
    const stayed = row(db.prepare('SELECT status, last_error FROM uploads WHERE id = ?').get('t1'));
    assert.equal(stayed.status, 'failed');
    assert.equal(stayed.last_error, '413 too large', "the reason is kept for the UI");

    db.prepare(REARM_UPLOAD).run('t1');
    const rearmed = db.prepare(LIST_UPLOADS_TO_SEND).all().map(row);
    assert.equal(rearmed.length, 1, '"Retry" puts it back in the queue');
    assert.equal(rearmed[0].status, 'pending');
    const after = row(db.prepare('SELECT last_error FROM uploads WHERE id = ?').get('t1'));
    assert.equal(after.last_error, null, 'a stale error must not stay displayed');

    db.prepare(DELETE_UPLOAD).run('t1');
    assert.equal(db.prepare(LIST_UPLOADS_TO_SEND).all().length, 0);
  });

  test('a claimed row (`sending`) leaves the listing: never two uploads of the same file', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 't1' }));
    const taken = db.prepare(MARK_UPLOAD_IN_FLIGHT).run('t1');
    assert.equal(taken.changes, 1);
    assert.equal(db.prepare(LIST_UPLOADS_TO_SEND).all().length, 0);
  });

  test('two concurrent passes: the second claim changes NO row', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 't1' }));
    assert.equal(db.prepare(MARK_UPLOAD_IN_FLIGHT).run('t1').changes, 1);
    assert.equal(
      db.prepare(MARK_UPLOAD_IN_FLIGHT).run('t1').changes,
      0,
      'the `AND status = pending` guard makes the claim atomic',
    );
  });

  test('an orphaned `sending` from a killed process is re-armed, not lost', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 't1' }));
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 't2' }));
    db.prepare(MARK_UPLOAD_IN_FLIGHT).run('t1');
    db.prepare(MARK_UPLOAD_FAILED).run('refused', 't2');

    db.prepare(REARM_IN_FLIGHT_UPLOADS).run(JSON.stringify([]));

    const ids = db.prepare(LIST_UPLOADS_TO_SEND).all().map((l) => row(l).id);
    assert.deepEqual(ids, ['t1'], 'the kill is repaired...');
    const t2 = row(db.prepare('SELECT status FROM uploads WHERE id = ?').get('t2'));
    assert.equal(t2.status, 'failed', '...without reviving failures, which stay a terminus');
  });

  /**
   * The re-arm bound. `SyncProvider` can build a second engine without
   * stopping the first; without this exclusion, the new one would hand back
   * to the replay a row whose bytes the old one is still pushing: two uploads,
   * two confirms, and the server does post TWO messages (probed on 8.5).
   */
  test('a row still in flight in THIS runtime is NOT re-armed', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 'enVol' }));
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 'orphan' }));
    db.prepare(MARK_UPLOAD_IN_FLIGHT).run('enVol');
    db.prepare(MARK_UPLOAD_IN_FLIGHT).run('orphan');

    db.prepare(REARM_IN_FLIGHT_UPLOADS).run(JSON.stringify(['enVol']));

    const ids = db.prepare(LIST_UPLOADS_TO_SEND).all().map((l) => row(l).id);
    assert.deepEqual(ids, ['orphan'], 'only the orphan goes again');
    const survivor = row(db.prepare('SELECT status FROM uploads WHERE id = ?').get('enVol'));
    assert.equal(survivor.status, 'sending', 'the in-flight row keeps its claim');
  });

  test('the replay order breaks ties between creations in the same millisecond', () => {
    // `app/share.tsx` inserts N items in a tight loop: `Date.now()` may return
    // the same value for several.
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 'b', name: 'two', createdAt: 7 }));
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 'a', name: 'one', createdAt: 7 }));
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 'c', name: 'three', createdAt: 8 }));
    const names = db.prepare(LIST_UPLOADS_TO_SEND).all().map((l) => row(l).name);
    assert.deepEqual(names, ['one', 'two', 'three'], 'total order, never undefined');
  });

  test('the `file_id` from `rooms.media` is persisted and read back', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 't1' }));
    db.prepare(RECORD_FILE_ID).run('abc123', 't1');
    const l = row(db.prepare(LIST_UPLOADS_TO_SEND).all()[0]);
    assert.equal(l.file_id, 'abc123', 'without it, the bytes would go out again on replay');
  });

  test('"has this file already been posted?" is read from `attachments`, without network', () => {
    // The message the server created at the `mediaConfirm` whose response was
    // lost: delivered by the DDP stream like any other.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({
        id: 'm1',
        updatedAt: 5,
        attachments: JSON.stringify([
          { title: 'photo.jpg', title_link: '/file-upload/abc123/photo.jpg' },
        ]),
      }),
    );

    assert.ok(
      db.prepare(MESSAGE_WITH_FILE).get('rid-1', 'abc123') !== undefined,
      'the fileId is in the attachment\'s title_link',
    );
    assert.equal(
      db.prepare(MESSAGE_WITH_FILE).get('rid-1', 'never-seen'),
      undefined,
      'an unposted file must not pass for a duplicate',
    );
    assert.equal(
      db.prepare(MESSAGE_WITH_FILE).get('other-room', 'abc123'),
      undefined,
      'the search is bounded to the room',
    );
  });

  test('the replay lists in creation order, not in id order', () => {
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 'zzz', name: 'first', createdAt: 1000 }));
    db.prepare(INSERT_UPLOAD).run(...upload({ id: 'aaa', name: 'second', createdAt: 2000 }));
    const names = db.prepare(LIST_UPLOADS_TO_SEND).all().map((l) => row(l).name);
    assert.deepEqual(names, ['first', 'second']);
  });

  test('marking an unknown row as failed creates nothing', () => {
    db.prepare(MARK_UPLOAD_FAILED).run('oops', 'ghost');
    assert.equal(db.prepare(LIST_UPLOADS_TO_SEND).all().length, 0);
  });
});

describe('emojis custom', () => {
  test('round trip: inserted then read back, aliases preserved as JSON', () => {
    db.prepare(INSERT_CUSTOM_EMOJI).run(
      ...customEmojiParams({ name: 'party_parrot', extension: 'gif', aliases: ['parrot'], updatedAt: 10 }),
    );
    db.prepare(INSERT_CUSTOM_EMOJI).run(
      ...customEmojiParams({ name: 'shipit', extension: 'png', aliases: [], updatedAt: 10 }),
    );
    const rows = db.prepare(LIST_CUSTOM_EMOJIS).all().map(row);
    assert.equal(rows.length, 2);
    const parrot = rows.find((l) => l.name === 'party_parrot');
    assert.equal(parrot?.extension, 'gif');
    assert.deepEqual(JSON.parse(parrot?.aliases as string), ['parrot']);
  });

  test('CLEARING erases everything: the bulk replacement leaves no ghost', () => {
    db.prepare(INSERT_CUSTOM_EMOJI).run(
      ...customEmojiParams({ name: 'obsolete', extension: 'png', aliases: [], updatedAt: 1 }),
    );
    db.prepare(CLEAR_CUSTOM_EMOJIS).run();
    assert.equal(db.prepare(LIST_CUSTOM_EMOJIS).all().length, 0);
  });
});

describe('purge of ghost rooms (reconciliation)', () => {
  const rids = (table: string): string[] =>
    (db.prepare(`SELECT rid FROM ${table} ORDER BY rid`).all() as { rid: string }[]).map(
      (l) => l.rid,
    );
  const ids = (table: string): string[] =>
    (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((l) => l.id);

  /** The seven DELETEs, in the order the store runs them. */
  function purge(known: string[], alive: string[]): void {
    const c = JSON.stringify(known);
    const v = JSON.stringify(alive);
    for (const sql of [
      PURGE_MISSING_ROOMS,
      PURGE_MISSING_SUBSCRIPTIONS,
      PURGE_MISSING_MESSAGES,
      PURGE_MISSING_OUTBOX,
      PURGE_MISSING_UPLOADS,
      PURGE_MISSING_DRAFTS,
      PURGE_MISSING_CURSORS,
    ]) {
      db.prepare(sql).run(c, v);
    }
  }

  test('erases room, subscription AND messages whose rid is no longer live', () => {
    for (const rid of ['r1', 'r2', 'r3']) {
      db.prepare(UPSERT_ROOM).run(...room({ rid, updatedAt: 100 }));
      db.prepare(UPSERT_SUBSCRIPTION).run(...sub({ rid, updatedAt: 100 }));
      db.prepare(UPSERT_MESSAGE).run(...msg({ id: `m-${rid}`, rid, updatedAt: 100 }));
    }
    purge(['r1', 'r2', 'r3'], ['r1']);

    assert.deepEqual(rids('rooms'), ['r1'], 'only the live room remains');
    assert.deepEqual(rids('subscriptions'), ['r1']);
    assert.deepEqual(ids('messages'), ['m-r1'], 'orphaned messages go too');
  });

  test('keeps several live rids, purges the rest', () => {
    for (const rid of ['r1', 'r2', 'r3', 'r4']) {
      db.prepare(UPSERT_ROOM).run(...room({ rid, updatedAt: 100 }));
    }
    purge(['r1', 'r2', 'r3', 'r4'], ['r1', 'r3']);
    assert.deepEqual(rids('rooms'), ['r1', 'r3']);
  });

  test('a room CREATED during the network request is not erased', () => {
    // The snapshot is taken before the round trip: it only knows r1 and r2.
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', updatedAt: 100 }));
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r2', updatedAt: 100 }));
    const known = ['r1', 'r2'];
    // ...then the DDP stream writes a brand new DM during the flight. It is
    // neither among the live ones (the server had already answered), nor among
    // the known ones.
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r3', updatedAt: 200 }));
    db.prepare(UPSERT_SUBSCRIPTION).run(...sub({ rid: 'r3', updatedAt: 200 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm-r3', rid: 'r3', updatedAt: 200 }));

    purge(known, ['r1']);

    assert.deepEqual(rids('rooms'), ['r1', 'r3'], 'the DM that arrived in flight survives');
    assert.deepEqual(rids('subscriptions'), ['r3']);
    assert.deepEqual(ids('messages'), ['m-r3']);
  });

  test('the purge ALSO takes outbox, uploads, drafts and cursors', () => {
    for (const rid of ['r1', 'r2']) {
      db.prepare(UPSERT_ROOM).run(...room({ rid, updatedAt: 100 }));
      db.prepare(INSERT_OUTBOX).run(`${rid}-outbox`, rid, 'hey', null, 1000);
      db.prepare(INSERT_UPLOAD).run(
        `${rid}-tlv`, rid, 'file:///a.jpg', 'a.jpg', 'image/jpeg', null, 1000, null,
      );
      db.prepare(UPSERT_DRAFT).run(rid, 'room draft', 1000);
      db.prepare(UPSERT_DRAFT).run(`${rid}:tmid`, 'thread draft', 1000);
      db.prepare(UPSERT_CURSOR).run(rid, 'messages', 5000);
    }
    db.prepare(UPSERT_CURSOR).run('*', 'rooms', 7000);

    purge(['r1', 'r2'], ['r1']);

    assert.deepEqual(ids('outbox'), ['r1-outbox'], 'the zombie row will no longer be replayed');
    assert.deepEqual(ids('uploads'), ['r1-tlv']);
    const keys = (db.prepare('SELECT key FROM drafts ORDER BY key').all() as { key: string }[])
      .map((l) => l.key);
    assert.deepEqual(keys, ['r1', 'r1:tmid'], 'the THREAD draft follows its room');
    const scopes = (
      db.prepare('SELECT scope FROM cursors ORDER BY scope').all() as { scope: string }[]
    ).map((l) => l.scope);
    assert.deepEqual(scopes, ['*', 'r1'], 'the GLOBAL cursor never goes');
  });

  test('an orphaned outbox (room already purged) is picked up', () => {
    // The zombie left by a purge from before this fix: no room, no subscription,
    // no message anymore, only the outbox row.
    db.prepare(INSERT_OUTBOX).run('z'.repeat(24), 'rZombie', 'never sent', null, 1000);
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', updatedAt: 100 }));

    const known = (db.prepare(LIST_KNOWN_RIDS).all() as { rid: string }[]).map((l) => l.rid);
    assert.ok(known.includes('rZombie'), 'the snapshot sees a table with a rid, not only rooms');

    purge(known, ['r1']);
    assert.deepEqual(ids('outbox'), []);
  });

  test('an EMPTY snapshot erases nothing: first launch', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', rid: 'r1', updatedAt: 100 }));
    purge([], ['rOther']);
    assert.deepEqual(rids('rooms'), ['r1']);
    assert.deepEqual(ids('messages'), ['m1']);
  });

  test('the snapshot does not count global cursors as rids', () => {
    db.prepare(UPSERT_CURSOR).run('*', 'rooms', 7000);
    db.prepare(UPSERT_CURSOR).run('r1', 'messages', 5000);
    const known = (db.prepare(LIST_KNOWN_RIDS).all() as { rid: string }[]).map((l) => l.rid);
    assert.deepEqual(known.sort(), ['r1']);
  });
});

describe('leaving a room: the satellite tables go with it', () => {
  test('outbox, uploads, drafts and cursors of the rid are erased', () => {
    for (const rid of ['r1', 'r2']) {
      db.prepare(INSERT_OUTBOX).run(`${rid}-outbox`, rid, 'hey', null, 1000);
      db.prepare(INSERT_UPLOAD).run(
        `${rid}-tlv`, rid, 'file:///a.jpg', 'a.jpg', 'image/jpeg', null, 1000, null,
      );
      db.prepare(UPSERT_DRAFT).run(rid, 'draft', 1000);
      db.prepare(UPSERT_DRAFT).run(`${rid}:tmid`, 'thread draft', 1000);
      db.prepare(UPSERT_CURSOR).run(rid, 'messages', 5000);
    }
    db.prepare(UPSERT_CURSOR).run('*', 'rooms', 7000);

    db.prepare(DELETE_ROOM_OUTBOX).run('r1');
    db.prepare(DELETE_ROOM_UPLOADS).run('r1');
    db.prepare(DELETE_ROOM_DRAFTS).run('r1');
    db.prepare(DELETE_ROOM_CURSORS).run('r1');

    const allRows = (sql: string): unknown[] => db.prepare(sql).all();
    assert.equal(allRows(`SELECT id FROM outbox WHERE rid = 'r1'`).length, 0);
    assert.equal(allRows(`SELECT id FROM uploads WHERE rid = 'r1'`).length, 0);
    assert.equal(allRows(`SELECT key FROM drafts WHERE key LIKE 'r1%'`).length, 0);
    assert.equal(allRows(`SELECT scope FROM cursors WHERE scope = 'r1'`).length, 0);

    assert.equal(allRows(`SELECT id FROM outbox WHERE rid = 'r2'`).length, 1, 'r2 is intact');
    assert.equal(allRows(`SELECT key FROM drafts WHERE key LIKE 'r2%'`).length, 2);
    assert.equal(allRows(`SELECT scope FROM cursors WHERE scope = '*'`).length, 1);
  });

  test('a cursor erased on leaving does not come back on rejoining', () => {
    // `UPSERT_CURSOR` refuses any regression: without the deletion, the old value
    // takes over again and `catchUpRoom` restarts from a point that no longer
    // says anything about the local state; capped at 2 pages, it needs dozens of
    // openings to converge, each paid in rate-limited calls.
    db.prepare(UPSERT_CURSOR).run('r1', 'messages', 9000);
    db.prepare(DELETE_ROOM_CURSORS).run('r1');
    db.prepare(UPSERT_CURSOR).run('r1', 'messages', 100);
    const l = db.prepare(READ_CURSOR).get('r1', 'messages') as { updated_since: number };
    assert.equal(l.updated_since, 100, 'the new, low cursor settles in');
  });
});

describe('retention: the last N messages per room', () => {
  const ids = (): string[] =>
    (db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[]).map((l) => l.id);

  test('cuts PER ROOM, not over the whole table', () => {
    for (const rid of ['r1', 'r2']) {
      for (let i = 1; i <= 4; i += 1) {
        db.prepare(UPSERT_MESSAGE).run(
          ...msg({ id: `${rid}-m${i}`, rid, ts: i * 1000, updatedAt: 100 }),
        );
      }
    }
    db.prepare(APPLY_RETENTION).run(2);
    assert.deepEqual(ids(), ['r1-m3', 'r1-m4', 'r2-m3', 'r2-m4'], 'the 2 most recent of EACH');
  });

  test('a room under the quota is not touched', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'a', ts: 1000, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'b', ts: 2000, updatedAt: 100 }));
    db.prepare(APPLY_RETENTION).run(500);
    assert.deepEqual(ids(), ['a', 'b']);
  });

  test('an OPTIMISTIC message survives, however old, and does not consume the quota', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'opt', ts: 1, updatedAt: 0 }));
    for (let i = 1; i <= 3; i += 1) {
      db.prepare(UPSERT_MESSAGE).run(
        ...msg({ id: `m${i}`, ts: i * 1000, updatedAt: 100 }),
      );
    }
    db.prepare(APPLY_RETENTION).run(2);
    assert.deepEqual(ids(), ['m2', 'm3', 'opt'], 'the last 2 server ones, PLUS the optimistic one');
  });

  test('a thread root still referenced is spared', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'root', ts: 1, updatedAt: 100, threadCount: 2 }),
    );
    for (let i = 1; i <= 3; i += 1) {
      db.prepare(UPSERT_MESSAGE).run(
        ...msg({ id: `m${i}`, ts: i * 1000, updatedAt: 100 }),
      );
    }
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'rep', ts: 5000, updatedAt: 100, threadId: 'root' }),
    );
    db.prepare(APPLY_RETENTION).run(2);
    assert.ok(ids().includes('root'), 'without it, the thread screen has no head anymore');
    assert.ok(ids().includes('rep'));
  });

  test('a root WITHOUT a local reply is not a special case', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'root', ts: 1, updatedAt: 100, threadCount: 2 }),
    );
    for (let i = 1; i <= 3; i += 1) {
      db.prepare(UPSERT_MESSAGE).run(
        ...msg({ id: `m${i}`, ts: i * 1000, updatedAt: 100 }),
      );
    }
    db.prepare(APPLY_RETENTION).run(2);
    assert.deepEqual(ids(), ['m2', 'm3']);
  });

  test('the cut is deterministic on tied timestamps', () => {
    for (const id of ['a', 'b', 'c']) {
      db.prepare(UPSERT_MESSAGE).run(...msg({ id, ts: 1000, updatedAt: 100 }));
    }
    db.prepare(APPLY_RETENTION).run(2);
    assert.deepEqual(ids(), ['b', 'c'], 'the id breaks ties, always in the same direction');
  });
});

describe('identities (uid -> current username)', () => {
  const q = 'SELECT username, updated_at FROM users WHERE uid = ?';

  function util(uid: string, username: string, updatedAt: number) {
    return userParams({ uid, username, updatedAt });
  }

  test('inserts an unknown identity', () => {
    db.prepare(UPSERT_USER).run(...util('u1', 'alice', 100));
    assert.deepEqual(row(db.prepare(q).get('u1')), { username: 'alice', updated_at: 100 });
  });

  test('a more recent rename wins', () => {
    db.prepare(UPSERT_USER).run(...util('u1', 'alice', 100));
    db.prepare(UPSERT_USER).run(...util('u1', 'alice2', 200));
    assert.deepEqual(row(db.prepare(q).get('u1')), { username: 'alice2', updated_at: 200 });
  });

  test('an OLDER message does not downgrade the username', () => {
    // A REST catch-up can deliver, afterwards, an old copy of a message still
    // carrying the old username: it must not overwrite the new one.
    db.prepare(UPSERT_USER).run(...util('u1', 'alice2', 200));
    db.prepare(UPSERT_USER).run(...util('u1', 'alice', 100));
    assert.deepEqual(
      row(db.prepare(q).get('u1')),
      { username: 'alice2', updated_at: 200 },
      'the past must not win',
    );
  });

  test('same username, more recent timestamp: the row does NOT move', () => {
    // The `username IS NOT` guard: without it, each message with the same
    // username would touch the table and rerun the identities live query.
    db.prepare(UPSERT_USER).run(...util('u1', 'alice', 100));
    db.prepare(UPSERT_USER).run(...util('u1', 'alice', 500));
    assert.deepEqual(
      row(db.prepare(q).get('u1')),
      { username: 'alice', updated_at: 100 },
      'frozen timestamp: no write, hence no change event',
    );
  });

  test('a message upsert ALSO records the author\'s identity', () => {
    // The store (db/store.ts) derives the identity from each message; here we
    // reproduce the double write to prove the contract end to end.
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', authorId: 'u9', authorName: 'bob', updatedAt: 300 }));
    db.prepare(UPSERT_USER).run(...util('u9', 'bob', 300));
    assert.deepEqual(row(db.prepare(q).get('u9')), { username: 'bob', updated_at: 300 });
  });
});

describe('versions d’avatar', () => {
  const readUser = 'SELECT username, avatar_etag FROM users WHERE uid = ?';
  const readRoom = 'SELECT avatar_etag FROM rooms WHERE rid = ?';

  test('the stream sets the version by USERNAME, not by uid', () => {
    db.prepare(UPSERT_USER).run(...userParams({ uid: 'u1', username: 'alice', updatedAt: 1 }));
    db.prepare(UPDATE_USER_AVATAR).run('e1', 'alice', 'e1');
    assert.deepEqual(row(db.prepare(readUser).get('u1')), {
      username: 'alice',
      avatar_etag: 'e1',
    });
  });

  test('an unknown username creates nothing: their photo is shown nowhere', () => {
    db.prepare(UPDATE_USER_AVATAR).run('e1', 'ghost', 'e1');
    const n = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.equal(n.n, 0);
  });

  test('the authoritative identity CREATES the row (my account, which has posted nothing)', () => {
    db.prepare(UPSERT_IDENTITY).run(...identityParams({ uid: 'me', username: 'guy', avatarEtag: 'e7' }));
    assert.deepEqual(row(db.prepare(readUser).get('me')), { username: 'guy', avatar_etag: 'e7' });
  });

  test('`users.info` WITHOUT avatarETag does not erase the known version', () => {
    // The field is absent when the person has no photo, and absent too from
    // partial responses. Erasing it would make the URL fall back to its original
    // form, which the image cache serves with the OLD photo.
    db.prepare(UPSERT_IDENTITY).run(...identityParams({ uid: 'u1', username: 'alice', avatarEtag: 'e1' }));
    db.prepare(UPSERT_IDENTITY).run(...identityParams({ uid: 'u1', username: 'alice', avatarEtag: null }));
    assert.deepEqual(row(db.prepare(readUser).get('u1')), { username: 'alice', avatar_etag: 'e1' });
  });

  test('a room keeps its version when the Rooms document does not carry it', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', updatedAt: 100, avatarEtag: 'e1' }));
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', updatedAt: 200 }));
    assert.deepEqual(row(db.prepare(readRoom).get('r1')), { avatar_etag: 'e1' });
  });

  test('the stream updates a room\'s version', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', updatedAt: 100, avatarEtag: 'e1' }));
    db.prepare(UPDATE_ROOM_AVATAR).run('e2', 'r1', 'e2');
    assert.deepEqual(row(db.prepare(readRoom).get('r1')), { avatar_etag: 'e2' });
  });

  test('an UNCHANGED version does not touch the row', () => {
    // Without this guard, each rebroadcast would wake every live query sitting
    // on the table, hence re-render the whole list.
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'r1', updatedAt: 100, avatarEtag: 'e1' }));
    const count = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = count();
    db.prepare(UPDATE_ROOM_AVATAR).run('e1', 'r1', 'e1');
    assert.equal(count(), before, 'no write');
  });
});

describe('list preview of an encrypted room', () => {
  const read = 'SELECT last_message FROM rooms WHERE rid = ?';
  const count = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  test('the preview follows the last decrypted message', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'one', ts: 10, updatedAt: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', text: 'two', ts: 20, updatedAt: 2 }),
    );
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: 'two' });
  });

  test('deleting the last message moves the preview BACK to the previous one', () => {
    // The server cannot tell us here: it only holds ciphertext. Only the local
    // database knows which message remains.
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'one', ts: 10, updatedAt: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', text: 'two', ts: 20, updatedAt: 2 }),
    );
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();

    db.prepare(DELETE_MESSAGE).run('m2');
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: 'one' });
  });

  test('EMPTIED encrypted room: the preview falls back to the placeholder', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'alone', ts: 10, updatedAt: 1 }));
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();

    db.prepare(DELETE_MESSAGE).run('m1');
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: null });
  });

  test('an UNCHANGED preview does not touch the row', () => {
    // `deleteMessage` replays this SQL on EVERY deletion, in any room: without
    // this guard, it would wake the whole list every time, including on an
    // account with no encrypted room at all.
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'one', ts: 10, updatedAt: 1 }));
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();

    const before = count();
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.equal(count(), before, 'no write');
  });

  test('a DECRYPTED message counts, even though it carries t: e2e', () => {
    // Anti-regression: in an encrypted room, ALL messages carry `t: 'e2e'`. A
    // naively written "no system message" filter (`system_type IS NULL`) would
    // therefore empty the preview of every encrypted room, which is the only
    // thing this query computes.
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', text: 'plaintext', systemType: 'e2e', ts: 10, updatedAt: 1 }),
    );
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: 'plaintext' });
  });

  test('a THREAD reply invisible in the room does not become the preview', () => {
    // The room's stream excludes it (`thread_id IS NULL OR thread_shown`): announcing
    // it in the list would promise a message not found when opening the room.
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'visible', ts: 10, updatedAt: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', text: 'in the thread', threadId: 'm1', ts: 20, updatedAt: 2 }),
    );
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: 'visible' });
  });

  test('a thread reply TICKED "also send to room" does count', () => {
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'visible', ts: 10, updatedAt: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({
        id: 'm2',
        text: 'in the thread AND in the room',
        threadId: 'm1',
        threadShown: true,
        ts: 20,
        updatedAt: 2,
      }),
    );
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), {
      last_message: 'in the thread AND in the room',
    });
  });

  test('a SYSTEM message does not become the preview: its text is only a parameter', () => {
    // The stream renders "alice" + "joined the room"; the `text` alone, used as
    // the preview, only showed "alice".
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', text: 'real message', ts: 10, updatedAt: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', text: 'alice', systemType: 'uj', ts: 20, updatedAt: 2 }),
    );
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: 'real message' });
  });

  test('two messages in the SAME millisecond: same winner as the stream', () => {
    // The stream breaks ties by `id DESC`. Without the same secondary key here,
    // the preview and the room's first row pointed to two different messages,
    // depending on insertion order (rowid).
    db.prepare(UPSERT_ROOM).run(...room({ rid: 'rid-1', encrypted: true, updatedAt: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'mb', text: 'B', ts: 10, updatedAt: 1 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'ma', text: 'A', ts: 10, updatedAt: 2 }));
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: 'B' });
  });

  test('a PLAINTEXT room is never touched by this pass', () => {
    // Its preview comes from the server (`lastMessage`), and the local history
    // is partial: recomputing it here would overwrite it with whatever is at hand.
    db.prepare(UPSERT_ROOM).run(
      ...room({ rid: 'rid-1', encrypted: false, lastMessage: 'from the server', updatedAt: 100 }),
    );
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', text: 'local', ts: 10, updatedAt: 1 }),
    );
    db.prepare(UPDATE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(row(db.prepare(read).get('rid-1')), { last_message: 'from the server' });
  });
});

describe('E2EE lock: mask without rewriting what already is', () => {
  const count = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  test('masking erases the plaintext and leaves the ciphertext', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', text: 'plaintext', encryptedRaw: '{"ciphertext":"x"}', updatedAt: 1 }),
    );
    db.prepare(HIDE_ENCRYPTED_MESSAGES).run();
    assert.deepEqual(
      row(db.prepare('SELECT text, encrypted_raw FROM messages WHERE id = ?').get('m1')),
      { text: null, encrypted_raw: '{"ciphertext":"x"}' },
    );
  });

  test('a REPLAYED lock writes nothing', () => {
    // `e2eRelocked` replays the operation; without the guard, it would touch the
    // whole `messages` table and wake every live query sitting on it, hence
    // re-render the open room, for nothing.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', text: 'plaintext', encryptedRaw: '{"ciphertext":"x"}', updatedAt: 1 }),
    );
    db.prepare(HIDE_ENCRYPTED_MESSAGES).run();

    const before = count();
    db.prepare(HIDE_ENCRYPTED_MESSAGES).run();
    assert.equal(count(), before, 'no write');
  });

  test('the already masked encrypted preview is not rewritten either', () => {
    db.prepare(UPSERT_ROOM).run(
      ...room({ rid: 'rid-1', encrypted: true, lastMessage: 'plaintext', updatedAt: 100 }),
    );
    db.prepare(HIDE_ENCRYPTED_PREVIEW).run();
    assert.deepEqual(
      row(db.prepare('SELECT last_message FROM rooms WHERE rid = ?').get('rid-1')),
      { last_message: null },
    );

    const before = count();
    db.prepare(HIDE_ENCRYPTED_PREVIEW).run();
    assert.equal(count(), before, 'no write');
  });
});

describe('list preview: the last message\'s type', () => {
  const read = 'SELECT last_message, last_message_type FROM rooms WHERE rid = ?';

  test('a video call has no text, but leaves its type', () => {
    // Otherwise the room rises to the top of the list with an EMPTY line: this
    // column lets the screen write "Video call" instead.
    const s = toRoom({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: '', t: 'videoconf', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_ROOM).run(...roomParams(s!));
    assert.deepEqual(row(db.prepare(read).get('r1')), {
      last_message: null,
      last_message_type: 'videoconf',
    });
  });

  test('a following ORDINARY message resets the type to null', () => {
    const call = toRoom({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: '', t: 'videoconf', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_ROOM).run(...roomParams(call!));

    const after = toRoom({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 200 },
      lastMessage: { _id: 'm2', msg: 'hey', ts: { $date: 60 } },
    });
    db.prepare(UPSERT_ROOM).run(...roomParams(after!));
    assert.deepEqual(row(db.prepare(read).get('r1')), {
      last_message: 'hey',
      last_message_type: null,
    });
  });

  test('EMPTIED room: both columns fall back to null', () => {
    // The Rooms document loses its `lastMessage` entirely: it is the only way
    // to learn that a room was emptied, and it must be told apart from "last
    // message without text".
    const full = toRoom({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: 'hey', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_ROOM).run(...roomParams(full!));

    const empty = toRoom({ _id: 'r1', t: 'c', _updatedAt: { $date: 200 } });
    db.prepare(UPSERT_ROOM).run(...roomParams(empty!));
    assert.deepEqual(row(db.prepare(read).get('r1')), {
      last_message: null,
      last_message_type: null,
    });
  });

  test('an ENCRYPTED room keeps no type: its preview is computed locally', () => {
    // The server cannot read its messages; leaving the `t` there would make the
    // local preview (`UPDATE_ENCRYPTED_PREVIEW`) be described by ANOTHER
    // message's type: a "joined the room" stuck on a real message.
    const s = toRoom({
      _id: 'r1',
      t: 'p',
      encrypted: true,
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: 'alice', t: 'uj', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_ROOM).run(...roomParams(s!));
    assert.deepEqual(row(db.prepare(read).get('r1')), {
      last_message: null,
      last_message_type: null,
    });
  });
});

/**
 * End to end, on payloads REALLY captured from a Rocket.Chat 8.5 (DDP probe
 * on the local server, July 2026). The tests above exercise `toRoom` and the
 * SQL separately; this one checks their COMPOSITION on the documents the
 * server really sends: that is where the bug lived.
 */
describe('list preview: the server\'s real documents', () => {
  const AUTHOR = { _id: 'a8Lu', username: 'alice', name: 'Alice Martin' };
  const read = 'SELECT last_message FROM rooms WHERE rid = ?';

  /** The Room document as `rooms-changed` delivers it, without its `lastMessage`. */
  const room = (updatedAt: number) => ({
    _id: 'r1',
    fname: 'probe',
    name: 'probe',
    t: 'c',
    u: AUTHOR,
    ro: false,
    sysMes: true,
    lm: { $date: 1784958551573 },
    _updatedAt: { $date: updatedAt },
  });

  const ingest = (raw: Record<string, unknown>) => {
    const s = toRoom(raw, 'alice', 'a8Lu');
    assert.notEqual(s, null, 'the document must normalise');
    db.prepare(UPSERT_ROOM).run(...roomParams(s as LocalRoom));
  };

  test('deleting a room\'s LAST message erases its preview', () => {
    ingest({
      ...room(1784958546377),
      msgs: 1,
      lastMessage: { _id: 'm1', msg: 'FIRST', ts: { $date: 1784958546341 }, u: AUTHOR },
    });
    assert.deepEqual(row(db.prepare(read).get('r1')), { last_message: 'FIRST' });

    // The emptied room: the server no longer sends any `lastMessage` at all.
    ingest({ ...room(1784958558296), msgs: 0 });
    assert.deepEqual(
      row(db.prepare(read).get('r1')),
      { last_message: null },
      'the deleted message must no longer appear in the list',
    );
  });

  test('an attachment without a caption does not leave the previous preview', () => {
    ingest({
      ...room(1784958546377),
      lastMessage: { _id: 'm1', msg: 'FIRST', ts: { $date: 1784958546341 }, u: AUTHOR },
    });
    ingest({
      ...room(1784958549011),
      lastMessage: {
        _id: 'm2',
        msg: '',
        ts: { $date: 1784958548985 },
        u: AUTHOR,
        file: { _id: 'f1', name: 'note.txt', type: 'text/plain' },
        attachments: [
          { title: 'note.txt', title_link: '/file-upload/f1/note.txt', type: 'file', format: 'TXT' },
        ],
      },
    });
    assert.deepEqual(row(db.prepare(read).get('r1')), { last_message: 'note.txt' });
  });
});

/**
 * Composer drafts. This SQL did not exist: the write was built by Drizzle in
 * `ui/drafts.ts` and run outside the write queue, hence never executed by a
 * test. It now lives here, with the rest.
 */
describe('drafts', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migratedDb();
  });

  test('writes then reads back a draft', () => {
    db.prepare(UPSERT_DRAFT).run('r1', 'hi', 1000);
    assert.deepEqual(row(db.prepare(READ_DRAFT).get('r1')), { text: 'hi' });
  });

  test('a missing key returns nothing', () => {
    assert.equal(db.prepare(READ_DRAFT).get('never-written'), undefined);
  });

  test('the latest keystroke overwrites the previous one, with no freshness guard', () => {
    db.prepare(UPSERT_DRAFT).run('r1', 'first', 2000);
    // OLDER timestamp: unlike the upserts coming from the network, it must block
    // nothing; the only source is typing, the latest wins.
    db.prepare(UPSERT_DRAFT).run('r1', 'second', 1000);
    assert.deepEqual(row(db.prepare(READ_DRAFT).get('r1')), { text: 'second' });
  });

  test('a thread\'s draft does not touch the room\'s', () => {
    db.prepare(UPSERT_DRAFT).run('r1', 'from the room', 1000);
    db.prepare(UPSERT_DRAFT).run('r1:m9', 'from the thread', 1000);
    assert.deepEqual(row(db.prepare(READ_DRAFT).get('r1')), { text: 'from the room' });
    assert.deepEqual(row(db.prepare(READ_DRAFT).get('r1:m9')), { text: 'from the thread' });
  });

  test('deletion only targets its key', () => {
    db.prepare(UPSERT_DRAFT).run('r1', 'from the room', 1000);
    db.prepare(UPSERT_DRAFT).run('r2', 'elsewhere', 1000);
    db.prepare(DELETE_DRAFT).run('r1');
    assert.equal(db.prepare(READ_DRAFT).get('r1'), undefined);
    assert.deepEqual(row(db.prepare(READ_DRAFT).get('r2')), { text: 'elsewhere' });
  });

  test('deleting a missing key does not throw', () => {
    db.prepare(DELETE_DRAFT).run('never-written');
  });
});

describe('emoji usage', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migratedDb();
  });
  const list = () =>
    (db.prepare(`${LIST_EMOJI_USAGE} ORDER BY code`).all() as Record<string, unknown>[]).map(row);

  test('a first use creates the row, the next ones count', () => {
    db.prepare(RECORD_EMOJI_USE).run('rocket', 1000);
    db.prepare(RECORD_EMOJI_USE).run('rocket', 2000);
    db.prepare(RECORD_EMOJI_USE).run('+1', 1500);
    assert.deepEqual(list(), [
      { code: '+1', count: 1, lastUsed: 1500 },
      { code: 'rocket', count: 2, lastUsed: 2000 },
    ]);
  });

  test('the latest use never moves back', () => {
    db.prepare(RECORD_EMOJI_USE).run('rocket', 2000);
    db.prepare(RECORD_EMOJI_USE).run('rocket', 1000);
    assert.deepEqual(list(), [{ code: 'rocket', count: 2, lastUsed: 2000 }]);
  });

  test('the prune keeps the most used, then the most recent', () => {
    for (const [code, uses, at] of [['a', 3, 1], ['b', 1, 9], ['c', 1, 5], ['d', 2, 2]] as const) {
      for (let i = 0; i < uses; i++) db.prepare(RECORD_EMOJI_USE).run(code, at);
    }
    db.prepare(PRUNE_EMOJI_USAGE).run('a', 'a', 2);
    assert.deepEqual(list().map((r) => r.code), ['a', 'b', 'd']);
  });

  test('the code just used is never the one pruned: a newcomer can grow', () => {
    for (const [code, uses] of [['a', 5], ['b', 4], ['c', 3]] as const) {
      for (let i = 0; i < uses; i++) db.prepare(RECORD_EMOJI_USE).run(code, 1);
    }
    db.prepare(RECORD_EMOJI_USE).run('new', 2);
    db.prepare(PRUNE_EMOJI_USAGE).run('new', 'new', 2);
    assert.deepEqual(list().map((r) => r.code), ['a', 'b', 'new']);
  });
});

describe('attachments of an encrypted file', () => {
  const read = 'SELECT text, attachments FROM messages WHERE id = ?';
  const attachments = JSON.stringify([{ title: 'photo.jpg', encryption: { iv: 'aXY=' } }]);
  const encrypted = { systemType: 'e2e', text: null, encryptedRaw: '{"ciphertext":"x"}' } as const;

  test('set on decryption, kept by a resync without key', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...encrypted, updatedAt: 1 }));
    db.prepare(UPDATE_MESSAGE_TEXT).run('', attachments, 'm1');
    assert.deepEqual(row(db.prepare(read).get('m1')), { text: '', attachments: attachments });

    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...encrypted, updatedAt: 2 }));
    assert.deepEqual(row(db.prepare(read).get('m1')), { text: '', attachments: attachments });
  });

  test('a decrypted text without attachment does not erase them', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...encrypted, updatedAt: 1 }));
    db.prepare(UPDATE_MESSAGE_TEXT).run('', attachments, 'm1');
    db.prepare(UPDATE_MESSAGE_TEXT).run('caption', null, 'm1');
    assert.deepEqual(row(db.prepare(read).get('m1')), { text: 'caption', attachments: attachments });
  });

  test('erased on lock: they carry the file\'s key', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...encrypted, updatedAt: 1 }));
    db.prepare(UPDATE_MESSAGE_TEXT).run('', attachments, 'm1');
    db.prepare(HIDE_ENCRYPTED_MESSAGES).run();
    assert.deepEqual(row(db.prepare(read).get('m1')), { text: null, attachments: null });
  });

  test('an ordinary message always follows the server', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', attachments, updatedAt: 1 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', attachments: null, updatedAt: 2 }));
    assert.deepEqual(row(db.prepare(read).get('m1')), { text: 'hello', attachments: null });
  });
});
