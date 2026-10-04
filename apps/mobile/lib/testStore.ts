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
export function withTransactionTrap(bare: Omit<Store, 'transaction'>): Store {
  let inTransaction = false;

  const trap = <A extends unknown[], R>(
    name: string,
    method: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return (...args: A) => {
      if (inTransaction) {
        throw new Error(
          `${name}: écriture hors file pendant une transaction — ` +
            `interblocage sur l'appareil (utiliser le \`tx\` reçu par le callback)`,
        );
      }
      return method(...args);
    };
  };

  // Ce que `fn` reçoit : les écritures du faux, EN DIRECT — le miroir du
  // `direct` de `db/store.ts`, qui contourne la file.
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
    // La liste EXACTE des méthodes servies par `enSerie` dans `db/store.ts` —
    // si l'une y entre ou en sort là-bas, elle doit bouger ici aussi.
    upsertMessage: trap('upsertMessage', (m) => bare.upsertMessage(m)),
    upsertRoom: trap('upsertRoom', (s) => bare.upsertRoom(s)),
    upsertSubscription: trap('upsertSubscription', (a) => bare.upsertSubscription(a)),
    deleteMessage: trap('deleteMessage', (id) => bare.deleteMessage(id)),
    deleteRoom: trap('deleteRoom', (rid) => bare.deleteRoom(rid)),
    deleteSubscription: trap('deleteSubscription', (rid) => bare.deleteSubscription(rid)),
    deleteBySubId: trap('deleteBySubId', (subId) => bare.deleteBySubId(subId)),
    writeCursor: trap('writeCursor', (p, f, v) => bare.writeCursor(p, f, v)),
    purgeMissingRooms: trap('purgerSalonsAbsents', (v, c) => bare.purgeMissingRooms(v, c)),
    applyRetention: trap('appliquerRetention', (n) => bare.applyRetention(n)),
    updateMessageText: trap('majTexteMessage', (id, t, p) => bare.updateMessageText(id, t, p)),
    updateMessageMarks: trap('majMarquesMessage', (id, p, e) => bare.updateMessageMarks(id, p, e)),
    hideEncryptedMessages: trap('masquerMessagesChiffres', () => bare.hideEncryptedMessages()),
    updateEncryptedPreview: trap('majApercuChiffre', () => bare.updateEncryptedPreview()),
    updateUserAvatar: trap('majAvatarUtilisateur', (u, e) => bare.updateUserAvatar(u, e)),
    updateRoomAvatar: trap('majAvatarSalon', (rid, e) => bare.updateRoomAvatar(rid, e)),
    saveIdentity: trap('enregistrerIdentite', (i) => bare.saveIdentity(i)),

    // Lectures : hors file dans `db/store.ts`, donc permises en transaction.
    listKnownRids: () => bare.listKnownRids(),
    readCursor: (p, f) => bare.readCursor(p, f),
    lastMessageUpdatedAt: (rid) => bare.lastMessageUpdatedAt(rid),
    listRoomKeys: () => bare.listRoomKeys(),
    messagesToDecrypt: () => bare.messagesToDecrypt(),

    async transaction(fn) {
      if (inTransaction) {
        // `enSerie` dans `enSerie` : le vrai dépôt s'y interbloque aussi.
        throw new Error('transaction: transaction imbriquée — interblocage sur l’appareil');
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
