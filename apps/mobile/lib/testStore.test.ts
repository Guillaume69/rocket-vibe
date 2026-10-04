import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withTransactionTrap } from './testStore.ts';
import type { Store } from './sync.ts';

/** Le plus petit faux possible : on ne teste ici QUE le piège. */
function makeBareStore() {
  const written: string[] = [];
  const bare: Omit<Store, 'transaction'> = {
    upsertMessage: async (m) => void written.push(`message:${m.id}`),
    upsertRoom: async (s) => void written.push(`salon:${s.rid}`),
    upsertSubscription: async (a) => void written.push(`abonnement:${a.rid}`),
    deleteMessage: async (id) => void written.push(`-message:${id}`),
    deleteRoom: async (rid) => void written.push(`-salon:${rid}`),
    deleteSubscription: async (rid) => void written.push(`-abonnement:${rid}`),
    deleteBySubId: async (subId) => void written.push(`-sub:${subId}`),
    listKnownRids: async () => ['r1'],
    purgeMissingRooms: async () => void written.push('purge'),
    applyRetention: async () => void written.push('retention'),
    readCursor: async () => 42,
    writeCursor: async (p, f, v) => void written.push(`curseur:${p}|${f}|${v}`),
    lastMessageUpdatedAt: async () => null,
    listRoomKeys: async () => [],
    messagesToDecrypt: async () => [],
    updateMessageText: async () => void written.push('majTexte'),
    updateMessageMarks: async () => void written.push('majMarques'),
    hideEncryptedMessages: async () => void written.push('masquer'),
    updateEncryptedPreview: async () => void written.push('apercu'),
    updateUserAvatar: async () => void written.push('avatarU'),
    updateRoomAvatar: async () => void written.push('avatarR'),
    saveIdentity: async () => void written.push('identite'),
  };
  return { store: withTransactionTrap(bare), written };
}

const message = { id: 'm1' } as Parameters<Store['upsertMessage']>[0];

describe('avecPiegeTransaction', () => {
  test('hors transaction, tout passe et atteint le faux', async () => {
    const { store, written } = makeBareStore();
    await store.upsertMessage(message);
    await store.writeCursor('r1', 'messages', 7);
    assert.deepEqual(written, ['message:m1', 'curseur:r1|messages|7']);
  });

  test('les écritures du `tx` reçu passent — c’est le contrat nominal', async () => {
    const { store, written } = makeBareStore();
    await store.transaction(async (tx) => {
      await tx.upsertMessage(message);
      await tx.writeCursor('r1', 'messages', 7);
    });
    assert.deepEqual(written, ['message:m1', 'curseur:r1|messages|7']);
  });

  test('une écriture de PREMIER NIVEAU pendant la transaction jette — l’interblocage devient détectable', async () => {
    const { store, written } = makeBareStore();
    // Le régresseur type : `depot.upsertMessage` au lieu de `tx.upsertMessage`.
    await assert.rejects(
      store.transaction(async () => {
        await store.upsertMessage(message);
      }),
      /hors file pendant une transaction/,
    );
    assert.deepEqual(written, []);
    // Les méthodes de file NON membres d'`EcrituresDepot` sont piégées aussi :
    // sur SQLite, elles passent par la même file (`db/store.ts`).
    await assert.rejects(
      store.transaction(async () => {
        await store.updateMessageText('m1', 'clair', null);
      }),
      /hors file pendant une transaction/,
    );
  });

  test('les LECTURES restent permises en transaction — hors file dans db/store.ts', async () => {
    const { store } = makeBareStore();
    let read: number | null = null;
    await store.transaction(async () => {
      read = await store.readCursor('r1', 'messages');
    });
    assert.equal(read, 42);
  });

  test('une transaction imbriquée jette, et le piège se désarme même sur échec', async () => {
    const { store, written } = makeBareStore();
    await assert.rejects(
      store.transaction(async () => {
        await store.transaction(async () => {});
      }),
      /transaction imbriquée/,
    );
    // Le `finally` a bien rendu la main : le dépôt refonctionne après l'échec.
    await store.upsertMessage(message);
    assert.deepEqual(written, ['message:m1']);
  });
});
