/**
 * Ce qui a le droit de SORTIR du processus.
 *
 * Ouvrir une URL avec `Linking.openURL`, c'est émettre un intent `VIEW` : la
 * chaîne part vers le navigateur (donc son historique, synchronisé vers le
 * compte Google) et vers toute application qui déclare gérer le schéma. Deux
 * choses doivent donc être vraies AVANT de la confier au système.
 *
 * 1. **Le schéma est du web.** `javascript:`, `intent:`, `file:`, `content:`
 *    restent lettre morte. Les URL affichées viennent du markdown, des aperçus
 *    de lien (`message.urls`) et des pièces jointes — toutes des données
 *    d'autrui, stockées brutes en base et projetées sans validation.
 * 2. **Elle ne porte aucun de nos identifiants.** `urlFichierProtege`
 *    (lib/upload.ts) colle `rc_uid` et `rc_token` en query, parce que le
 *    middleware de fichiers protégés de Rocket.Chat s'authentifie ainsi. Un
 *    `rc_token` vaut le compte entier. Une telle URL est faite pour être
 *    consommée DANS le processus (`<Image>`, lecteur vidéo, téléchargement) et
 *    nulle part ailleurs.
 *
 * Le second point est un filet, pas la correction : le chemin qui fuyait (la
 * branche « fichier » de `ui/ligneMessage.tsx`) ne passe plus du tout par
 * l'ouverture externe, il télécharge et partage un fichier LOCAL. Ce garde-fou
 * est là pour qu'une réintroduction du même défaut, ailleurs, échoue au lieu de
 * fuir en silence — et il se teste, lui.
 *
 * Module pur : `ui/lienExterne.ts` porte l'appel à `Linking`.
 */

/** Seuls schémas confiés au système. */
const WEB = /^https?:\/\//i;

/**
 * Nos identifiants de session, tels que `urlFichierProtege` les pose en query.
 * Volontairement large (pas d'ancrage sur `?`/`&`) : mieux vaut refuser une URL
 * externe exotique qui contiendrait littéralement `rc_token=` que laisser
 * passer une forme à laquelle on n'aurait pas pensé.
 */
const IDENTIFIANTS = /\brc_(token|uid)=/i;

/** Vrai si `url` est une chaîne `http(s)://…`. */
export function estLienWeb(url: unknown): url is string {
  return typeof url === 'string' && WEB.test(url);
}

/** Vrai si l'URL transporte `rc_uid` ou `rc_token`. */
export function porteUnIdentifiant(url: string): boolean {
  return IDENTIFIANTS.test(url);
}

/**
 * La seule question à poser avant `Linking.openURL` : cette chaîne peut-elle
 * quitter le processus ?
 */
export function peutSortirDuProcessus(url: unknown): url is string {
  return estLienWeb(url) && !porteUnIdentifiant(url);
}
