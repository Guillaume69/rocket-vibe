/**
 * Noms des clés du Keystore (`expo-secure-store`), dérivés ici et nulle part
 * ailleurs.
 *
 * Isolé dans son propre module — sans dépendance à `expo` — pour la même
 * raison que `db/fileName.ts` : ce qui décide de l'ISOLATION entre comptes
 * doit être éprouvé par des tests, pas relu. Le condensé est injecté
 * (`Hacheur`), donc les tests tournent sous Node avec `node:crypto` là où
 * l'app utilise `expo-crypto`.
 *
 * Deux portées, et c'est tout le sujet :
 *
 * - la **session** est rangée par SERVEUR. C'est correct : on veut justement
 *   qu'une session par serveur cohabite, et le compte est ce qu'on y lit.
 * - la **clé privée E2EE** est rangée par (SERVEUR, COMPTE). Elle ne l'était
 *   pas, et c'était un vrai trou : au démarrage, `e2e.reprendre()` réimportait
 *   la clé du compte précédent pour le compte suivant. Le JWK étant valide,
 *   l'import RÉUSSIT, l'app se croit déverrouillée, et le déchiffrement des
 *   clés de salon échoue en silence — « chiffré, lecture seule » sans aucun
 *   chemin visible vers l'écran de déverrouillage.
 *
 * `expo-secure-store` n'accepte que `[A-Za-z0-9._-]` dans ses clés : l'URL,
 * elle, porte `:` et `/`. D'où le condensé, tronqué à 32 caractères — 128 bits
 * d'un SHA-256, largement au-delà de ce qu'exige une collision entre les
 * quelques serveurs d'un même appareil.
 */

import type { Hacheur } from './auth.ts';

/**
 * La clé de stockage, le pointeur « dernier serveur » et la comparaison de
 * `lireSession` doivent réduire l'URL EXACTEMENT pareil, sinon une session
 * enregistrée devient introuvable au démarrage. Un seul point de vérité.
 */
export const sansSlashFinal = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

/** Clé de la session d'un serveur. Volontairement indépendante du compte. */
export async function cleSession(baseUrl: string, hacher: Hacheur): Promise<string> {
  return `session-${(await hacher(sansSlashFinal(baseUrl))).slice(0, 32)}`;
}

/**
 * Clé privée E2EE, propre au couple (serveur, compte).
 *
 * Le séparateur `|` ne peut apparaître ni dans une URL réduite ni dans un
 * identifiant Mongo : sans lui, `('https://x/a', 'b')` et `('https://x/ab',
 * '')` se condenseraient pareil.
 */
export async function cleE2E(
  baseUrl: string,
  utilisateurId: string,
  hacher: Hacheur,
): Promise<string> {
  const empreinte = await hacher(`${sansSlashFinal(baseUrl)}|${utilisateurId}`);
  return `e2e-${empreinte.slice(0, 32)}`;
}

/**
 * L'ANCIENNE clé E2EE, dérivée du serveur seul.
 *
 * Elle n'est plus jamais lue — la relire serait rejouer exactement le défaut
 * qu'on corrige. Elle sert uniquement à EFFACER l'entrée devenue orpheline :
 * ce qu'elle contient est un JWK RSA **déchiffré**, le secret le plus sensible
 * de l'app, et `expo-secure-store` ne sait pas énumérer ses clés — sans cette
 * dérivation, plus rien au monde ne pourrait la retrouver pour la supprimer.
 */
export async function cleE2EHeritee(baseUrl: string, hacher: Hacheur): Promise<string> {
  return `e2e-${(await hacher(sansSlashFinal(baseUrl))).slice(0, 32)}`;
}
