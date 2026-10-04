/**
 * Appels vidéo — la visioconférence Rocket.Chat.
 *
 * Le moteur est le fournisseur configuré CÔTÉ SERVEUR (Jitsi sur la cible
 * `chat.barrut.me`). Comme partout, on AGIT en REST — jamais de méthode DDP,
 * dépréciée depuis 8.0 :
 *
 *   - `video-conference.start`  crée la conférence ET poste le message d'appel
 *     dans le salon ; renvoie un `callId`.
 *   - `video-conference.join`   renvoie l'URL du fournisseur (JWT inclus) qu'on
 *     ouvre pour entrer dans l'appel.
 *   - `video-conference.capabilities` sert de SONDE de disponibilité : le serveur
 *     répond 400 `no-videoconf-provider-app` quand aucun fournisseur n'est
 *     branché (cas du Docker local) — on masque alors le bouton d'appel.
 *
 * Le RENDU de l'appel vit dans une WebView (`app/call/[callId].tsx`) : Jitsi
 * est une web-app, donc la charger dans une WebView est le seul chemin IN-APP
 * raisonnable. Le SDK natif Jitsi vise `react-native ~0.79` (on est en 0.86) et
 * embarque react-native-webrtc — trop risqué sous New Architecture pour le gain.
 *
 * Module sans `react-native` : il ne dépend que du client REST, comme `rest.ts`.
 */

import { ErreurRest, estJetonRefuse } from './rest.ts';
import type { ClientRest } from './rest.ts';

const chaine = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

type ReponseStart = { data?: { callId?: unknown } };
type ReponseJoin = { url?: unknown };

/**
 * Démarre une conférence dans le salon `roomId` et renvoie son `callId`. C'est
 * aussi cet appel qui fait apparaître le message « appel démarré » chez tous les
 * membres du salon — c'est ainsi qu'un correspondant est prévenu, puisque la
 * sonnerie mobile (`VideoConf_Mobile_Ringing`) est désactivée sur la cible.
 */
export async function demarrerConference(client: ClientRest, roomId: string): Promise<string> {
  const r = await client.post<ReponseStart>('video-conference.start', { corps: { roomId } });
  const callId = chaine(r.data?.callId);
  if (callId === null) throw new ErreurRest("Le serveur n'a pas renvoyé d'identifiant d'appel.", 0);
  return callId;
}

/**
 * URL du fournisseur à ouvrir pour REJOINDRE l'appel `callId` (JWT inclus si le
 * serveur exige l'authentification Jitsi). `etat` pré-règle caméra/micro à
 * l'entrée ; omis, on laisse le fournisseur décider.
 */
export async function rejoindreConference(
  client: ClientRest,
  callId: string,
  etat?: { cam?: boolean; mic?: boolean },
): Promise<string> {
  const r = await client.post<ReponseJoin>('video-conference.join', {
    corps: etat === undefined ? { callId } : { callId, state: etat },
  });
  const url = chaine(r.url);
  if (url === null) throw new ErreurRest("Le serveur n'a pas renvoyé d'URL d'appel.", 0);
  return url;
}

/**
 * Disponibilité de la visioconférence, MÉMOÏSÉE par serveur : la sonde ne coûte
 * qu'un appel par session, quel que soit le nombre de salons ouverts.
 *
 * Un fournisseur absent (400) est un « non » DÉFINITIF pour la session → mémoïsé.
 * Une panne réseau (`statut === 0`) est incertaine → on ne la mémoïse pas, la
 * prochaine ouverture de salon retentera. En cas de doute, on renvoie `false` :
 * mieux vaut un bouton qui manque qu'un bouton qui échoue au tap.
 *
 * « Par session » n'était pas tenu : le store est au niveau module, donc c'était
 * par PROCESS. D'où `oublierDisponibiliteAppel`, appelé en fin de session.
 */
const dispoParServeur = new Map<string, boolean>();

export async function sonderAppelDisponible(client: ClientRest): Promise<boolean> {
  const memo = dispoParServeur.get(client.baseUrl);
  if (memo !== undefined) return memo;
  try {
    await client.get('video-conference.capabilities');
    dispoParServeur.set(client.baseUrl, true);
    return true;
  } catch (e) {
    // Un 401 ne dit rien de la visioconférence — il dit que la session est
    // finie. Le mémoïser éteignait le bouton 📞 pour la vie du process, y
    // compris après une reconnexion réussie, et aucun geste n'en sortait.
    if (e instanceof ErreurRest && e.statut !== 0 && !estJetonRefuse(e)) {
      dispoParServeur.set(client.baseUrl, false);
    }
    return false;
  }
}

/** Fin de session / changement de serveur : le verdict est celui d'un compte. */
export function oublierDisponibiliteAppel(): void {
  dispoParServeur.clear();
}

/**
 * Lecture SYNCHRONE du memo, sans sonder : `false` tant qu'on ne sait pas (même
 * défaut prudent que la sonde). Sert à figer la présence du bouton « Appeler »
 * dès la première frame quand la sonde a déjà tourné (fiche préchargée).
 */
export function appelDisponibleMemo(client: ClientRest): boolean {
  return dispoParServeur.get(client.baseUrl) ?? false;
}
