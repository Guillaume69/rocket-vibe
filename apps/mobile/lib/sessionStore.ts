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
  cleE2E,
  cleE2EHeritee,
  cleSession,
  sansSlashFinal,
} from './clesStockage.ts';
import type { DeconnexionEnSuspens } from './deconnexionDifferee.ts';
import { normaliserGenre } from './fournisseur.ts';

/** SHA-256 hexadécimal — l'implémentation de `Hacheur` côté application. */
export function hacher(texte: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, texte);
}

/**
 * La dérivation des noms de clés vit dans `lib/clesStockage.ts`, sans
 * dépendance à `expo`, parce que c'est elle qui décide de l'isolation entre
 * comptes — et que cela se prouve par des tests, pas par une relecture.
 */
const cle = (baseUrl: string): Promise<string> => cleSession(baseUrl, hacher);

/**
 * iOS : lisible par la Notification Service Extension, qui tourne aussi
 * écran verrouillé (plugins/ios-notification-service). Le défaut
 * `WHEN_UNLOCKED` la cacherait à chaque push reçu téléphone en poche. Sans
 * effet sous Android.
 */
const ACCES_EXTENSION_PUSH: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function enregistrerSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(await cle(session.baseUrl), JSON.stringify(session), ACCES_EXTENSION_PUSH);
}

export async function lireSession(baseUrl: string): Promise<Session | null> {
  const brut = await SecureStore.getItemAsync(await cle(baseUrl));
  if (brut === null) return null;
  try {
    const session = JSON.parse(brut) as Session;
    // Un stockage corrompu ou d'une ancienne version ne doit pas faire planter
    // le démarrage : on le traite comme une absence de session.
    if (typeof session?.authToken !== 'string' || typeof session?.userId !== 'string') return null;
    if (session.genre != null && session.genre !== 'rocketchat' && session.genre !== 'rocketvibe') return null;
    if (session.genre === 'rocketvibe' && (!session.nativeInstanceId || !session.nativeDataEpoch || typeof session.nativeInstanceId !== 'string' || typeof session.nativeDataEpoch !== 'string')) return null;
    // La clé dérive d'un condensé tronqué : on ne se fie pas à elle seule pour
    // affirmer que cette session appartient bien au serveur demandé.
    if (sansSlashFinal(session.baseUrl) !== sansSlashFinal(baseUrl)) return null;
    // Migration à la lecture : les sessions d'avant les champs `genre` et
    // `siteUrl` retombent sur leurs replis (`rocketchat`, null → `baseUrl` à
    // l'usage), sans réécriture.
    return {
      ...session,
      genre: normaliserGenre(session.genre),
      siteUrl: typeof session.siteUrl === 'string' ? session.siteUrl : null,
    };
  } catch {
    return null;
  }
}

export async function effacerSession(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await cle(baseUrl));
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
 * la clé d'un compte était réimportée pour le suivant. Voir `clesStockage.ts`.
 */
export async function enregistrerClePriveeE2E(
  baseUrl: string,
  utilisateurId: string,
  jwkJson: string,
): Promise<void> {
  await SecureStore.setItemAsync(await cleE2E(baseUrl, utilisateurId, hacher), jwkJson);
}

export async function lireClePriveeE2E(
  baseUrl: string,
  utilisateurId: string,
): Promise<string | null> {
  return SecureStore.getItemAsync(await cleE2E(baseUrl, utilisateurId, hacher));
}

