/**
 * Lecture React de la présence (8.4). `useSyncExternalStore` : le moteur est
 * un magasin externe volatil — pas de SQLite, pas de requête vive.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { StatutPresence } from '../lib/presence.ts';
import type { CleTraduction } from './messages.ts';
import { useSynchro } from './sync.tsx';
import type { Couleurs } from './theme.ts';

const RIEN = () => {};

/**
 * Pastilles de présence, alimentées par les JETONS DU THÈME — la seule table
 * statut → couleur de l'app (l'audit en avait relevé trois, avec trois teintes
 * différentes pour le même statut).
 */
export function couleursPresence(c: Couleurs): Record<StatutPresence, string> {
  return { online: c.enLigne, away: c.absent, busy: c.danger, offline: c.horsLigne };
}

/**
 * Libellés par statut — quatre clés `commun.presence*` pour toute l'app, en
 * minuscule : la casse d'un contexte (« En ligne » d'un sélecteur) est à
 * l'appelant.
 */
export const CLES_PRESENCE: Record<StatutPresence, CleTraduction> = {
  online: 'commun.presenceEnLigne',
  away: 'commun.presenceAbsent',
  busy: 'commun.presenceOccupe',
  offline: 'commun.presenceHorsLigne',
};

/**
 * Statut d'un utilisateur, `null` si inconnu — l'appelant n'affiche alors
 * RIEN (dégradation : au-delà d'~200 connexions le serveur cesse de
 * diffuser, et l'UI ne doit jamais en dépendre).
 */
export function usePresence(uid: string | null): StatutPresence | null {
  const synchro = useSynchro();
  const presence = synchro.phase === 'pret' ? synchro.presence : null;

  // Identités STABLES : un `subscribe` recréé à chaque rendu ferait
  // désabonner/réabonner chaque ligne à chaque re-rendu de la liste. Et une
  // ligne sans uid (canal) ne s'abonne pas du tout — sinon chaque événement
  // de présence réveillerait toutes les lignes visibles.
  const abonner = useCallback(
    (relire: () => void) =>
      presence === null || uid === null ? RIEN : presence.surChangement(relire),
    [presence, uid],
  );
  const lire = useCallback(
    () => (uid === null || presence === null ? null : presence.statutDe(uid)),
    [presence, uid],
  );
  return useSyncExternalStore(abonner, lire);
}

// L'AUTRE participant d'un DM ne se DÉRIVE PAS du rid : sur 8.5 le rid d'un
// DM est un ObjectId aléatoire, plus la concaténation des deux uids (vérifié
// sur le serveur local). Il vient du document Rooms (`uids`) et vit dans la
// colonne `salons.dm_autre_uid` — voir `versSalon`.
