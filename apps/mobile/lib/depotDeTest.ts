/**
 * Piège de transaction pour les DÉPÔTS DE TEST — importé par les suites,
 * jamais par l'app.
 *
 * Sur SQLite (`db/depot.ts`), toute écriture de premier niveau passe par la
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
 * permises — `db/depot.ts` les sert hors file, elles ne bloquent pas.
 */

import type { Depot, EcrituresDepot } from './sync.ts';

/**
 * Enveloppe un faux dépôt (fourni SANS `transaction` : c'est le piège qui la
 * définit, on ne peut pas l'oublier) et rend un `Depot` complet qui fait
 * respecter l'invariant file/transaction.
 */
export function avecPiegeTransaction(nu: Omit<Depot, 'transaction'>): Depot {
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
  // `direct` de `db/depot.ts`, qui contourne la file.
  const ecrivainDirect: EcrituresDepot = {
    upsertMessage: (m) => nu.upsertMessage(m),
    upsertSalon: (s) => nu.upsertSalon(s),
    upsertAbonnement: (a) => nu.upsertAbonnement(a),
    supprimerMessage: (id) => nu.supprimerMessage(id),
    supprimerSalon: (rid) => nu.supprimerSalon(rid),
    supprimerAbonnement: (rid) => nu.supprimerAbonnement(rid),
    supprimerParSubId: (subId) => nu.supprimerParSubId(subId),
    ecrireCurseur: (portee, flux, v) => nu.ecrireCurseur(portee, flux, v),
  };

  return {
    // La liste EXACTE des méthodes servies par `enSerie` dans `db/depot.ts` —
    // si l'une y entre ou en sort là-bas, elle doit bouger ici aussi.
    upsertMessage: piege('upsertMessage', (m) => nu.upsertMessage(m)),
    upsertSalon: piege('upsertSalon', (s) => nu.upsertSalon(s)),
    upsertAbonnement: piege('upsertAbonnement', (a) => nu.upsertAbonnement(a)),
    supprimerMessage: piege('supprimerMessage', (id) => nu.supprimerMessage(id)),
    supprimerSalon: piege('supprimerSalon', (rid) => nu.supprimerSalon(rid)),
    supprimerAbonnement: piege('supprimerAbonnement', (rid) => nu.supprimerAbonnement(rid)),
    supprimerParSubId: piege('supprimerParSubId', (subId) => nu.supprimerParSubId(subId)),
    ecrireCurseur: piege('ecrireCurseur', (p, f, v) => nu.ecrireCurseur(p, f, v)),
    purgerSalonsAbsents: piege('purgerSalonsAbsents', (v, c) => nu.purgerSalonsAbsents(v, c)),
    appliquerRetention: piege('appliquerRetention', (n) => nu.appliquerRetention(n)),
    majTexteMessage: piege('majTexteMessage', (id, t) => nu.majTexteMessage(id, t)),
    majMarquesMessage: piege('majMarquesMessage', (id, p, e) => nu.majMarquesMessage(id, p, e)),
    masquerMessagesChiffres: piege('masquerMessagesChiffres', () => nu.masquerMessagesChiffres()),
    majApercuChiffre: piege('majApercuChiffre', () => nu.majApercuChiffre()),
    majAvatarUtilisateur: piege('majAvatarUtilisateur', (u, e) => nu.majAvatarUtilisateur(u, e)),
    majAvatarSalon: piege('majAvatarSalon', (rid, e) => nu.majAvatarSalon(rid, e)),
    enregistrerIdentite: piege('enregistrerIdentite', (i) => nu.enregistrerIdentite(i)),

    // Lectures : hors file dans `db/depot.ts`, donc permises en transaction.
    listerRidsConnus: () => nu.listerRidsConnus(),
    lireCurseur: (p, f) => nu.lireCurseur(p, f),
    dernierMessageMisAJour: (rid) => nu.dernierMessageMisAJour(rid),
    listerClesSalon: () => nu.listerClesSalon(),
    messagesADechiffrer: () => nu.messagesADechiffrer(),

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
