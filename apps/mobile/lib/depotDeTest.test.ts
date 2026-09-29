import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { avecPiegeTransaction } from './depotDeTest.ts';
import type { Depot } from './sync.ts';

/** Le plus petit faux possible : on ne teste ici QUE le piège. */
function faireDepotNu() {
  const ecrits: string[] = [];
  const nu: Omit<Depot, 'transaction'> = {
    upsertMessage: async (m) => void ecrits.push(`message:${m.id}`),
    upsertSalon: async (s) => void ecrits.push(`salon:${s.rid}`),
    upsertAbonnement: async (a) => void ecrits.push(`abonnement:${a.rid}`),
    supprimerMessage: async (id) => void ecrits.push(`-message:${id}`),
    supprimerSalon: async (rid) => void ecrits.push(`-salon:${rid}`),
    supprimerAbonnement: async (rid) => void ecrits.push(`-abonnement:${rid}`),
    supprimerParSubId: async (subId) => void ecrits.push(`-sub:${subId}`),
    listerRidsConnus: async () => ['r1'],
    purgerSalonsAbsents: async () => void ecrits.push('purge'),
    appliquerRetention: async () => void ecrits.push('retention'),
    lireCurseur: async () => 42,
    ecrireCurseur: async (p, f, v) => void ecrits.push(`curseur:${p}|${f}|${v}`),
    dernierMessageMisAJour: async () => null,
    listerClesSalon: async () => [],
    messagesADechiffrer: async () => [],
    majTexteMessage: async () => void ecrits.push('majTexte'),
    majMarquesMessage: async () => void ecrits.push('majMarques'),
    masquerMessagesChiffres: async () => void ecrits.push('masquer'),
    majApercuChiffre: async () => void ecrits.push('apercu'),
    majAvatarUtilisateur: async () => void ecrits.push('avatarU'),
    majAvatarSalon: async () => void ecrits.push('avatarR'),
    enregistrerIdentite: async () => void ecrits.push('identite'),
  };
  return { depot: avecPiegeTransaction(nu), ecrits };
}

const message = { id: 'm1' } as Parameters<Depot['upsertMessage']>[0];

describe('avecPiegeTransaction', () => {
  test('hors transaction, tout passe et atteint le faux', async () => {
    const { depot, ecrits } = faireDepotNu();
    await depot.upsertMessage(message);
    await depot.ecrireCurseur('r1', 'messages', 7);
    assert.deepEqual(ecrits, ['message:m1', 'curseur:r1|messages|7']);
  });

  test('les écritures du `tx` reçu passent — c’est le contrat nominal', async () => {
    const { depot, ecrits } = faireDepotNu();
    await depot.transaction(async (tx) => {
      await tx.upsertMessage(message);
      await tx.ecrireCurseur('r1', 'messages', 7);
    });
    assert.deepEqual(ecrits, ['message:m1', 'curseur:r1|messages|7']);
  });

  test('une écriture de PREMIER NIVEAU pendant la transaction jette — l’interblocage devient détectable', async () => {
    const { depot, ecrits } = faireDepotNu();
    // Le régresseur type : `depot.upsertMessage` au lieu de `tx.upsertMessage`.
    await assert.rejects(
      depot.transaction(async () => {
        await depot.upsertMessage(message);
      }),
      /hors file pendant une transaction/,
    );
    assert.deepEqual(ecrits, []);
    // Les méthodes de file NON membres d'`EcrituresDepot` sont piégées aussi :
    // sur SQLite, elles passent par la même file (`db/depot.ts`).
    await assert.rejects(
      depot.transaction(async () => {
        await depot.majTexteMessage('m1', 'clair');
      }),
      /hors file pendant une transaction/,
    );
  });

  test('les LECTURES restent permises en transaction — hors file dans db/depot.ts', async () => {
    const { depot } = faireDepotNu();
    let lu: number | null = null;
    await depot.transaction(async () => {
      lu = await depot.lireCurseur('r1', 'messages');
    });
    assert.equal(lu, 42);
  });

  test('une transaction imbriquée jette, et le piège se désarme même sur échec', async () => {
    const { depot, ecrits } = faireDepotNu();
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
