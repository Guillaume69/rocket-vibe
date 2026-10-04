/**
 * Résolution `uid → pseudo COURANT` pour l'affichage des auteurs de messages,
 * et `qui → version de sa photo` (`avatarETag`) pour l'affichage des avatars.
 *
 * Les deux sortent de la MÊME table (`utilisateurs`) et de la même requête
 * vive, mais alimentent deux stores distincts : un renommage ne doit pas
 * re-rendre ce qui ne regarde que les photos, ni l'inverse.
 *
 * Le pseudo Rocket.Chat est MUABLE, l'uid non : `messages.auteur_nom` n'est
 * qu'un instantané figé à l'ingestion (repli). La table `utilisateurs`,
 * alimentée à chaque message, donne le pseudo à jour — y compris pour les
 * messages postés AVANT un renommage, qu'on ne re-télécharge pas.
 *
 * Store module-level abonnable (même patron que `lib/profilePreload`) plutôt
 * qu'un Provider qui envelopperait la pile : basculer un composant-parent quand
 * la base devient prête REMONTERAIT tout l'arbre de navigation. Ici,
 * `SuiviIdentites` est un frère (comme `GestionNotifications`), et
 * `LigneMessage` s'abonne au store via `useSyncExternalStore` — re-rendu
 * uniquement à un VRAI changement d'identité.
 *
 * Les stores eux-mêmes vivent dans [[storeIdentites]], qui n'importe rien de
 * l'arbre : ce fichier-ci ne garde que le composant qui les ALIMENTE. Voir là-bas
 * pourquoi la séparation n'est pas cosmétique.
 */

import { useCoalescedLiveQuery } from './liveQuery.ts';
import { useEffect } from 'react';

import { users } from '../db/schema.ts';
import { setEtags, setIdentities } from './identityStore.ts';
import { useSession } from './session.tsx';
import { useSync } from './sync.tsx';

export {
  forgetIdentities,
  useEtagsAvatars,
  useIdentities,
  type EtagsAvatars,
} from './identityStore.ts';

/**
 * Alimente le store depuis la table `utilisateurs` et la session. Frère de la
 * pile (monté dans `_layout`), il ne rend rien : il pousse dans le store.
 */
export function IdentityTracker() {
  const sync = useSync();
  if (sync.phase !== 'ready') return null;
  return <Feed />;
}

function Feed() {
  const sync = useSync();
  const { state } = useSession();
  const base = sync.phase === 'ready' ? sync.base : null;
  // La session porte MON pseudo courant, rafraîchi à l'édition/à la reprise plus
  // tôt qu'un message ré-ingéré : on la superpose à la table (autoritaire pour moi).
  const myUid = state.phase === 'connected' ? state.session.userId : null;
  const myUsername = state.phase === 'connected' ? state.session.username : null;

  const { data } = useCoalescedLiveQuery(
    base!
      .select({
        uid: users.uid,
        username: users.username,
        avatarEtag: users.avatarEtag,
      })
      .from(users),
  );

  useEffect(() => {
    const m = new Map<string, string>();
    const byUid = new Map<string, string>();
    const byUsername = new Map<string, string>();
    for (const u of data ?? []) {
      if (u.username !== null) m.set(u.uid, u.username);
      if (u.avatarEtag === null) continue;
      byUid.set(u.uid, u.avatarEtag);
      if (u.username !== null) byUsername.set(u.username, u.avatarEtag);
    }
    if (myUid !== null && myUsername !== null) m.set(myUid, myUsername);
    setIdentities(m);
    setEtags({ byUid, byUsername });
  }, [data, myUid, myUsername]);

  return null;
}
