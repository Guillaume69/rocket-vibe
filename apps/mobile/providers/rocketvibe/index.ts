/** Native protocol adapter for the existing screens; NativeChat owns journal/outbox commits. */
import type { Session } from '../../lib/auth.ts';
import type { Capabilities, Provider, Listener, FileOutbox } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import { NativeChat } from './chat.ts';
import { NativeStore, localMessage } from './store.ts';
import { decodeNative } from './validation.ts';
import { NativeError } from './transport.ts';
import { describeProviderError } from '../../lib/providerError.ts';
import type { Capabilities as NativeCapabilities } from './protocol.generated.ts';
import {NativeFileOutbox} from './uploads.ts';

export const ROCKETVIBE_CAPABILITIES: Capabilities = {
  editing:true, deletion:true,
  typing:true, presence:true, push:false, e2ee:false, customEmojis:true,
  search:true, threadTemplate:'root_id',
  files:true, threads:true, reactions:true, marks:true, profile:true, roomInfo:true, roomFavorites:true, quotes:true,
  roomSettings:true,roomRoleList:true,leaveRoom:true,roomReads:true,
  // Jitsi is retired from the native server: rooms call through voice sessions.
  videoCall:false,voice:false,
};
const unsupported = async (): Promise<never> => { throw new NativeError(501,'unsupported_feature'); };
const noSubscription = () => () => {};

/** Both the server and this client must implement a feature before exposing it. */
export function effectiveCapabilities(announcement: NativeCapabilities | null, client: Capabilities = ROCKETVIBE_CAPABILITIES): Capabilities {
  const both = (a: boolean | undefined, b: boolean | undefined) => a === true && b === true;
  return {
    threadTemplate:client.threadTemplate,
    editing:both(announcement?.editing,client.editing), deletion:both(announcement?.deletion,client.deletion),
    typing:both(announcement?.typing,client.typing), presence:both(announcement?.presence,client.presence),
    push:both(announcement?.push,client.push), e2ee:both(announcement?.e2ee,client.e2ee),
    customEmojis:both(announcement?.custom_emojis,client.customEmojis), videoCall:both(announcement?.calls,client.videoCall),
    search:both(announcement?.search,client.search), files:both(announcement?.uploads,client.files),
    threads:both(announcement?.threads,client.threads), reactions:both(announcement?.reactions,client.reactions),
    marks:both(announcement?.pins && announcement?.stars,client.marks), profile:both(announcement?.profiles,client.profile),
    roomInfo:both(announcement?.room_info,client.roomInfo), roomFavorites:both(announcement?.favorites,client.roomFavorites), quotes:both(announcement?.quotes,client.quotes),
    roomSettings:both(announcement?.room_settings,client.roomSettings),roomRoleList:both(announcement?.room_roles,client.roomRoleList),leaveRoom:both(announcement?.room_leave,client.leaveRoom),
    roomReads:both(announcement?.read_markers,client.roomReads),
    voice:both(announcement?.voice,client.voice),
  };
}

