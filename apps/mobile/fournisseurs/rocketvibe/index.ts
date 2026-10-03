/** Native protocol adapter for the existing screens; NativeChat owns journal/outbox commits. */
import type { Session } from '../../lib/auth.ts';
import type { Capacites, Fournisseur, Listener, OutboxFichiers } from '../../lib/fournisseur.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { NativeChat } from './chat.ts';
import { NativeStore, localMessage } from './store.ts';
import { decodeNative } from './validation.ts';
import { NativeError } from './transport.ts';
import { decrireErreurFournisseur } from '../../lib/erreurFournisseur.ts';
import type { Capabilities } from './protocol.generated.ts';
import {NativeFileOutbox} from './uploads.ts';

export const CAPACITES_ROCKETVIBE: Capacites = {
  edition:true, suppression:true,
  typing:true, presence:true, push:false, e2ee:false, emojisCustom:false,
  appelVideo:false, recherche:true, modeleFil:'root_id',
  fichiers:true, fils:true, reactions:true, marques:true, profil:true, infosSalon:true, favorisSalon:true, citations:true,
  reglagesSalon:true,rolesSalon:true,quitterSalon:true,lecturesSalon:true,
};
const unsupported = async (): Promise<never> => { throw new NativeError(501,'unsupported_feature'); };
const noSubscription = () => () => {};

/** Both the server and this client must implement a feature before exposing it. */
export function capacitesEffectives(annonce: Capabilities | null, client: Capacites = CAPACITES_ROCKETVIBE): Capacites {
  const both = (a: boolean | undefined, b: boolean | undefined) => a === true && b === true;
  return {
    modeleFil:client.modeleFil,
    edition:both(annonce?.editing,client.edition), suppression:both(annonce?.deletion,client.suppression),
    typing:both(annonce?.typing,client.typing), presence:both(annonce?.presence,client.presence),
    push:both(annonce?.push,client.push), e2ee:both(annonce?.e2ee,client.e2ee),
    emojisCustom:both(annonce?.custom_emojis,client.emojisCustom), appelVideo:both(annonce?.calls,client.appelVideo),
    recherche:both(annonce?.search,client.recherche), fichiers:both(annonce?.uploads,client.fichiers),
    fils:both(annonce?.threads,client.fils), reactions:both(annonce?.reactions,client.reactions),
    marques:both(annonce?.pins && annonce?.stars,client.marques), profil:both(annonce?.profiles,client.profil),
    infosSalon:both(annonce?.room_info,client.infosSalon), favorisSalon:both(annonce?.favorites,client.favorisSalon), citations:both(annonce?.quotes,client.citations),
    reglagesSalon:both(annonce?.room_settings,client.reglagesSalon),rolesSalon:both(annonce?.room_roles,client.rolesSalon),quitterSalon:both(annonce?.room_leave,client.quitterSalon),
    lecturesSalon:both(annonce?.read_markers,client.lecturesSalon),
  };
}

