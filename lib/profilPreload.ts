/**
 * Préchargement de la fiche utilisateur AVANT d'ouvrir la sheet `/profil`.
 *
 * La sheet est une `formSheet` `sheetAllowedDetents: 'fitToContents'` : elle se
 * mesure au PREMIER rendu. Si le contenu (nom, rôles, bio, fuseau, bouton
 * « Appeler ») arrive ensuite en async, la hauteur bondit — le « saut » que
 * l'utilisateur voyait. On casse ça en récupérant `users.info` ET en figeant la
 * sonde d'appel AVANT de naviguer : au montage, l'écran lit cette fiche depuis
 * le cache et démarre déjà complet, à sa hauteur définitive.
 *
 * Le cache n'est PAS un cache de fraîcheur : c'est un tampon de passage entre
 * l'appel pré-navigation et la première frame de l'écran. Chaque ouverture
 * refait l'appel et réécrit l'entrée, donc la fiche affichée est toujours celle
 * qu'on vient de chercher.
 *
 * `client` en singleton (posé par `SessionProvider`) et non passé en paramètre :
 * une mention `@user` dans un corps de message est rendue par de simples
 * fonctions (`ui/markdown.tsx`), sans client sous la main — même raison que le
 * `router` singleton qu'elles utilisent déjà.
 */

import { router } from 'expo-router';

import { sonderAppelDisponible } from './appel.ts';
import type { ClientRest } from './rest.ts';

/** Une des deux formes acceptées par `users.info` (jamais les deux à la fois). */
type ParamsProfil = { username?: string; uid?: string };

/** Brut `users.info` mis en cache : `user` absent ⇒ échec, message dans `erreur`. */
export type ProfilBrut = { user: Record<string, unknown> | undefined; erreur: string | null };

/**
 * Plafond d'attente avant d'ouvrir malgré tout. Sur réseau normal, `users.info`
 * répond bien en-dessous et la sheet s'ouvre déjà complète ; au-delà (réseau qui
 * traîne), on ouvre quand même — l'écran retombe sur son chargement async, avec
 * son squelette. Mieux vaut un tap qui répond qu'un tap qui semble mort.
 */
const PLAFOND_MS = 2000;

let clientActif: ClientRest | null = null;

/** Posé par `SessionProvider` à chaque changement de session. */
export function definirClientProfil(client: ClientRest | null): void {
  clientActif = client;
}

const cache = new Map<string, ProfilBrut>();

function cle(p: ParamsProfil): string {
  return typeof p.username === 'string' && p.username !== ''
    ? `u:${p.username}`
    : `i:${p.uid ?? ''}`;
}

/** Fiche préchargée pour ces params, ou `undefined` si l'écran doit charger lui-même. */
export function lireProfilPrecharge(p: ParamsProfil): ProfilBrut | undefined {
  return cache.get(cle(p));
}

const delai = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Précharge la fiche puis ouvre `/profil`. À utiliser à la place d'un
 * `router.push('/profil')` direct, partout où l'on ouvre une fiche.
 */
export async function ouvrirFicheProfil(p: ParamsProfil): Promise<void> {
  const client = clientActif;
  const k = cle(p);

  // Sans client (cas improbable : avant que la session soit posée) — on ouvre
  // directement, l'écran fera l'appel. On purge toute entrée d'une ouverture
  // précédente pour ne pas servir du périmé.
  if (client === null) {
    cache.delete(k);
    router.push({ pathname: '/profil', params: p });
    return;
  }

  const params: ParamsProfil =
    typeof p.username === 'string' && p.username !== ''
      ? { username: p.username }
      : { uid: p.uid ?? '' };
  const rest = params.username !== undefined ? { username: params.username } : { userId: params.uid };

  const fetchBrut = client
    .get<{ user?: Record<string, unknown> }>('users.info', { params: rest })
    .then<ProfilBrut>((r) => ({ user: r.user, erreur: r.user ? null : 'Profil illisible.' }))
    .catch<ProfilBrut>((e: unknown) => ({
      user: undefined,
      erreur: e instanceof Error ? e.message : 'Profil introuvable.',
    }));

  // On attend AUSSI la sonde d'appel (mémoïsée par serveur) : c'est elle qui
  // décide de la présence du bouton « Appeler », donc de la hauteur finale.
  const brut = await Promise.race<ProfilBrut | null>([
    Promise.all([fetchBrut, sonderAppelDisponible(client)]).then(([b]) => b),
    delai(PLAFOND_MS).then(() => null),
  ]);

  if (brut !== null) {
    cache.set(k, brut);
  } else {
    // Plafond dépassé : ouvrir sans servir une entrée périmée d'avant — l'écran
    // relira un miss et fera son propre chargement async.
    cache.delete(k);
  }
  router.push({ pathname: '/profil', params: p });
}
