/**
 * Les stores d'identité, hors de l'arbre React.
 *
 * Séparés de `ui/identities.tsx` — qui, lui, contient le composant qui les
 * ALIMENTE — pour la même raison que [[etatNotifications]] : ils sont purgés
 * depuis le cleanup de `SynchroProvider`, et un module qui importe `synchro`
 * ne peut pas être importé PAR `synchro` sans faire un cycle dont la
 * résolution dépendrait de l'ordre d'évaluation du bundler. Tous les autres
 * stores purgés en fin de session ([[salonsCharges]], [[filsCharges]],
 * [[salonChaud]]) sont des feuilles ; ceux-ci le deviennent.
 *
 * Deux stores et non un : un renommage ne doit pas re-rendre ce qui ne regarde
 * que les photos, ni l'inverse.
 */

import { useSyncExternalStore } from 'react';

let identites: ReadonlyMap<string, string> = new Map();
const ecouteurs = new Set<() => void>();

export function poserIdentites(nouvelle: ReadonlyMap<string, string>): void {
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
export function poserEtags(nouveaux: EtagsAvatars): void {
  if (memeMap(etags.parUid, nouveaux.parUid) && memeMap(etags.parUsername, nouveaux.parUsername)) {
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
 * Fin de session / changement de serveur : ni pseudo ni version de photo ne
 * traversent.
 *
 * `SuiviIdentites` se débranche dès que la synchro n'est plus « pret », donc
 * plus personne ne pousse — et les deux stores gardaient la dernière valeur du
 * compte précédent. À la session suivante, les écrans servaient ses pseudos et
 * ses etags jusqu'à ce que la requête vive rejoue. Sur le MÊME serveur, un etag
 * périmé est pire qu'un pseudo périmé : l'URL d'avatar ne bouge pas, donc le
 * cache image d'Android sert l'ancienne photo, et rien ne la fait sortir.
 */
export function oublierIdentites(): void {
  poserIdentites(new Map());
  poserEtags(AUCUN_ETAG);
}
