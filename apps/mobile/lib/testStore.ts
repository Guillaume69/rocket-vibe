/**
 * Piège de transaction pour les DÉPÔTS DE TEST — importé par les suites,
 * jamais par l'app.
 *
 * Sur SQLite (`db/store.ts`), toute écriture de premier niveau passe par la
 * file `enSerie`, et `transaction` DÉTIENT cette file le temps du lot : appeler
 * une méthode de premier niveau depuis l'intérieur d'une transaction
 * s'interbloque — payé en gel réel sur l'appareil. C'est pourquoi `fn` reçoit
 * un écrivain DIRECT (`EcrituresDepot`), hors file.
 *
 * Un faux dépôt qui fait `transaction: (fn) => fn(depot)` efface cet
 * invariant : un refactor qui écrirait `this.depot.upsertMessage` au lieu de
 * `tx.upsertMessage` passerait tsc et toute la suite, puis figerait le premier
 * lot de rattrapage sur l'appareil, pour toujours. Ce module rend le faux
 * aussi intransigeant que le vrai : pendant une transaction, chaque méthode DE
 * FILE du dépôt jette au lieu de réussir en silence. Les LECTURES restent
 * permises — `db/store.ts` les sert hors file, elles ne bloquent pas.
 */

import type { Store, StoreWrites } from './sync.ts';

/**
 * Enveloppe un faux dépôt (fourni SANS `transaction` : c'est le piège qui la
 * définit, on ne peut pas l'oublier) et rend un `Depot` complet qui fait
 * respecter l'invariant file/transaction.
 */
export function withTransactionTrap(nu: Omit<Store, 'transaction'>): Store {
  let enTransaction = false;

  const piege = <A extends unknown[], R>(
    nom: string,
    methode: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return (...args: A) => {
      if (enTransaction) {
        throw new Error(
          `${nom}: écriture hors file pendant une transaction — ` +
            `interblocage sur l'appareil (utiliser le \`tx\` reçu par le callback)`,
        );
      }
      return methode(...args);
    };
  };

  // Ce que `fn` reçoit : les écritures du faux, EN DIRECT — le miroir du
  // `direct` de `db/store.ts`, qui contourne la file.
  const ecrivainDirect: StoreWrites = {
    upsertMessage: (m) => nu.upsertMessage(m),
    upsertRoom: (s) => nu.upsertRoom(s),
    upsertSubscription: (a) => nu.upsertSubscription(a),
    deleteMessage: (id) => nu.deleteMessage(id),
    deleteRoom: (rid) => nu.deleteRoom(rid),
    deleteSubscription: (rid) => nu.deleteSubscription(rid),
    deleteBySubId: (subId) => nu.deleteBySubId(subId),
    writeCursor: (scope, stream, v) => nu.writeCursor(scope, stream, v),
  };

  return {
    // La liste EXACTE des méthodes servies par `enSerie` dans `db/store.ts` —
    // si l'une y entre ou en sort là-bas, elle doit bouger ici aussi.
    upsertMessage: piege('upsertMessage', (m) => nu.upsertMessage(m)),
    upsertRoom: piege('upsertSalon', (s) => nu.upsertRoom(s)),
    upsertSubscription: piege('upsertAbonnement', (a) => nu.upsertSubscription(a)),
    deleteMessage: piege('supprimerMessage', (id) => nu.deleteMessage(id)),
    deleteRoom: piege('supprimerSalon', (rid) => nu.deleteRoom(rid)),
    deleteSubscription: piege('supprimerAbonnement', (rid) => nu.deleteSubscription(rid)),
    deleteBySubId: piege('supprimerParSubId', (subId) => nu.deleteBySubId(subId)),
    writeCursor: piege('ecrireCurseur', (p, f, v) => nu.writeCursor(p, f, v)),
    purgeMissingRooms: piege('purgerSalonsAbsents', (v, c) => nu.purgeMissingRooms(v, c)),
    applyRetention: piege('appliquerRetention', (n) => nu.applyRetention(n)),
    updateMessageText: piege('majTexteMessage', (id, t, p) => nu.updateMessageText(id, t, p)),
    updateMessageMarks: piege('majMarquesMessage', (id, p, e) => nu.updateMessageMarks(id, p, e)),
    hideEncryptedMessages: piege('masquerMessagesChiffres', () => nu.hideEncryptedMessages()),
    updateEncryptedPreview: piege('majApercuChiffre', () => nu.updateEncryptedPreview()),
    updateUserAvatar: piege('majAvatarUtilisateur', (u, e) => nu.updateUserAvatar(u, e)),
    updateRoomAvatar: piege('majAvatarSalon', (rid, e) => nu.updateRoomAvatar(rid, e)),
    saveIdentity: piege('enregistrerIdentite', (i) => nu.saveIdentity(i)),

    // Lectures : hors file dans `db/store.ts`, donc permises en transaction.
    listKnownRids: () => nu.listKnownRids(),
    readCursor: (p, f) => nu.readCursor(p, f),
    lastMessageUpdatedAt: (rid) => nu.lastMessageUpdatedAt(rid),
    listRoomKeys: () => nu.listRoomKeys(),
    messagesToDecrypt: () => nu.messagesToDecrypt(),

    async transaction(fn) {
      if (enTransaction) {
        // `enSerie` dans `enSerie` : le vrai dépôt s'y interbloque aussi.
        throw new Error('transaction: transaction imbriquée — interblocage sur l’appareil');
      }
      enTransaction = true;
      try {
        await fn(ecrivainDirect);
      } finally {
        enTransaction = false;
      }
    },
  };
}
