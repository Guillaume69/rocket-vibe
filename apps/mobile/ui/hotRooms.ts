/**
 * Les salons qu'on continue d'ÉCOUTER après en être sorti.
 *
 * Le problème, mesuré sur le serveur réel : rentrer dans un salon qu'on vient
 * de quitter relançait `chat.syncMessages`, qui met **3 secondes** à répondre
 * « rien de neuf » sur un gros salon (l'index Mongo est `{rid, ts, _updatedAt}` ;
 * filtrer sur `_updatedAt` seul oblige le serveur à trier tout le salon). Trois
 * secondes de barre de synchro pour zéro document.
 *
 * Pourquoi cette requête partait : en quittant l'écran on relâchait les
 * souscriptions du salon (celles de `Fournisseur.souscriptionsSalon`), donc son
 * cache n'était plus tenu à jour par le temps réel, et seule une lecture pouvait
 * garantir qu'on n'avait rien manqué. La réponse n'est pas d'attendre moins,
 * c'est de ne pas créer le trou : on GARDE l'écoute ouverte en sortant. Rien
 * n'a pu être manqué, donc il n'y a rien à rattraper.
 *
 * `ddp.souscrire` compte les références (`lib/ddp.ts`) : garder une référence
 * de plus n'envoie aucune `sub` supplémentaire sur le fil — le stream était
 * déjà là, on s'abstient simplement de le fermer.
 *
 * Borné à `MAX` salons, en LRU : sans borne, une session qui visite 25 salons
 * finirait par tous les écouter. Au-delà, le plus anciennement quitté est
 * relâché — et redeviendra un salon à rattraper, ce qui est le comportement
 * d'origine, pas une régression.
 *
 * La `generation` de connexion garde le même rôle qu'ailleurs
 * ([[salonsCharges]]) : une coupure, même brève, invalide la couverture, parce
 * que le trou peut alors être de n'importe quelle taille.
 */

import { invalidateSessionToken, sessionToken } from './sessionToken.ts';

type Release = () => void;

const MAX = 3;

/** Ordre d'insertion = ordre LRU (le premier est le plus anciennement quitté). */
const hot = new Map<string, { generation: number; releases: Release[] }>();

/**
 * Ce salon est-il resté écouté sans interruption depuis sa dernière visite ?
 * Si oui, aucune lecture de rattrapage n'est nécessaire à sa réouverture.
 */
export function roomCovered(rid: string, generation: number): boolean {
  const entry = hot.get(rid);
  return entry !== undefined && entry.generation === generation;
}

/**
 * À la SORTIE d'un salon : on lui laisse ses souscriptions ouvertes et on
 * confie leurs relâcheurs ici.
 *
 * Relâche toujours le jeu précédent du même salon : à la deuxième sortie, l'écran
 * a repris ses propres références au montage, et sans cela chaque aller-retour
 * en accumulerait une de plus.
 *
 * `jeton` est celui capturé au MONTAGE, quand ces souscriptions ont été prises
 * (voir [[jetonSession]]). S'il ne correspond plus, la session à laquelle elles
 * appartenaient est finie — leur client DDP est déjà `reinitialiser()`. On
 * relâche alors sur-le-champ : mémoriser laisserait une entrée FANTÔME que
 * `libererSalonsChauds` ne repassera jamais nettoyer, et qui ferait répondre
 * « rien à rattraper » à la session suivante, pour un salon que sa socket n'a
 * jamais écouté.
 */
export function keepWarm(
  rid: string,
  generation: number,
  releases: Release[],
  token: number,
): void {
  if (token !== sessionToken()) {
    for (const release of releases) release();
    return;
  }
  const old = hot.get(rid);
  if (old !== undefined) for (const release of old.releases) release();
  // Réinsertion en fin de Map : ce salon devient le plus récemment quitté.
  hot.delete(rid);
  hot.set(rid, { generation, releases });

  while (hot.size > MAX) {
    const oldest = hot.keys().next().value;
    if (oldest === undefined) break;
    const outgoing = hot.get(oldest);
    if (outgoing !== undefined) for (const release of outgoing.releases) release();
    hot.delete(oldest);
  }
}

/** Fin de session / changement de serveur : on ferme tout ce qu'on tenait. */
export function releaseHotRooms(): void {
  for (const entry of hot.values()) {
    for (const release of entry.releases) release();
  }
  hot.clear();
  // Et plus rien de cette session n'a le droit de repeupler la table : les
  // écrans encore montés vont appeler `garderAuChaud` en se démontant.
  invalidateSessionToken();
}
