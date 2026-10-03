/**
 * Appels vidéo dans les écrans existants, avec le fournisseur de la session.
 * RocketVibe utilise la liaison native ci-dessous ; Rocket.Chat conserve ses
 * endpoints REST de visioconférence.
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
 * Le RENDU de l'appel vit dans une WebView (`app/appel/[callId].tsx`) : Jitsi
 * est une web-app, donc la charger dans une WebView est le seul chemin IN-APP
 * raisonnable. Le SDK natif Jitsi vise `react-native ~0.79` (on est en 0.86) et
 * embarque react-native-webrtc — trop risqué sous New Architecture pour le gain.
 *
 * Module sans `react-native` : il ne dépend que du client REST, comme `rest.ts`.
 */

import { ErreurRest, estJetonRefuse } from './rest.ts';
import type { ClientRest } from './rest.ts';

export type PorteeAppel={room?:string;membership?:string|null;alive?:()=>boolean};
export type AppelsNatifs={
  disponible:(room?:string,membership?:string|null)=>Promise<boolean>;
  memo:()=>boolean;
  demarrer:(room:string,membership:string|null|undefined,alive:()=>boolean)=>Promise<string>;
  rejoindre:(id:string,scope:PorteeAppel,alive:()=>boolean,etat?:{cam?:boolean;mic?:boolean})=>Promise<string>;
};
type Liaison={key:string;appels:AppelsNatifs|null};
const liaisons=new WeakMap<ClientRest,Liaison>(),identites=new WeakMap<ClientRest,string>();
let serial=0;
let dispoParClient=new WeakMap<ClientRest,boolean>();

/** A callback belongs to this provider mount, even when the ClientRest object is reused. */
export function definirAppelsFournisseur(client:ClientRest,appels:AppelsNatifs|null):()=>void {
  const liaison={key:`appels-${++serial}`,appels};liaisons.set(client,liaison);dispoParClient.delete(client);
  return()=>{if(liaisons.get(client)===liaison){liaisons.delete(client);dispoParClient.delete(client);}};
}
/** Ephemeral route scope, containing neither bearer nor participant token. */
export function contexteAppel(client:ClientRest):string {
  const bound=liaisons.get(client);if(bound)return bound.key;
  let id=identites.get(client);if(!id){id=`client-${++serial}`;identites.set(client,id);}return id;
}
function courant(client:ClientRest,liaison:Liaison|undefined,scope:PorteeAppel={}):boolean {
  return liaisons.get(client)===liaison && scope.alive?.()!==false;
}
function verifier(client:ClientRest,liaison:Liaison|undefined,scope:PorteeAppel={}):void {
  if(!courant(client,liaison,scope))throw new Error('call_scope_closed');
  if(client.genre==='rocketvibe'&&!liaison?.appels)throw new Error('call_provider_unavailable');
}

const chaine = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

type ReponseStart = { data?: { callId?: unknown } };
type ReponseJoin = { url?: unknown };

/**
 * Démarre une conférence dans le salon `roomId` et renvoie son `callId`. C'est
 * aussi cet appel qui fait apparaître le message « appel démarré » chez tous les
 * membres du salon — c'est ainsi qu'un correspondant est prévenu, puisque la
 * sonnerie mobile (`VideoConf_Mobile_Ringing`) est désactivée sur la cible.
 */
export async function demarrerConference(client: ClientRest, roomId: string,scope:PorteeAppel={}): Promise<string> {
  const liaison=liaisons.get(client);verifier(client,liaison,scope);
  if(liaison?.appels){
    const id=await liaison.appels.demarrer(roomId,scope.membership,()=>courant(client,liaison,scope));
    verifier(client,liaison,scope);return id;
  }
  const r = await client.post<ReponseStart>('video-conference.start', { corps: { roomId } });
  verifier(client,liaison,scope);
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
  scope:PorteeAppel={},
): Promise<string> {
  const liaison=liaisons.get(client);verifier(client,liaison,scope);
  if(liaison?.appels){
    const url=await liaison.appels.rejoindre(callId,scope,()=>courant(client,liaison,scope),etat);
    verifier(client,liaison,scope);return url;
  }
  const r = await client.post<ReponseJoin>('video-conference.join', {
    corps: etat === undefined ? { callId } : { callId, state: etat },
  });
  verifier(client,liaison,scope);
  const url = chaine(r.url);
  if (url === null) throw new ErreurRest("Le serveur n'a pas renvoyé d'URL d'appel.", 0);
  return url;
}

/**
 * Disponibilité Rocket.Chat, MÉMOÏSÉE par client de session : la sonde ne coûte
 * qu'un appel par session, quel que soit le nombre de salons ouverts.
 *
 * Un fournisseur absent (400) est un « non » DÉFINITIF pour la session → mémoïsé.
 * Une panne réseau (`statut === 0`) est incertaine → on ne la mémoïse pas, la
 * prochaine ouverture de salon retentera. En cas de doute, on renvoie `false` :
 * mieux vaut un bouton qui manque qu'un bouton qui échoue au tap.
 *
 * RocketVibe vérifie la configuration et l'adhésion courantes à chaque sonde.
 */
export async function sonderAppelDisponible(client: ClientRest,room?:string,membership?:string|null): Promise<boolean> {
  const liaison=liaisons.get(client);
  if(liaison?.appels || client.genre==='rocketvibe'){
    if(!liaison?.appels)return false;
    const available=await liaison.appels.disponible(room,membership);
    return courant(client,liaison)&&available;
  }
  const memo = dispoParClient.get(client);
  if (memo !== undefined) return memo;
  try {
    await client.get('video-conference.capabilities');
    if(!courant(client,liaison))return false;
    dispoParClient.set(client, true);
    return true;
  } catch (e) {
    // Un 401 ne dit rien de la visioconférence — il dit que la session est
    // finie. Le mémoïser éteignait le bouton 📞 pour la vie du process, y
    // compris après une reconnexion réussie, et aucun geste n'en sortait.
    if (courant(client,liaison) && e instanceof ErreurRest && e.statut >=400 && e.statut<500 && e.statut!==429 && !estJetonRefuse(e)) {
      dispoParClient.set(client, false);
    }
    return false;
  }
}

/** Fin de session / changement de serveur : le verdict est celui d'un compte. */
export function oublierDisponibiliteAppel(): void {
  dispoParClient=new WeakMap();
}

/**
 * Lecture SYNCHRONE du memo, sans sonder : `false` tant qu'on ne sait pas (même
 * défaut prudent que la sonde). Sert à figer la présence du bouton « Appeler »
 * dès la première frame quand la sonde a déjà tourné (fiche préchargée).
 */
export function appelDisponibleMemo(client: ClientRest): boolean {
  const appels=liaisons.get(client)?.appels;
  if(appels || client.genre==='rocketvibe')return appels?.memo()??false;
  return dispoParClient.get(client) ?? false;
}
