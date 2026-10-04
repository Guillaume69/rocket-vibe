/**
 * Le SEUL endroit de l'app qui appelle `Linking.openURL`.
 *
 * La décision (« cette chaîne peut-elle quitter le processus ? ») vit dans
 * `lib/externalLink.ts`, où elle se teste sans appareil ; ici il ne reste que
 * l'appel natif. Un seul point de passage, pour qu'ajouter demain une carte, un
 * bouton ou un menu qui « ouvre un lien » hérite de la garde au lieu d'avoir à
 * la recopier — c'est en la recopiant qu'on l'oublie.
 */

import { Linking } from 'react-native';

import { peutSortirDuProcessus } from '../lib/externalLink.ts';

/**
 * Ouvre `url` dans l'application du système, si et seulement si c'est du web
 * sans identifiant à nous. Sinon : rien, en silence — l'utilisateur a tapé sur
 * une donnée forgée, il n'y a rien à lui dire.
 */
export function ouvrirLienExterne(url: unknown): void {
  if (!peutSortirDuProcessus(url)) return;
  Linking.openURL(url).catch(() => {});
}
