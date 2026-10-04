/**
 * Terminer une déconnexion que le réseau a interrompue.
 *
 * Se déconnecter, c'est deux gestes serveur : retirer le jeton FCM
 * (`DELETE push.token`) et invalider la session (`POST logout`). Hors ligne,
 * les deux échouent en silence — l'UI est déjà repartie sur l'écran de
 * connexion — et le serveur, lui, n'a rien appris. Il continue donc de pousser
 * des notifications vers un appareil sans compte, et la session reste ouverte
 * côté serveur jusqu'à son expiration.
 *
 * D'où cette file, rejouée au démarrage suivant. Ce qu'elle persiste est le
 * jeton d'authentification d'une session que l'utilisateur vient de quitter :
 * ce n'est pas anodin, et c'est pourtant le bon compromis. Le jeton est
 * **encore vivant côté serveur** — c'est exactement le problème —, il vit au
 * Keystore comme la session dont il sort, et le garder est le seul moyen de le
 * TUER. Le jeter, c'est le laisser ouvert.
 *
 * Volontairement **sans import de `expo`** : la file est injectée, donc toute
 * cette logique se teste sous Node, sans appareil.
 */

import { unregisterToken } from './pushToken.ts';
import { ClientRest, isTokenRejected } from './rest.ts';

export type PendingLogout = {
  baseUrl: string;
  userId: string;
  authToken: string;
  /** Jeton FCM à retirer. `null` si l'appareil n'en avait pas à enregistrer. */
  jetonPush: string | null;
};

export type LogoutQueue = {
  list: () => Promise<PendingLogout[]>;
  remove: (baseUrl: string) => Promise<void>;
};

/**
 * Rejoue les deux gestes, puis solde l'entrée — ou la garde pour plus tard.
 *
 * Trois issues, et c'est la troisième qui compte :
 *
 * - **tout passe** → l'entrée est retirée ;
 * - **panne réseau** (`statut 0`) → l'entrée reste, on retentera au prochain
 *   démarrage. C'est le cas nominal d'une déconnexion faite dans le métro ;
 * - **le serveur refuse le jeton** (401) → l'entrée est retirée elle aussi. Le
 *   jeton est déjà mort : `logout` a pu aboutir là où le `DELETE` avait échoué,
 *   ou le serveur l'a expiré de lui-même. Il n'y a plus rien à tuer, et
 *   retenter éternellement une entrée inutilisable serait pire que de l'oublier
 *   — le jeton push, lui, part avec la session côté serveur.
 *
 * Un `DELETE push.token` sur un jeton déjà retiré répond 404, que
 * `desenregistrerJeton` traite déjà comme un succès : le rejeu est donc sûr.
 */
export async function finishPendingLogouts(
  file: LogoutQueue,
  createClient: (entry: PendingLogout) => ClientRest,
): Promise<void> {
  const entries = await file.list();
  for (const entry of entries) {
    const client = createClient(entry);
    let networkFailure = false;
    // Séquentiel et non `Promise.all` : `logout` invalide le jeton dont le
    // `DELETE` a besoin. L'ordre est le même qu'à la déconnexion nominale.
    const pushToken = entry.jetonPush;
    if (pushToken !== null) {
      networkFailure = !(await attempt(() => unregisterToken(client, pushToken)));
    }
    if (!(await attempt(() => client.post('logout')))) networkFailure = true;
    if (!networkFailure) await file.remove(entry.baseUrl);
  }
}

/**
 * Vrai si le geste est SOLDÉ — abouti, ou définitivement sans objet. Faux
 * seulement si le retenter a un sens.
 */
async function attempt(gesture: () => Promise<unknown>): Promise<boolean> {
  try {
    await gesture();
    return true;
  } catch (e) {
    return isTokenRejected(e);
  }
}
