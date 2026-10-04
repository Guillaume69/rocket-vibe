/**
 * Lecture React de la présence (8.4). `useSyncExternalStore` : le moteur est
 * un magasin externe volatil — pas de SQLite, pas de requête vive.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { PresenceStatus } from '../lib/presence.ts';
import type { TranslationKey } from './messages.ts';
import { useSync } from './sync.tsx';
import type { Colors } from './theme.ts';

const NOTHING = () => {};

/**
 * Pastilles de présence, alimentées par les JETONS DU THÈME — la seule table
 * statut → couleur de l'app (l'audit en avait relevé trois, avec trois teintes
 * différentes pour le même statut).
 */
export function presenceColors(c: Colors): Record<PresenceStatus, string> {
  return { online: c.online, away: c.absent, busy: c.danger, offline: c.offline };
}

/**
 * Libellés par statut — quatre clés `common.presence*` pour toute l'app, en
 * minuscule : la casse d'un contexte (« En ligne » d'un sélecteur) est à
 * l'appelant.
 */
export const PRESENCE_KEYS: Record<PresenceStatus, TranslationKey> = {
  online: 'common.presenceOnline',
  away: 'common.presenceAway',
  busy: 'common.presenceBusy',
  offline: 'common.presenceOffline',
};

/**
 * Statut d'un utilisateur, `null` si inconnu — l'appelant n'affiche alors
 * RIEN (dégradation : au-delà d'~200 connexions le serveur cesse de
 * diffuser, et l'UI ne doit jamais en dépendre).
 */
export function usePresence(uid: string | null): PresenceStatus | null {
  const sync = useSync();
  const presence = sync.phase === 'ready' ? sync.presence : null;

  // Identités STABLES : un `subscribe` recréé à chaque rendu ferait
  // désabonner/réabonner chaque ligne à chaque re-rendu de la liste. Et une
  // ligne sans uid (canal) ne s'abonne pas du tout — sinon chaque événement
  // de présence réveillerait toutes les lignes visibles.
  const subscribe = useCallback(
    (reread: () => void) =>
      presence === null || uid === null ? NOTHING : presence.onChange(reread),
    [presence, uid],
  );
  const read = useCallback(
    () => (uid === null || presence === null ? null : presence.statusOf(uid)),
    [presence, uid],
  );
  return useSyncExternalStore(subscribe, read);
}

// L'AUTRE participant d'un DM ne se DÉRIVE PAS du rid : sur 8.5 le rid d'un
// DM est un ObjectId aléatoire, plus la concaténation des deux uids (vérifié
// sur le serveur local). Il vient du document Rooms (`uids`) et vit dans la
// colonne `salons.dm_autre_uid` — voir `versSalon`.
