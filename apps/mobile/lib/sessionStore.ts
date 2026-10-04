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
import {
  e2eStorageKey,
  legacyE2eStorageKey,
  sessionStorageKey,
  withoutTrailingSlash,
} from './storageKeys.ts';
import type { PendingLogout } from './deferredLogout.ts';
import { normalizeProviderKind } from './provider.ts';

/** SHA-256 hexadécimal — l'implémentation de `Hacheur` côté application. */
export function hash(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
}

/**
 * La dérivation des noms de clés vit dans `lib/storageKeys.ts`, sans
 * dépendance à `expo`, parce que c'est elle qui décide de l'isolation entre
 * comptes — et que cela se prouve par des tests, pas par une relecture.
 */
const key = (baseUrl: string): Promise<string> => sessionStorageKey(baseUrl, hash);

/**
 * iOS : lisible par la Notification Service Extension, qui tourne aussi
 * écran verrouillé (plugins/ios-notification-service). Le défaut
 * `WHEN_UNLOCKED` la cacherait à chaque push reçu téléphone en poche. Sans
 * effet sous Android.
 */
const PUSH_EXTENSION_ACCESS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(await key(session.baseUrl), JSON.stringify(session), PUSH_EXTENSION_ACCESS);
}

export async function readSession(baseUrl: string): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(await key(baseUrl));
  if (raw === null) return null;
  try {
    const session = JSON.parse(raw) as Session;
    // Un stockage corrompu ou d'une ancienne version ne doit pas faire planter
    // le démarrage : on le traite comme une absence de session.
    if (typeof session?.authToken !== 'string' || typeof session?.userId !== 'string') return null;
    // La clé dérive d'un condensé tronqué : on ne se fie pas à elle seule pour
    // affirmer que cette session appartient bien au serveur demandé.
    if (withoutTrailingSlash(session.baseUrl) !== withoutTrailingSlash(baseUrl)) return null;
    // Migration à la lecture : les sessions d'avant les champs `genre` et
    // `siteUrl` retombent sur leurs replis (`rocketchat`, null → `baseUrl` à
    // l'usage), sans réécriture.
    return {
      ...session,
      genre: normalizeProviderKind(session.genre),
      siteUrl: typeof session.siteUrl === 'string' ? session.siteUrl : null,
    };
  } catch {
    return null;
  }
}

export async function clearSession(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await key(baseUrl));
}

/**
 * Clé privée E2EE déchiffrée (JWK JSON), rangée dans le Keystore par
 * **(serveur, compte)** — comme la base SQLite, et contrairement à la session,
 * qui est bien du serveur. Sa présence = ce compte est « déverrouillé » : au
 * redémarrage on réimporte sans redemander le mot de passe E2E. Verrouiller =
 * l'effacer. On stocke le JWK DÉCHIFFRÉ (le blob chiffré du serveur ne servirait
 * à rien sans le mot de passe) : c'est le même compromis que la session en clair
 * dans le Keystore — protégé par l'écran de verrouillage de l'appareil, hors
 * périmètre du modèle de menace E2EE (qui vise le serveur).
 *
 * L'indexation par compte n'est pas une commodité : rangée par serveur seul,
 * la clé d'un compte était réimportée pour le suivant. Voir `storageKeys.ts`.
 */
export async function saveE2EPrivateKey(
  baseUrl: string,
  userId: string,
  jwkJson: string,
): Promise<void> {
  await SecureStore.setItemAsync(await e2eStorageKey(baseUrl, userId, hash), jwkJson);
}

export async function readE2EPrivateKey(
  baseUrl: string,
  userId: string,
): Promise<string | null> {
  return SecureStore.getItemAsync(await e2eStorageKey(baseUrl, userId, hash));
}

export async function clearE2EPrivateKey(
  baseUrl: string,
  userId: string,
): Promise<void> {
  await SecureStore.deleteItemAsync(await e2eStorageKey(baseUrl, userId, hash));
}

/**
 * Efface l'entrée E2EE de l'ANCIEN format, indexée par serveur seul.
 *
 * Sans elle, la correction ci-dessus laisserait sur l'appareil, pour toujours,
 * un JWK RSA **déchiffré** que plus aucun code ne saurait retrouver —
 * `expo-secure-store` n'énumère pas ses clés. On ne la LIT jamais : la relire
 * pour la « migrer » rejouerait exactement le défaut corrigé, puisque rien ne
 * dit à quel compte elle appartenait.
 *
 * Appelée au raccordement plutôt qu'à la déconnexion : un utilisateur qui ne
 * se déconnecte jamais est le cas courant, et c'est justement lui qui garde
 * l'orpheline.
 */
export async function purgeLegacyE2EKey(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await legacyE2eStorageKey(baseUrl, hash));
}

