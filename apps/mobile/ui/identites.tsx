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
 * Store module-level abonnable (même patron que `lib/profilPreload`) plutôt
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

import { useRequeteVive } from './requeteVive.ts';
import { useEffect } from 'react';

import { utilisateurs } from '../db/schema.ts';
import { poserEtags, poserIdentites } from './storeIdentites.ts';
import { useSession } from './session.tsx';
import { useSynchro } from './synchro.tsx';

export {
  oublierIdentites,
  useEtagsAvatars,
  useIdentites,
  type EtagsAvatars,
} from './storeIdentites.ts';

/**
 * Alimente le store depuis la table `utilisateurs` et la session. Frère de la
 * pile (monté dans `_layout`), il ne rend rien : il pousse dans le store.
 */
export function SuiviIdentites() {
  const synchro = useSynchro();
  if (synchro.phase !== 'pret') return null;
  return <Alimente />;
}

function Alimente() {
  const synchro = useSynchro();
  const { etat } = useSession();
  const base = synchro.phase === 'pret' ? synchro.base : null;
  // La session porte MON pseudo courant, rafraîchi à l'édition/à la reprise plus
  // tôt qu'un message ré-ingéré : on la superpose à la table (autoritaire pour moi).
  const moiUid = etat.phase === 'connecte' ? etat.session.userId : null;
  const moiUsername = etat.phase === 'connecte' ? etat.session.username : null;

  const { data } = useRequeteVive(
    base!
      .select({
        uid: utilisateurs.uid,
        username: utilisateurs.username,
        avatarEtag: utilisateurs.avatarEtag,
      })
      .from(utilisateurs),
  );

  useEffect(() => {
    const m = new Map<string, string>();
    const parUid = new Map<string, string>();
    const parUsername = new Map<string, string>();
    for (const u of data ?? []) {
      if (u.username !== null) m.set(u.uid, u.username);
      if (u.avatarEtag === null) continue;
      parUid.set(u.uid, u.avatarEtag);
      if (u.username !== null) parUsername.set(u.username, u.avatarEtag);
    }
    if (moiUid !== null && moiUsername !== null) m.set(moiUid, moiUsername);
    poserIdentites(m);
    poserEtags({ parUid, parUsername });
  }, [data, moiUid, moiUsername]);

  return null;
}