export function creerFournisseurRV(session: Session, client: ClientRest, genererId: () => string, store: NativeStore, options: ConstructorParameters<typeof NativeChat>[3] = {}): Fournisseur {
  let filesConnected=false;
  const chat = new NativeChat(session,store,genererId,{revoke: token => client.surJetonRefuse?.(token),...options});
  const listener: Listener = {
    get etat() { return chat.status.online ? 'authentifie' : 'ferme'; },
    connecter: () => chat.connect(), fermer: () => chat.stop(), verifierVie: async () => chat.status.online,
    souscrire:noSubscription, surEvenement:fn=>chat.live.surEvenement(fn), surPerte:fn=>chat.live.surPerte(fn),
    souscriptionsArmees:async () => {}, reinitialiser:() => {},
  };
  const fichiers: OutboxFichiers = {
    progression:new Map(), abonner:noSubscription, valider:unsupported,
    envoyer:unsupported, traiter:unsupported, reessayer:unsupported, abandonner:unsupported,
  };
  return {
    identite:{genre:'rocketvibe',origine:session.baseUrl,compteId:session.userId,instanceId:session.nativeInstanceId ?? null,generation:session.nativeDataEpoch ?? null},
    decrireErreur:decrireErreurFournisseur,
    lireProfil:async cible=>{
      const p=await chat.profile(cible);
      return {_id:p.user.id,username:p.user.username,name:p.user.display_name,status:p.status??'online',statusText:p.status_text,bio:p.bio,avatarETag:p.avatar_file_id??'sans-photo'};
    },
    rechercherMessages:async(rid,texte)=>(await chat.searchMessages(rid,texte)).map(m=>localMessage(m,session.userId)),
    native:{chat,store}, ordreMessages:'sequence', get capacites() { return capacitesEffectives(chat.capabilities,{...CAPACITES_ROCKETVIBE,fichiers:filesConnected}); }, listener,
    traducteur:{
      traduireEvenement:() => ({sorte:'silence'}),
      versMessage:brut => localMessage(decodeNative('Message',brut),session.userId),
      versSalon:() => null, versAbonnement:() => null,
    },
    actions:{
      etatLectureSalon:async rid=>{
        const state=await store.readState(rid);
        if(!state?.membership_version)return null;
        return {adhesion:state.membership_version,positionRacines:state.root_position,positionReponses:state.reply_position,racinesNonLues:state.unread_roots,reponsesNonLues:state.unread_replies,mentions:state.mentions,mentionsGroupe:state.group_mentions};
      },
      favoriSalon:{
        lire:async rid=>{
          const state=await store.readState(rid);
          if(!state?.membership_version || state.favorite_revision==null)return null;
          const saved=await store.favoriteIntent(rid);
          return {adhesion:state.membership_version,revision:state.favorite_revision,present:state.favorite,intention:saved?.membership===state.membership_version?{cle:saved.input.operation_id,present:saved.input.present,echouee:saved.phase==='failed',erreur:saved.error}:null};
        },
        modifier:(rid,present,state)=>{
          if(!state)throw new NativeError(409,'revision_required');
          return chat.setFavorite(rid,present,{membership:state.adhesion,revision:state.revision});
        },
        reprendre:(rid,cle)=>chat.resumeFavorite(rid,cle),effacer:(rid,cle)=>chat.dismissFailedFavorite(rid,cle),
      },
      infosSalon:async rid => {
        const details=await chat.roomDetails(rid);
        const capabilities=capacitesEffectives(chat.capabilities);
        return {id:details.room.id,nom:details.room.name,type:details.room.kind==='private'?'p':details.room.kind==='direct'?'d':'c',description:details.description||null,sujet:details.topic||null,annonce:details.announcement||null,membres:details.member_count,lectureSeule:details.read_only,
          gestion:{nom:details.room.name,prive:details.room.kind==='private',sujet:details.topic,description:details.description,annonce:details.announcement,lectureSeule:details.read_only,revision:details.revision,role:details.permissions.role,
            peutModifier:details.permissions.change_settings && !!capabilities.reglagesSalon,peutChangerRoles:details.permissions.role==='owner' && !!capabilities.rolesSalon && details.room.kind!=='direct',peutQuitter:!!capabilities.quitterSalon && details.room.kind!=='direct'}};
      },
      gestionSalon:{
        membres:async(rid,suite,revision)=>{const page=await chat.roomMembers(rid,suite??undefined,revision);return {revision:page.revision,suite:page.next??null,membres:page.members.map(member=>({id:member.user.id,pseudo:member.user.username,nom:member.user.display_name??null,role:member.role,desactive:member.disabled}))};},
        modifier:(rid,revision,champs)=>chat.updateRoom(rid,{expected_revision:revision,name:champs.nom,private:champs.prive,topic:champs.sujet,description:champs.description,announcement:champs.annonce,read_only:champs.lectureSeule}),
        changerRole:(rid,revision,cible,role)=>chat.changeRoomRole(rid,cible,{expected_revision:revision,role}),
        quitter:(rid,revision)=>chat.leaveRoom(rid,revision),reprendre:rid=>chat.resumeRoomOperation(rid),effacer:(rid,cle)=>chat.dismissRoomOperation(rid,cle),
        intention:async rid=>{const saved=await store.roomOperation(rid);if(!saved)return null;const command=saved.command;
          return {cle:command.input.operation_id,type:command.kind==='settings'?'reglages':command.kind==='role'?'role':'depart',reglages:command.kind==='settings'?{nom:command.input.name,prive:command.input.private,sujet:command.input.topic,description:command.input.description,annonce:command.input.announcement,lectureSeule:command.input.read_only}:null,cible:command.kind==='role'?command.target:null,role:command.kind==='role'?command.input.role:null,echouee:saved.failed,erreur:saved.error};},
      },
      reagir:(rid,id,emoji,present) => chat.react(rid,id,emoji,present),
      modifier:async (rid,id,text,chiffreur,revision) => {
        if (chiffreur) return unsupported();
        if (!revision) throw new NativeError(409,'revision_required');
        return chat.edit(rid,id,revision,text);
      },
      supprimer:async (rid,id,revision) => {
        if (!revision) throw new NativeError(409,'revision_required');
        return chat.delete(rid,id,revision);
      },
      epingler:(rid,id) => chat.setMark(rid,id,true,false),
      desepingler:(rid,id) => chat.setMark(rid,id,false,false),
      etoiler:(rid,id,present) => chat.setMark(rid,id,present,true),
      listerEpingles:async rid => (await chat.marked(rid,false)).map(m=>localMessage(m,session.userId)),
      listerEtoiles:async rid => (await chat.marked(rid,true)).map(m=>localMessage(m,session.userId)),
      marquerLu:async (rid,observation) => {
        if(!observation)throw new NativeError(409,'read_observation_required');
        await chat.markObservedRead(rid,observation.messageId,observation.adhesion);
      },
      ouvrirOuCreerDm:async (username,uid) => ({rid:await chat.direct(username,uid), salonBrut:{}}),
    },
    souscriptionsInitiales:() => [], souscriptionsSalon:() => [],
    chargerHistorique:async (_moteur,rid,_type,latest) => {
      const before = await store.oldestPosition(rid);
      await chat.history(rid,latest !== undefined);
      const after = await store.oldestPosition(rid);
      return {plusAncien:null, aRecule:after !== undefined && (before === undefined || BigInt(after) < BigInt(before))};
    },
    chargerFil:(_moteur,root,abandoned)=>chat.loadThread(root,abandoned),
    creerEnvoi:() => ({
      envoyer:async (rid,text,fil,_jointes,citations=[]) => {
        return chat.send(rid,text,undefined,citations,fil);
      },
      traiter:async () => chat.refresh(),
      reessayer:id => chat.retry(id),
      abandonner:id => chat.abandon(id),
    }),
    creerTeleversement:(_depot,_transport,_ingerer,hooks) => {
      filesConnected=!!hooks?.nativeFiles&&hooks.nativeFiles.available!==false;
      return filesConnected?new NativeFileOutbox(chat,hooks!.nativeFiles!,genererId):fichiers;
    },
    rattraperGlobal:async () => {}, rattraperSalon:async () => {}, reconcilier:async () => {},
  };
}