/**
 * Le même balayage, sur TOUS les serveurs où une session a existé.
 *
 * Purger le seul serveur actif ne suffit pas, et c'est le piège de cette
 * migration : l'utilisateur qui avait déverrouillé E2E sur un serveur puis l'a
 * quitté — bascule, ou déconnexion d'avant la correction, qui n'effaçait pas la
 * clé — garde son JWK RSA déchiffré sous une clé que plus personne ne dérive.
 * « Introuvable » voudrait alors dire **indestructible**.
 *
 * Le registre `serveurs-connus` existe exactement pour contourner la
 * non-énumérabilité du Keystore, et il est déjà peuplé par les sessions
 * d'avant. Joué une fois par démarrage : quelques suppressions d'entrées
 * absentes, ce que `deleteItemAsync` traite sans erreur.
 */
export async function purgeAllLegacyE2EKeys(): Promise<void> {
  for (const url of await listKnownServers()) {
    await purgeLegacyE2EKey(url);
  }
}

/**
 * Le serveur de la dernière session ouverte. Les sessions sont rangées par
 * condensé d'URL : sans ce pointeur, le démarrage ne saurait pas laquelle
 * reprendre. L'étape 5.3 (multi-serveurs) en fera le « serveur actif ».
 */
const LAST_SERVER_KEY = 'dernier-serveur';

export async function saveLastServer(baseUrl: string): Promise<void> {
  await SecureStore.setItemAsync(LAST_SERVER_KEY, withoutTrailingSlash(baseUrl));
}

export async function readLastServer(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_SERVER_KEY);
}

/**
 * Registre des serveurs où une session a existé. Nécessaire parce que
 * `expo-secure-store` ne sait PAS énumérer ses clés : sans cette liste,
 * impossible de proposer « repasser sur tel serveur ».
 */
const KNOWN_SERVERS_KEY = 'serveurs-connus';

export async function listKnownServers(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(KNOWN_SERVERS_KEY);
  if (raw === null) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveKnownServer(baseUrl: string): Promise<void> {
  const clean = withoutTrailingSlash(baseUrl);
  const list = await listKnownServers();
  if (list.includes(clean)) return;
  await SecureStore.setItemAsync(KNOWN_SERVERS_KEY, JSON.stringify([...list, clean]));
}

/**
 * Le dernier jeton FCM qu'on a enregistré auprès d'un serveur.
 *
 * Retenu à l'ENREGISTREMENT, pas au moment de s'en servir. La déconnexion en
 * avait besoin et le redemandait à `obtenirJetonFcm()`, ce qui a deux défauts :
 * la fonction crée le canal de notification et appelle
 * `requestPermissionsAsync()` — se déconnecter pouvait donc faire surgir un
 * prompt système —, et sur un appareil sans Play Services elle ne rend rien du
 * tout, si bien qu'aucun `DELETE` n'était même tenté. Le jeton FCM est propre à
 * l'APPAREIL, pas au serveur : une seule clé suffit.
 */
const PUSH_TOKEN_KEY = 'jeton-push-appareil';

export async function rememberPushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
}

export function readRememberedPushToken(): Promise<string | null> {
  return SecureStore.getItemAsync(PUSH_TOKEN_KEY);
}

/**
 * Déconnexions que le réseau n'a pas laissées aboutir, à terminer au prochain
 * démarrage. Voir `lib/deferredLogout.ts` pour le pourquoi.
 *
 * Même patron que `serveurs-connus` : `expo-secure-store` ne sait pas énumérer
 * ses clés, donc une liste JSON sous une clé fixe. Le nom ne commence
 * délibérément PAS par `session-` : le service natif de notifications balaye
 * les préférences en cherchant ce préfixe (`plugins/with-fcm-deeplink.js`), et
 * mieux vaut ne pas dépendre de ses gardes internes pour l'écarter.
 *
 * Une entrée par serveur, écrasée si elle existe : se déconnecter deux fois du
 * même serveur ne peut pas faire grandir la file.
 */
const LOGOUTS_KEY = 'deconnexions-en-suspens';

export async function listPendingLogouts(): Promise<PendingLogout[]> {
  const raw = await SecureStore.getItemAsync(LOGOUTS_KEY);
  if (raw === null) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    // Parse défensif, comme `lireSession` : une entrée d'une ancienne version
    // ou tronquée ne doit pas faire échouer tout le démarrage.
    return list.filter(
      (d): d is PendingLogout =>
        typeof (d as PendingLogout)?.baseUrl === 'string' &&
        typeof (d as PendingLogout)?.authToken === 'string' &&
        typeof (d as PendingLogout)?.userId === 'string',
    );
  } catch {
    return [];
  }
}

export async function addPendingLogout(entry: PendingLogout): Promise<void> {
  const clean = { ...entry, baseUrl: withoutTrailingSlash(entry.baseUrl) };
  const others = (await listPendingLogouts()).filter((d) => d.baseUrl !== clean.baseUrl);
  await SecureStore.setItemAsync(LOGOUTS_KEY, JSON.stringify([...others, clean]));
}

export async function removePendingLogout(baseUrl: string): Promise<void> {
  const clean = withoutTrailingSlash(baseUrl);
  const remaining = (await listPendingLogouts()).filter((d) => d.baseUrl !== clean);
  if (remaining.length === 0) {
    await SecureStore.deleteItemAsync(LOGOUTS_KEY);
    return;
  }
  await SecureStore.setItemAsync(LOGOUTS_KEY, JSON.stringify(remaining));
}
