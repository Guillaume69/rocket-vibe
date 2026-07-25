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
 * Store module-level abonnable (même patron que `lib/profilPreload` et le
 * `ridsChiffres` de `ui/notifications`) plutôt qu'un Provider qui envelopperait
 * la pile : basculer un composant-parent quand la base devient prête
 * REMONTERAIT tout l'arbre de navigation. Ici, `SuiviIdentites` est un frère
 * (comme `GestionNotifications`), et `LigneMessage` s'abonne au store via
 * `useSyncExternalStore` — re-rendu uniquement à un VRAI changement d'identité.
 */

import { useRequeteVive } from './requeteVive.ts';
import { useEffect, useSyncExternalStore } from 'react';

import { utilisateurs } from '../db/schema.ts';
import { useSession } from './session.tsx';
import { useSynchro } from './synchro.tsx';

let identites: ReadonlyMap<string, string> = new Map();
const ecouteurs = new Set<() => void>();

function poser(nouvelle: ReadonlyMap<string, string>): void {
  identites = nouvelle;
  for (const e of ecouteurs) e();
}

function sabonner(cb: () => void): () => void {
  ecouteurs.add(cb);
  return () => {
    ecouteurs.delete(cb);
  };
}

/** Map `uid → pseudo courant`. Re-rend l'appelant quand une identité change. */
export function useIdentites(): ReadonlyMap<string, string> {
  return useSyncExternalStore(sabonner, () => identites);
}

/**
 * Versions de photo connues, indexées des DEUX façons dont les écrans visent
 * un avatar : par pseudo (messages, mentions, fiche, mon profil) et par uid
 * (l'autre d'un DM, dont on n'a souvent que l'uid).
 */
export type EtagsAvatars = {
  parUid: ReadonlyMap<string, string>;
  parUsername: ReadonlyMap<string, string>;
};

const AUCUN_ETAG: EtagsAvatars = { parUid: new Map(), parUsername: new Map() };
let etags: EtagsAvatars = AUCUN_ETAG;
const ecouteursEtags = new Set<() => void>();

function memeMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [cle, valeur] of a) if (b.get(cle) !== valeur) return false;
  return true;
}

/**
 * Ne notifie qu'à un VRAI changement de version. La requête vive rejoue à
 * chaque écriture dans `utilisateurs` — un simple message ingéré, donc — et
 * chaque notification re-rendrait tous les avatars montés à l'écran.
 */
function poserEtags(nouveaux: EtagsAvatars): void {
  if (
    memeMap(etags.parUid, nouveaux.parUid) &&
    memeMap(etags.parUsername, nouveaux.parUsername)
  ) {
    return;
  }
  etags = nouveaux;
  for (const e of ecouteursEtags) e();
}

function sabonnerEtags(cb: () => void): () => void {
  ecouteursEtags.add(cb);
  return () => {
    ecouteursEtags.delete(cb);
  };
}

/**
 * Versions de photo à injecter dans `urlAvatar` — c'est ce qui fait bouger
 * l'URI quand quelqu'un change sa photo, cache image compris. Un avatar dont
 * l'etag est encore inconnu s'affiche exactement comme avant : l'URL sans
 * query reste valable.
 */
export function useEtagsAvatars(): EtagsAvatars {
  return useSyncExternalStore(sabonnerEtags, () => etags);
}

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
    poser(m);
    poserEtags({ parUid, parUsername });
  }, [data, moiUid, moiUsername]);

  return null;
}
