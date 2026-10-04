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

let identities: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function setIdentities(next: ReadonlyMap<string, string>): void {
  identities = next;
  for (const e of listeners) e();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Map `uid → pseudo courant`. Re-rend l'appelant quand une identité change. */
export function useIdentities(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => identities);
}

/**
 * Versions de photo connues, indexées des DEUX façons dont les écrans visent
 * un avatar : par pseudo (messages, mentions, fiche, mon profil) et par uid
 * (l'autre d'un DM, dont on n'a souvent que l'uid).
 */
export type EtagsAvatars = {
  byUid: ReadonlyMap<string, string>;
  byUsername: ReadonlyMap<string, string>;
};

const NO_ETAG: EtagsAvatars = { byUid: new Map(), byUsername: new Map() };
let etags: EtagsAvatars = NO_ETAG;
const etagListeners = new Set<() => void>();

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Ne notifie qu'à un VRAI changement de version. La requête vive rejoue à
 * chaque écriture dans `utilisateurs` — un simple message ingéré, donc — et
 * chaque notification re-rendrait tous les avatars montés à l'écran.
 */
export function setEtags(added: EtagsAvatars): void {
  if (sameMap(etags.byUid, added.byUid) && sameMap(etags.byUsername, added.byUsername)) {
    return;
  }
  etags = added;
  for (const e of etagListeners) e();
}

function subscribeEtags(cb: () => void): () => void {
  etagListeners.add(cb);
  return () => {
    etagListeners.delete(cb);
  };
}

/**
 * Versions de photo à injecter dans `urlAvatar` — c'est ce qui fait bouger
 * l'URI quand quelqu'un change sa photo, cache image compris. Un avatar dont
 * l'etag est encore inconnu s'affiche exactement comme avant : l'URL sans
 * query reste valable.
 */
export function useEtagsAvatars(): EtagsAvatars {
  return useSyncExternalStore(subscribeEtags, () => etags);
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
export function forgetIdentities(): void {
  setIdentities(new Map());
  setEtags(NO_ETAG);
}