export async function effacerClePriveeE2E(
  baseUrl: string,
  utilisateurId: string,
): Promise<void> {
  await SecureStore.deleteItemAsync(await cleE2E(baseUrl, utilisateurId, hacher));
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
export async function purgerCleE2EHeritee(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await cleE2EHeritee(baseUrl, hacher));
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
export async function purgerToutesClesE2EHeritees(): Promise<void> {
  for (const url of await listerServeursConnus()) {
    await purgerCleE2EHeritee(url);
  }
}

/**
 * Le serveur de la dernière session ouverte. Les sessions sont rangées par
 * condensé d'URL : sans ce pointeur, le démarrage ne saurait pas laquelle
 * reprendre. L'étape 5.3 (multi-serveurs) en fera le « serveur actif ».
 */
const CLE_DERNIER_SERVEUR = 'dernier-serveur';

export async function enregistrerDernierServeur(baseUrl: string): Promise<void> {
  await SecureStore.setItemAsync(CLE_DERNIER_SERVEUR, sansSlashFinal(baseUrl));
}

export async function lireDernierServeur(): Promise<string | null> {
  return SecureStore.getItemAsync(CLE_DERNIER_SERVEUR);
}

/**
 * Registre des serveurs où une session a existé. Nécessaire parce que
 * `expo-secure-store` ne sait PAS énumérer ses clés : sans cette liste,
 * impossible de proposer « repasser sur tel serveur ».
 */
const CLE_SERVEURS_CONNUS = 'serveurs-connus';

export async function listerServeursConnus(): Promise<string[]> {
  const brut = await SecureStore.getItemAsync(CLE_SERVEURS_CONNUS);
  if (brut === null) return [];
  try {
    const liste = JSON.parse(brut) as unknown;
    return Array.isArray(liste) ? liste.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export async function enregistrerServeurConnu(baseUrl: string): Promise<void> {
  const propre = sansSlashFinal(baseUrl);
  const liste = await listerServeursConnus();
  if (liste.includes(propre)) return;
  await SecureStore.setItemAsync(CLE_SERVEURS_CONNUS, JSON.stringify([...liste, propre]));
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
const CLE_JETON_PUSH = 'jeton-push-appareil';

export async function retenirJetonPush(jeton: string): Promise<void> {
  await SecureStore.setItemAsync(CLE_JETON_PUSH, jeton);
}

export function lireJetonPushRetenu(): Promise<string | null> {
  return SecureStore.getItemAsync(CLE_JETON_PUSH);
}

/**
 * Déconnexions que le réseau n'a pas laissées aboutir, à terminer au prochain
 * démarrage. Voir `lib/deconnexionDifferee.ts` pour le pourquoi.
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
const CLE_DECONNEXIONS = 'deconnexions-en-suspens';

export async function listerDeconnexionsEnSuspens(): Promise<DeconnexionEnSuspens[]> {
  const brut = await SecureStore.getItemAsync(CLE_DECONNEXIONS);
  if (brut === null) return [];
  try {
    const liste = JSON.parse(brut) as unknown;
    if (!Array.isArray(liste)) return [];
    // Parse défensif, comme `lireSession` : une entrée d'une ancienne version
    // ou tronquée ne doit pas faire échouer tout le démarrage.
    return liste.filter(
      (d): d is DeconnexionEnSuspens =>
        typeof (d as DeconnexionEnSuspens)?.baseUrl === 'string' &&
        typeof (d as DeconnexionEnSuspens)?.authToken === 'string' &&
        typeof (d as DeconnexionEnSuspens)?.userId === 'string',
    );
  } catch {
    return [];
  }
}

export async function ajouterDeconnexionEnSuspens(entree: DeconnexionEnSuspens): Promise<void> {
  const propre = { ...entree, baseUrl: sansSlashFinal(entree.baseUrl) };
  const autres = (await listerDeconnexionsEnSuspens()).filter((d) => d.baseUrl !== propre.baseUrl);
  await SecureStore.setItemAsync(CLE_DECONNEXIONS, JSON.stringify([...autres, propre]));
}

export async function retirerDeconnexionEnSuspens(baseUrl: string): Promise<void> {
  const propre = sansSlashFinal(baseUrl);
  const restantes = (await listerDeconnexionsEnSuspens()).filter((d) => d.baseUrl !== propre);
  if (restantes.length === 0) {
    await SecureStore.deleteItemAsync(CLE_DECONNEXIONS);
    return;
  }
  await SecureStore.setItemAsync(CLE_DECONNEXIONS, JSON.stringify(restantes));
}
