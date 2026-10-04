/**
 * L'état de notification qui vit HORS de l'arbre React.
 *
 * Module feuille, sans aucun import de `synchro`/`session` — comme
 * [[salonsCharges]], [[filsCharges]] et [[salonChaud]]. C'est délibéré : ces
 * stores sont purgés depuis le cleanup de `SynchroProvider`, et un import
 * croisé y ferait un cycle dont la résolution dépendrait de l'ordre
 * d'évaluation des modules — donc du bundler, donc du mode de build.
 *
 * Deux choses vivent ici parce que deux choses survivent au démontage :
 *
 * - la liste des salons chiffrés, consultée par le handler global de
 *   notifications, lui-même installé au CHARGEMENT DU MODULE. Elle n'était
 *   remplie et vidée que par un composant qui disparaît avec la session : la
 *   liste du compte quitté restait donc en mémoire et continuait de décider du
 *   sort des notifications suivantes ;
 * - le badge d'icône, posé au même endroit. Après une déconnexion, l'icône
 *   gardait le nombre de non-lus de l'ancien compte — indéfiniment, sur un
 *   appareil qui reste déconnecté.
 */

import * as Notifications from 'expo-notifications';

const ridsChiffres = new Set<string>();

/** Ce salon est-il chiffré ? Consulté au moment d'afficher une notification. */
export function isRoomEncrypted(rid: string): boolean {
  return ridsChiffres.has(rid);
}

/** Remplace la liste connue — les salons chiffrés du compte courant. */
export function setEncryptedRooms(rids: Iterable<string>): void {
  ridsChiffres.clear();
  for (const rid of rids) ridsChiffres.add(rid);
}

/** Fin de session / changement de serveur : plus rien de ce compte ne vaut. */
export function forgetNotificationState(): void {
  ridsChiffres.clear();
  Notifications.setBadgeCountAsync(0).catch(() => {});
}
