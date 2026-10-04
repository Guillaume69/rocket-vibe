import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withTransactionTrap } from './testStore.ts';
import type { Store } from './sync.ts';

/** Le plus petit faux possible : on ne teste ici QUE le piège. */
function faireDepotNu() {
  const ecrits: string[] = [];
  const nu: Omit<Store, 'transaction'> = {
    upsertMessage: async (m) => void ecrits.push(`message:${m.id}`),
    upsertRoom: async (s) => void ecrits.push(`salon:${s.rid}`),
    upsertSubscription: async (a) => void ecrits.push(`abonnement:${a.rid}`),
    deleteMessage: async (id) => void ecrits.push(`-message:${id}`),
    deleteRoom: async (rid) => void ecrits.push(`-salon:${rid}`),
    deleteSubscription: async (rid) => void ecrits.push(`-abonnement:${rid}`),
    deleteBySubId: async (subId) => void ecrits.push(`-sub:${subId}`),
    listKnownRids: async () => ['r1'],
    purgeMissingRooms: async () => void ecrits.push('purge'),
    applyRetention: async () => void ecrits.push('retention'),
    readCursor: async () => 42,
    writeCursor: async (p, f, v) => void ecrits.push(`curseur:${p}|${f}|${v}`),
    lastMessageUpdatedAt: async () => null,
    listRoomKeys: async () => [],
    messagesToDecrypt: async () => [],
    updateMessageText: async () => void ecrits.push('majTexte'),
    updateMessageMarks: async () => void ecrits.push('majMarques'),
    hideEncryptedMessages: async () => void ecrits.push('masquer'),
    updateEncryptedPreview: async () => void ecrits.push('apercu'),
    updateUserAvatar: async () => void ecrits.push('avatarU'),
    updateRoomAvatar: async () => void ecrits.push('avatarR'),
    saveIdentity: async () => void ecrits.push('identite'),
  };
  return { store: withTransactionTrap(nu), ecrits };
}

const message = { id: 'm1' } as Parameters<Store['upsertMessage']>[0];

describe('avecPiegeTransaction', () => {
  test('hors transaction, tout passe et atteint le faux', async () => {
    const { store: depot, ecrits } = faireDepotNu();
    await depot.upsertMessage(message);
    await depot.writeCursor('r1', 'messages', 7);
    assert.deepEqual(ecrits, ['message:m1', 'curseur:r1|messages|7']);
  });

  test('les écritures du `tx` reçu passent — c’est le contrat nominal', async () => {
    const { store: depot, ecrits } = faireDepotNu();
    await depot.transaction(async (tx) => {
      await tx.upsertMessage(message);
      await tx.writeCursor('r1', 'messages', 7);
    });
    assert.deepEqual(ecrits, ['message:m1', 'curseur:r1|messages|7']);
  });

  test('une écriture de PREMIER NIVEAU pendant la transaction jette — l’interblocage devient détectable', async () => {
    const { store: depot, ecrits } = faireDepotNu();
    // Le régresseur type : `depot.upsertMessage` au lieu de `tx.upsertMessage`.
    await assert.rejects(
      depot.transaction(async () => {
        await depot.upsertMessage(message);
      }),
      /hors file pendant une transaction/,
    );
    assert.deepEqual(ecrits, []);
    // Les méthodes de file NON membres d'`EcrituresDepot` sont piégées aussi :
    // sur SQLite, elles passent par la même file (`db/store.ts`).
    await assert.rejects(
      depot.transaction(async () => {
        await depot.updateMessageText('m1', 'clair', null);
      }),
      /hors file pendant une transaction/,
    );
  });

  test('les LECTURES restent permises en transaction — hors file dans db/store.ts', async () => {
    const { store: depot } = faireDepotNu();
    let lu: number | null = null;
    await depot.transaction(async () => {
      lu = await depot.readCursor('r1', 'messages');
    });
    assert.equal(lu, 42);
  });

  test('une transaction imbriquée jette, et le piège se désarme même sur échec', async () => {
    const { store: depot, ecrits } = faireDepotNu();
    await assert.rejects(
      depot.transaction(async () => {
        await depot.transaction(async () => {});
      }),
      /transaction imbriquée/,
    );
    // Le `finally` a bien rendu la main : le dépôt refonctionne après l'échec.
    await depot.upsertMessage(message);
    assert.deepEqual(ecrits, ['message:m1']);
  });
});
