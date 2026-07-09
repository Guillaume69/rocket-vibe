/**
 * Persistance de la session, **une par serveur**.
 *
 * Le jeton vit dans l'Android Keystore via `expo-secure-store`, jamais dans
 * `AsyncStorage`. La clé dérive du host : plusieurs serveurs cohabitent sans
 * qu'une déconnexion sur l'un touche à l'autre.
 *
 * Seul module de la couche transport à dépendre de la plateforme. Tout le
 * reste (`rest`, `auth`, `ddp`) tourne sous Node, donc se teste pour de vrai.
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import type { Session } from './auth.ts';

/**
 * `expo-secure-store` n'accepte que `[A-Za-z0-9._-]` dans ses clés : l'URL du
 * serveur, elle, contient `:` et `/`. On la réduit à un condensé stable.
 */
async function cle(baseUrl: string): Promise<string> {
  const empreinte = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    baseUrl.replace(/\/+$/, ''),
  );
  return `session-${empreinte.slice(0, 32)}`;
}

/** SHA-256 hexadécimal — l'implémentation de `Hacheur` côté application. */
export function hacher(texte: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, texte);
}

export async function enregistrerSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(await cle(session.baseUrl), JSON.stringify(session));
}

export async function lireSession(baseUrl: string): Promise<Session | null> {
  const brut = await SecureStore.getItemAsync(await cle(baseUrl));
  if (brut === null) return null;
  try {
    const session = JSON.parse(brut) as Session;
    // Un stockage corrompu ou d'une ancienne version ne doit pas faire planter
    // le démarrage : on le traite comme une absence de session.
    if (typeof session?.authToken !== 'string' || typeof session?.userId !== 'string') return null;
    // La clé dérive d'un condensé tronqué : on ne se fie pas à elle seule pour
    // affirmer que cette session appartient bien au serveur demandé.
    if (session.baseUrl.replace(/\/+$/, '') !== baseUrl.replace(/\/+$/, '')) return null;
    return session;
  } catch {
    return null;
  }
}

export async function effacerSession(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await cle(baseUrl));
}
