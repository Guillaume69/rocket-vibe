/**
 * Transaction trap for TEST STORES, imported by the suites, never by the app.
 *
 * On SQLite (`db/store.ts`), every top-level write goes through the
 * `serially` queue, and `transaction` HOLDS that queue for the batch: calling
 * a top-level method from inside a transaction deadlocks, paid for as a real
 * freeze on the device. That is why `fn` receives a DIRECT writer
 * (`StoreWrites`), outside the queue.
 *
 * A fake store doing `transaction: (fn) => fn(store)` erases this invariant:
 * a refactor writing `this.store.upsertMessage` instead of `tx.upsertMessage`
 * would pass tsc and the whole suite, then freeze the first catch-up batch on
 * the device, forever. This module makes the fake as strict as the real one:
 * during a transaction, every QUEUED method of the store throws instead of
 * silently succeeding. READS stay allowed: `db/store.ts` serves them outside
 * the queue, they do not block.
 */

import type { Store, StoreWrites } from './sync.ts';

/**
 * Wraps a fake store (supplied WITHOUT `transaction`: the trap defines it, so
 * it cannot be forgotten) and returns a full `Store` that enforces the
 * queue/transaction invariant.
 */
export function withTransactionTrap(bare: Omit<Store, 'transaction'>): Store {
  let inTransaction = false;

  const trap = <A extends unknown[], R>(
    name: string,
    method: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return (...args: A) => {
      if (inTransaction) {
        throw new Error(
          `${name}: write outside the queue during a transaction, ` +
            `deadlocks on the device (use the \`tx\` passed to the callback)`,
        );
      }
      return method(...args);
    };
  };

  // What `fn` receives: the fake's writes, DIRECT, mirroring the `direct` of
  // `db/store.ts`, which bypasses the queue.
  const directWriter: StoreWrites = {
    upsertMessage: (m) => bare.upsertMessage(m),
    upsertRoom: (s) => bare.upsertRoom(s),
    upsertSubscription: (a) => bare.upsertSubscription(a),
    deleteMessage: (id) => bare.deleteMessage(id),
    deleteRoom: (rid) => bare.deleteRoom(rid),
    deleteSubscription: (rid) => bare.deleteSubscription(rid),
    deleteBySubId: (subId) => bare.deleteBySubId(subId),
    writeCursor: (scope, stream, v) => bare.writeCursor(scope, stream, v),
  };

  return {
    // The EXACT list of methods served by `serially` in `db/store.ts`: if one
    // enters or leaves it there, it must move here too.
    upsertMessage: trap('upsertMessage', (m) => bare.upsertMessage(m)),
    upsertRoom: trap('upsertRoom', (s) => bare.upsertRoom(s)),
    upsertSubscription: trap('upsertSubscription', (a) => bare.upsertSubscription(a)),
    deleteMessage: trap('deleteMessage', (id) => bare.deleteMessage(id)),
    deleteRoom: trap('deleteRoom', (rid) => bare.deleteRoom(rid)),
    deleteSubscription: trap('deleteSubscription', (rid) => bare.deleteSubscription(rid)),
    deleteBySubId: trap('deleteBySubId', (subId) => bare.deleteBySubId(subId)),
    writeCursor: trap('writeCursor', (p, f, v) => bare.writeCursor(p, f, v)),
    purgeMissingRooms: trap('purgeMissingRooms', (v, c) => bare.purgeMissingRooms(v, c)),
    applyRetention: trap('applyRetention', (n) => bare.applyRetention(n)),
    updateMessageText: trap('updateMessageText', (id, t, p) => bare.updateMessageText(id, t, p)),
    updateMessageMarks: trap('updateMessageMarks', (id, p, e) => bare.updateMessageMarks(id, p, e)),
    updateThreadFollowers: trap('updateThreadFollowers', (id, f) => bare.updateThreadFollowers(id, f)),
    clearRoomMessages: trap('clearRoomMessages', (rid) => bare.clearRoomMessages(rid)),
    hideEncryptedMessages: trap('hideEncryptedMessages', () => bare.hideEncryptedMessages()),
    updateEncryptedPreview: trap('updateEncryptedPreview', () => bare.updateEncryptedPreview()),
    updateUserAvatar: trap('updateUserAvatar', (u, e) => bare.updateUserAvatar(u, e)),
    updateRoomAvatar: trap('updateRoomAvatar', (rid, e) => bare.updateRoomAvatar(rid, e)),
    saveIdentity: trap('saveIdentity', (i) => bare.saveIdentity(i)),

    // Reads: outside the queue in `db/store.ts`, so allowed in a transaction.
    listKnownRids: () => bare.listKnownRids(),
    readCursor: (p, f) => bare.readCursor(p, f),
    lastMessageUpdatedAt: (rid) => bare.lastMessageUpdatedAt(rid),
    listRoomKeys: () => bare.listRoomKeys(),
    messagesToDecrypt: () => bare.messagesToDecrypt(),

    async transaction(fn) {
      if (inTransaction) {
        // `serially` inside `serially`: the real store deadlocks there too.
        throw new Error('transaction: nested transaction, deadlocks on the device');
      }
      inTransaction = true;
      try {
        await fn(directWriter);
      } finally {
        inTransaction = false;
      }
    },
  };
}