export function createRocketVibeProvider(session: Session, client: RestClient, generateId: () => string, store: NativeStore, options: ConstructorParameters<typeof NativeChat>[3] = {}): Provider {
  let filesConnected=false;
  const chat = new NativeChat(session,store,generateId,{revoke: token => client.onTokenRejected?.(token),...options});
  const listener: Listener = {
    get state() { return chat.status.online ? 'authenticated' : 'closed'; },
    connect: () => chat.connect(), close: () => chat.stop(), checkAlive: async () => chat.status.online,
    subscribe:noSubscription, onEvent:fn=>chat.live.onEvent(fn), onLoss:fn=>chat.live.onLoss(fn),
    armedSubscriptions:async () => {}, reset:() => {},
  };
  const files: FileOutbox = {
    progress:new Map(), subscribe:noSubscription, validate:unsupported,
    send:unsupported, process:unsupported, retry:unsupported, discard:unsupported,
  };
  return {
    identity:{kind:'rocketvibe',origin:session.baseUrl,accountId:session.userId,instanceId:session.nativeInstanceId ?? null,generation:session.nativeDataEpoch ?? null},
    describeError:describeProviderError,
    // No private notes here: a refused slash command answers in its HTTP error.
    privateNote:()=>null,
    // An old message is reached by its local rank (`messageRank`), not through
    // the Rocket.Chat context window, which reads these.
    historyRange:unsupported, fetchMessage:unsupported, historyPage:0,
    readProfile:async target=>{
      const p=await chat.profile(target);
      return {_id:p.user.id,username:p.user.username,name:p.user.display_name,status:p.status??'online',statusText:p.status_text,bio:p.bio,avatarETag:p.avatar_file_id??'none'};
    },
    searchMessages:async(rid,text)=>(await chat.searchMessages(rid,text)).map(m=>localMessage(m,session.userId)),
    native:{chat,store}, messageOrder:'sequence', get capabilities() { return effectiveCapabilities(chat.capabilities,{...ROCKETVIBE_CAPABILITIES,files:filesConnected,push:options.pushAndroid===true,voice:options.voice===true}); }, listener,
    translator:{
      translateEvent:() => ({kind:'silence'}),
      toMessage:raw => localMessage(decodeNative('Message',raw),session.userId),
      toRoom:() => null, toSubscription:() => null,
    },
    actions:{
      roomReadState:async rid=>{
        const state=await store.readState(rid);
        if(!state?.membership_version)return null;
        return {adhesion:state.membership_version,rootPosition:state.root_position,replyPosition:state.reply_position,unreadRoots:state.unread_roots,unreadReplies:state.unread_replies,mentions:state.mentions,groupMentions:state.group_mentions};
      },
      roomFavorite:{
        read:async rid=>{
          const state=await store.readState(rid);
          if(!state?.membership_version || state.favorite_revision==null)return null;
          const saved=await store.favoriteIntent(rid);
          return {adhesion:state.membership_version,revision:state.favorite_revision,present:state.favorite,intention:saved?.membership===state.membership_version?{key:saved.input.operation_id,present:saved.input.present,failed:saved.phase==='failed',error:saved.error}:null};
        },
        edit:(rid,present,state)=>{
          if(!state)throw new NativeError(409,'revision_required');
          return chat.setFavorite(rid,present,{membership:state.adhesion,revision:state.revision});
        },
        resume:(rid,key)=>chat.resumeFavorite(rid,key),clear:(rid,key)=>chat.dismissFailedFavorite(rid,key),
      },
      roomInfo:async rid => {
        const details=await chat.roomDetails(rid);
        const capabilities=effectiveCapabilities(chat.capabilities);
        return {id:details.room.id,name:details.room.name,type:details.room.kind==='private'?'p':details.room.kind==='direct'?'d':'c',description:details.description||null,topic:details.topic||null,announcement:details.announcement||null,members:details.member_count,readOnly:details.read_only,
          management:{name:details.room.name,isPrivate:details.room.kind==='private',topic:details.topic,description:details.description,announcement:details.announcement,readOnly:details.read_only,revision:details.revision,role:details.permissions.role,
            canEdit:details.permissions.change_settings && !!capabilities.roomSettings,canChangeRoles:details.permissions.role==='owner' && !!capabilities.roomRoleList && details.room.kind!=='direct',canLeave:!!capabilities.leaveRoom && details.room.kind!=='direct'}};
      },
      roomManagement:{
        members:async(rid,continuation,revision)=>{const page=await chat.roomMembers(rid,continuation??undefined,revision);return {revision:page.revision,continuation:page.next??null,members:page.members.map(member=>({id:member.user.id,username:member.user.username,name:member.user.display_name??null,role:member.role,deactivated:member.disabled}))};},
        edit:(rid,revision,fields)=>chat.updateRoom(rid,{expected_revision:revision,name:fields.name,private:fields.isPrivate,topic:fields.topic,description:fields.description,announcement:fields.announcement,read_only:fields.readOnly}),
        changeRole:(rid,revision,target,role)=>chat.changeRoomRole(rid,target,{expected_revision:revision,role}),
        leave:(rid,revision)=>chat.leaveRoom(rid,revision),resume:rid=>chat.resumeRoomOperation(rid),clear:(rid,key)=>chat.dismissRoomOperation(rid,key),
        intention:async rid=>{const saved=await store.roomOperation(rid);if(!saved)return null;const command=saved.command;
          return {key:command.input.operation_id,type:command.kind==='settings'?'settings':command.kind==='role'?'role':'leave',settings:command.kind==='settings'?{name:command.input.name,isPrivate:command.input.private,topic:command.input.topic,description:command.input.description,announcement:command.input.announcement,readOnly:command.input.read_only}:null,target:command.kind==='role'?command.target:null,role:command.kind==='role'?command.input.role:null,failed:saved.failed,error:saved.error};},
      },
      react:(rid,id,emoji,present) => chat.react(rid,id,emoji,present),
      edit:async (rid,id,text,encryptor,revision) => {
        if (encryptor) return unsupported();
        if (!revision) throw new NativeError(409,'revision_required');
        return chat.edit(rid,id,revision,text);
      },
      delete:async (rid,id,revision) => {
        if (!revision) throw new NativeError(409,'revision_required');
        return chat.delete(rid,id,revision);
      },
      pin:(rid,id) => chat.setMark(rid,id,true,false),
      unpin:(rid,id) => chat.setMark(rid,id,false,false),
      star:(rid,id,present) => chat.setMark(rid,id,present,true),
      listPinned:async rid => (await chat.marked(rid,false)).map(m=>localMessage(m,session.userId)),
      listStarred:async rid => (await chat.marked(rid,true)).map(m=>localMessage(m,session.userId)),
      markRead:async (rid,observation) => {
        if(!observation)throw new NativeError(409,'read_observation_required');
        await chat.markObservedRead(rid,observation.messageId,observation.adhesion);
      },
      openOrCreateDm:async (username,uid) => ({rid:await chat.direct(username,uid), rawRoom:{}}),
    },
    initialSubscriptions:() => [], roomSubscriptions:() => [],
    loadHistory:async (_engine,rid,_type,latest) => {
      const before = await store.oldestPosition(rid);
      await chat.history(rid,latest !== undefined);
      const after = await store.oldestPosition(rid);
      return {oldest:null, movedBack:after !== undefined && (before === undefined || BigInt(after) < BigInt(before))};
    },
    loadThread:(_engine,root,abandoned)=>chat.loadThread(root,abandoned),
    createOutbox:() => ({
      send:async (rid,text,thread,_attachments,quotes=[]) => {
        return chat.send(rid,text,undefined,quotes,thread);
      },
      process:async () => chat.refresh(),
      retry:id => chat.retry(id),
      discard:id => chat.abandon(id),
    }),
    createUploadQueue:(_store,_transport,_ingest,hooks) => {
      filesConnected=!!hooks?.nativeFiles&&hooks.nativeFiles.available!==false;
      return filesConnected?new NativeFileOutbox(chat,hooks!.nativeFiles!,generateId):files;
    },
    catchUpGlobal:async () => {}, catchUpRoom:async () => {}, reconcile:async () => {},
  };
}
