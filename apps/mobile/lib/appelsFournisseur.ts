import type {ClientRest} from './rest.ts';
import type {Fournisseur} from './fournisseur.ts';
import {definirAppelsFournisseur} from './appel.ts';
import {meetingMediaState} from '../fournisseurs/rocketvibe/meetings.ts';

/** Shared lifetime in the application and in the real HTTP/SQLite bench. */
export function monterAppelsFournisseur(client:ClientRest,fournisseur:Fournisseur):()=>void {
  const chat=fournisseur.native?.chat;
  client.genre=chat?'rocketvibe':'rocketchat';
  return definirAppelsFournisseur(client,chat?{
    disponible:(room,membership)=>chat.callAvailable(room,membership),
    memo:()=>chat.callsActive,
    demarrer:(room,membership,alive)=>chat.startCall(room,membership,alive),
    rejoindre:async(id,scope,alive,etat)=>meetingMediaState(await chat.joinCall(id,scope.room,scope.membership,alive),etat),
  }:null);
}
