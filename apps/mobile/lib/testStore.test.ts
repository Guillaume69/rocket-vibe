import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withTransactionTrap } from './testStore.ts';
import type { Store } from './sync.ts';

/** The smallest possible fake: ONLY the trap is tested here. */
function makeBareStore() {
  const written: string[] = [];
  const bare: Omit<Store, 'transaction'> = {
    upsertMessage: async (m) => void written.push(`message:${m.id}`),
    upsertRoom: async (s) => void written.push(`room:${s.rid}`),
    upsertSubscription: async (a) => void written.push(`subscription:${a.rid}`),
    deleteMessage: async (id) => void written.push(`-message:${id}`),
    deleteRoom: async (rid) => void written.push(`-room:${rid}`),
    deleteSubscription: async (rid) => void written.push(`-subscription:${rid}`),
    deleteBySubId: async (subId) => void written.push(`-sub:${subId}`),
    listKnownRids: async () => ['r1'],
    purgeMissingRooms: async () => void written.push('purge'),
    applyRetention: async () => void written.push('retention'),
    readCursor: async () => 42,
    writeCursor: async (p, f, v) => void written.push(`cursor:${p}|${f}|${v}`),
    lastMessageUpdatedAt: async () => null,
    listRoomKeys: async () => [],
    messagesToDecrypt: async () => [],
    updateMessageText: async () => void written.push('updateText'),
    updateMessageMarks: async () => void written.push('updateMarks'),
    hideEncryptedMessages: async () => void written.push('hide'),
    updateEncryptedPreview: async () => void written.push('preview'),
    updateUserAvatar: async () => void written.push('avatarU'),
    updateRoomAvatar: async () => void written.push('avatarR'),
    saveIdentity: async () => void written.push('identity'),
  };
  return { store: withTransactionTrap(bare), written };
}

const message = { id: 'm1' } as Parameters<Store['upsertMessage']>[0];

describe('withTransactionTrap', () => {
  test('outside a transaction, everything goes through and reaches the fake', async () => {
    const { store, written } = makeBareStore();
    await store.upsertMessage(message);
    await store.writeCursor('r1', 'messages', 7);
    assert.deepEqual(written, ['message:m1', 'cursor:r1|messages|7']);
  });

  test('writes through the received `tx` go through, the nominal contract', async () => {
    const { store, written } = makeBareStore();
    await store.transaction(async (tx) => {
      await tx.upsertMessage(message);
      await tx.writeCursor('r1', 'messages', 7);
    });
    assert.deepEqual(written, ['message:m1', 'cursor:r1|messages|7']);
  });

  test('a TOP-LEVEL write during the transaction throws, so the deadlock becomes detectable', async () => {
    const { store, written } = makeBareStore();
    // The typical regression: `store.upsertMessage` instead of `tx.upsertMessage`.
    await assert.rejects(
      store.transaction(async () => {
        await store.upsertMessage(message);
      }),
      /outside the queue during a transaction/,
    );
    assert.deepEqual(written, []);
    // Queued methods NOT in `StoreWrites` are trapped too: on SQLite they go
    // through the same queue (`db/store.ts`).
    await assert.rejects(
      store.transaction(async () => {
        await store.updateMessageText('m1', 'plaintext', null);
      }),
      /outside the queue during a transaction/,
    );
  });

  test('READS stay allowed in a transaction, outside the queue in db/store.ts', async () => {
    const { store } = makeBareStore();
    let read: number | null = null;
    await store.transaction(async () => {
      read = await store.readCursor('r1', 'messages');
    });
    assert.equal(read, 42);
  });

  test('a nested transaction throws, and the trap disarms even on failure', async () => {
    const { store, written } = makeBareStore();
    await assert.rejects(
      store.transaction(async () => {
        await store.transaction(async () => {});
      }),
      /nested transaction/,
    );
    // The `finally` did hand back: the store works again after the failure.
    await store.upsertMessage(message);
    assert.deepEqual(written, ['message:m1']);
  });
});
