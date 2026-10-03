/** SQLite projection for the native protocol. Batches and their cursor commit together. */
import type { Session as AppSession } from '../../lib/auth.ts';
import type { FileEcritures } from '../../db/fileEcritures.ts';
import type { DepotBrouillons } from '../../db/depot.ts';
import { UPSERT_MESSAGE, UPSERT_SALON, UPSERT_ABONNEMENT, INSERER_SORTIE, SUPPRIMER_SORTIE, MARQUER_SORTIE_ECHEC, SUPPRIMER_BROUILLONS_SALON, paramsMessage, paramsSalon, paramsAbonnement } from '../../db/upserts.ts';
import type { MessageLocal } from '../../lib/normaliser.ts';
import type { Message, Room, RoomDetails, Snapshot, SyncBatch, ReadState, ProfileStamp, LiveRoom } from './protocol.generated.ts';
import {readState,readOrder,readDecimal,readBadges} from './readStates.ts';
import {FAVORITE_SELECT,savedFavorite,type PendingRead,type SavedFavorite,type FavoriteRow} from './readIntents.ts';
import {roomIdentifier,roomOperation,sameRoomForm,savedRoomOperation,type RoomOperation,type RoomOperationRow,type SavedRoomOperation} from './roomOperations.ts';
import {decodeNative} from './validation.ts';
import {nativeMarkdown} from './markdown.ts';
import {nativeSystemMessage} from './systemMessages.ts';
import {NativeMeetingIntents} from './meetings.ts';
import {NativeQuoteCache,type NativeQuoteSelection} from './quotes.ts';
import {NativeThreadCache,type PendingThreadRead} from './threads.ts';
import {NativeProfileOperations} from './profileOperations.ts';
import {NativeUploadIntents} from './uploadIntents.ts';
import {nativeAttachments,fileDescriptor} from './fileDescriptors.ts';
import {emojiCatalog,emojiRevision} from './customEmojis.ts';
import {nativeUrls,linkPreview,previewKey,previewImageIdentity,type PreviewAccess} from './linkPreviews.ts';

// Native revisions, checked below as exact decimal strings, order projection.
// The shared RC statement's wall-clock condition would discard a valid edit
// after a clock correction, even though its native revision is newer.
const NATIVE_UPSERT_MESSAGE=UPSERT_MESSAGE.replace('WHERE excluded.mis_a_jour_le >= messages.mis_a_jour_le','');

type Param = string | number | null;
export interface NativeDatabase {
  runAsync(sql: string, params: Param[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params: Param[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params: Param[]): Promise<T[]>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}
export type NativeState = { instance_id: string; data_epoch: string; cursor: string };
export type NativeRoomRow = { rid: string; nom: string; type: string; dernier_message: string | null };
export type NativeMessageRow = { id: string; texte: string; auteur_nom: string; auteur_id: string; horodatage: number; statut: string | null };
export type NativePending = { id: string; rid: string; texte: string;quotes:import('./protocol.generated.ts').QuoteReference[];reply_to?:string };
export type NativeRoomAccess = {rid:string;revision:string;read_only:number|null;can_send:number|null;role:string|null};
export type NativeCommand = {id:string;rid:string;message_id:string;kind:'edit'|'delete'|'react'|'pin'|'star';expected_revision:string;text:string;quotes:import('./protocol.generated.ts').QuoteReference[]|null};
type NativeCommandRow=Omit<NativeCommand,'quotes'>&{quotes:string|null};
function commandRow(row:NativeCommandRow):NativeCommand {
  const raw:unknown=row.quotes===null?null:JSON.parse(row.quotes);
  if(raw!==null && (!Array.isArray(raw) || raw.length>8))throw new Error('Invalid native edit references');
  return {...row,quotes:raw===null?null:(raw as unknown[]).map(r=>decodeNative('QuoteReference',r))};
}

/** Projection consumed by the existing message renderer and action sheet. */
export function nativeReactions(reactions: Message['reactions']): string|null {
  return reactions?.length ? JSON.stringify(Object.fromEntries(reactions.map(reaction=>[
    `:${reaction.emoji}:`,{usernames:reaction.users.map(user=>user.username)},
  ]))) : null;
}

export function localMessage(message: Message, selfId?: string): MessageLocal {
  const time = Date.parse(message.created_at);
  const edited=message.edited_at==null?null:Date.parse(message.edited_at);
  const system=message.system==null?null:nativeSystemMessage(message.system);
  const replies=readDecimal(message.thread?.replies??'0');
  const last=message.thread?.last_reply_at==null?null:Date.parse(message.thread.last_reply_at);
  if(last!==null && !Number.isFinite(last) || message.reply_to!=null && (!roomIdentifier(message.reply_to) || message.reply_to===message.id || message.thread!=null || system))throw new Error('Invalid native thread message');
  if(system && (message.text!=='' || message.deleted || message.body!=null || message.quotes?.length || message.thread!=null))throw new Error('Invalid native system message');
  if ((edited!==null && !Number.isFinite(edited)) || (message.deleted && message.text!=='')) throw new Error('Invalid native message state');
  if (!Number.isFinite(time) || !/^\d+$/.test(message.position) || !/^\d+$/.test(message.revision)) throw new Error('Invalid native message ordering');
  return {
    id: message.id, rid: message.room_id, texte: system?.param??message.text, horodatage: time,
    auteurId: message.author.id, auteurNom: message.author.username, typeSysteme: system?.type??null,
    filId: message.reply_to??null, filReponses: Number(replies>2147483647n?2147483647n:replies), filDernier: last, filAffiche: false, modifieLe: edited,
    md: message.deleted||system?null:nativeMarkdown(message.body), piecesJointes: nativeAttachments(message), reactions: nativeReactions(message.reactions), urls: nativeUrls(message),
    appelId: message.system?.kind==='call_started' && roomIdentifier(message.system.meeting_id)?message.system.meeting_id:null,
    chiffreBrut: null, epingle: message.pinned ?? false,
    etoiles: message.personal_star?.present && selfId ? JSON.stringify([selfId]) : null, misAJourLe: time,
  };
}

export class NativeStore {
  readonly meetings:NativeMeetingIntents;
  readonly profileOperations:NativeProfileOperations;
  readonly uploads:NativeUploadIntents;
  private readonly db: NativeDatabase;
  private readonly queue: FileEcritures;
  private readonly session: AppSession;
  private readonly quotes:NativeQuoteCache;
  private readonly threads:NativeThreadCache;
  private projection=0;
  private searchRevision=0;
  private fileViews=new Map<string,{file:import('./protocol.generated.ts').FileDescriptor;membership:string;stamp:string}>();
  private previewViews=new Map<string,{access:PreviewAccess;membership:string;stamp:string}>();
  constructor(db: NativeDatabase, queue: FileEcritures, session: AppSession) {
    this.meetings=new NativeMeetingIntents(db,fn=>this.atomic(fn),(room,nonce)=>this.membershipMatches(room,nonce),session.nativeDataEpoch??'');
    this.profileOperations=new NativeProfileOperations(db,fn=>this.atomic(fn),()=>this.sameGeneration());
    this.uploads=new NativeUploadIntents(db,fn=>this.atomic(fn),(rid,membership)=>this.membershipMatches(rid,membership),message=>this.message(message));
    this.db = db; this.queue = queue; this.session = session;this.quotes=new NativeQuoteCache(db,{instance_id:session.nativeInstanceId??'',data_epoch:session.nativeDataEpoch??''});this.threads=new NativeThreadCache(db);
  }
  private atomic<T>(fn: () => Promise<T>, rotate:boolean|(()=>boolean)=false): Promise<T> {
    return this.queue(async () => {
      let result!: T;
      await this.db.withTransactionAsync(async () => { result=await fn(); });
      if (typeof rotate==='function'?rotate():rotate) this.projection++;
      return result;
    });
  }
  projectionToken(): number { return this.projection; }
  searchToken():number {return this.searchRevision;}
  previewAccesses(keys:readonly string[]):Promise<Map<string,PreviewAccess>> {
    if(keys.length>128)throw new Error('Preview cache limit');
    return this.queue(async()=>{
      const result=new Map<string,PreviewAccess>();
      if(!keys.length||!await this.sameGeneration())return result;
      const rows=await this.db.getAllAsync<{id:string;rid:string;revision:string;preview:string;state:string}>(`SELECT m.id,m.rid,p.revision,json_extract(j.value,'$.native_preview') AS preview,s.payload AS state
        FROM messages m JOIN native_positions p ON p.id=m.id JOIN json_each(m.urls) j JOIN native_read_states s ON s.rid=m.rid
        WHERE m.id||'/'||json_extract(j.value,'$.native_preview.image.file_id') IN (SELECT value FROM json_each(?)) LIMIT 129`,[JSON.stringify(keys)]);
      if(rows.length>128)throw new Error('Preview cache limit');
      for(const row of rows){
        const image=linkPreview(JSON.parse(row.preview)).image,state=readState(JSON.parse(row.state),row.rid);
        if(!image||!state.membership_version)continue;
        const key=previewKey(row.id,image.file_id);
        result.set(key,this.previewAccess(row.id,row.rid,state.membership_version,image));
      }
      for(const key of keys){
        if(result.has(key))continue;
        const view=this.previewViews.get(key);
        if(view&&view.stamp===`${this.projection}:${this.searchRevision}`&&await this.membershipMatches(view.access.room,view.membership))result.set(key,view.access);
      }
      return result;
    });
  }
  private previewAccess(message:string,room:string,membership:string,image:import('./protocol.generated.ts').PreviewImage):PreviewAccess {
    return {message,room,image,scope:JSON.stringify([this.session.nativeInstanceId,this.session.nativeDataEpoch,room,membership,previewImageIdentity(image)])};
  }
  /** A file is readable locally only while its live message and grant still exist. */
  fileAccess(id:string):Promise<{file:import('./protocol.generated.ts').FileDescriptor;membership:string}|null>{
    return this.queue(async()=>{
      if(!await this.sameGeneration())return null;
      const quoted=await this.quotes.fileAccess(id);
      if(quoted)return quoted;
      const row=await this.db.getFirstAsync<{rid:string;file:string}>(`SELECT m.rid,json_extract(j.value,'$.native_file') AS file
        FROM messages m JOIN json_each(m.pieces_jointes) j LEFT JOIN native_quote_sources q ON q.id=m.id
        WHERE json_extract(j.value,'$.fileId')=? AND (q.id IS NULL OR q.payload IS NOT NULL) LIMIT 1`,[id]);
      if(!row){
        const view=this.fileViews.get(id);
        return view&&view.stamp===`${this.projection}:${this.searchRevision}`&&(await this.readStateIn(view.file.room_id))?.membership_version===view.membership?{file:view.file,membership:view.membership}:null;
      }
      const membership=(await this.readStateIn(row.rid))?.membership_version;
      return membership?{file:fileDescriptor(JSON.parse(row.file),row.rid),membership}:null;
    });
  }
  /** Temporary search results can open files without enlarging confirmed history. */
  cacheFileViews(messages:Message[],room:string,membership:string,valid:()=>boolean):Promise<void>{
    return this.queue(async()=>{
      if(!valid()||!await this.membershipMatches(room,membership))throw new Error('file_scope_closed');
      const files=messages.flatMap(message=>(message.files??[]).map(file=>fileDescriptor(file,room)));
      const previews:PreviewAccess[]=[];
      for(const message of messages){
        if(message.room_id!==room)throw new Error('preview_scope_closed');
        nativeUrls(message);
        for(const preview of message.previews??[])if(preview.image)previews.push(this.previewAccess(message.id,room,membership,preview.image));
      }
      if(!valid())throw new Error('file_scope_closed');
      for(const file of files){
        this.fileViews.set(file.id,{file,membership,stamp:`${this.projection}:${this.searchRevision}`});
        while(this.fileViews.size>256)this.fileViews.delete(this.fileViews.keys().next().value!);
      }
      for(const access of previews){
        this.previewViews.set(previewKey(access.message,access.image.file_id),{access,membership,stamp:`${this.projection}:${this.searchRevision}`});
        while(this.previewViews.size>128)this.previewViews.delete(this.previewViews.keys().next().value!);
      }
    });
  }
  /** Public identity metadata only; profile bodies and emails stay out of history. */
  profileIdentities(profiles:readonly ProfileStamp[],valid:()=>boolean,peers:readonly LiveRoom[]=[]):Promise<void> {
    return this.atomic(async()=>{
      if(!valid() || !await this.sameGeneration())throw new Error('Stale profile projection');
      for(const p of profiles)await this.db.runAsync(`INSERT INTO utilisateurs(uid,username,avatar_etag,mis_a_jour_le) VALUES(?,?,?,0)
        ON CONFLICT(uid) DO UPDATE SET username=excluded.username,avatar_etag=excluded.avatar_etag
        WHERE username IS NOT excluded.username OR avatar_etag IS NOT excluded.avatar_etag`,[p.user.id,p.user.username,p.avatar_file_id??'sans-photo']);
      for(const room of peers){
        if(!await this.membershipMatches(room.room_id,room.membership_version))throw new Error('Stale direct peer projection');
        const uid=room.direct_peer?.id??null;
        await this.db.runAsync(`UPDATE salons SET dm_autre_uid=? WHERE rid=? AND type='d'
          AND dm_autre_uid IS NOT ?`,[uid,room.room_id,uid]);
      }
      if(!valid())throw new Error('Stale profile projection');
    });
  }
  state(): Promise<NativeState | null> {
    return this.queue(() => this.db.getFirstAsync<NativeState>('SELECT instance_id,data_epoch,cursor FROM native_sync_state WHERE singleton=1', []));
  }
  emojiCatalog():Promise<import('./protocol.generated.ts').EmojiCatalog|null> {
    return this.queue(async()=>{
      if(!await this.sameGeneration())return null;
      const row=await this.db.getFirstAsync<{payload:string|null}>('SELECT payload FROM native_emoji_catalog WHERE singleton=1',[]);
      return row?.payload?emojiCatalog(JSON.parse(row.payload)):null;
    });
  }
  invalidateEmojis(revision:string,valid:()=>boolean):Promise<boolean> {
    const incoming=emojiRevision(revision);
    return this.atomic(async()=>{
      if(!valid()||!await this.sameGeneration())return false;
      const old=await this.db.getFirstAsync<{revision:string}>('SELECT revision FROM native_emoji_catalog WHERE singleton=1',[]);
      if(old&&emojiRevision(old.revision)>=incoming)return false;
      await this.db.runAsync('INSERT INTO native_emoji_catalog(singleton,revision,payload) VALUES(1,?,NULL) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=NULL',[revision]);
      if(!valid())throw new Error('emoji_scope_closed');
      return true;
    });
  }
  saveEmojis(value:import('./protocol.generated.ts').EmojiCatalog,valid:()=>boolean):Promise<boolean> {
    const catalog=emojiCatalog(value),payload=JSON.stringify(catalog);
    return this.atomic(async()=>{
      if(!valid()||!await this.sameGeneration())return false;
      const old=await this.db.getFirstAsync<{revision:string;payload:string|null}>('SELECT revision,payload FROM native_emoji_catalog WHERE singleton=1',[]);
      if(old&&emojiRevision(old.revision)>emojiRevision(catalog.revision))return false;
      if(old?.revision===catalog.revision&&old.payload!==null){
        if(old.payload!==payload)throw new Error('invalid_emoji_catalog');
        return true;
      }
      await this.db.runAsync('INSERT INTO native_emoji_catalog(singleton,revision,payload) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',[catalog.revision,payload]);
      if(!valid())throw new Error('emoji_scope_closed');
      return true;
    });
  }
  private async sameGeneration(): Promise<boolean> {
    const state = await this.db.getFirstAsync<NativeState>('SELECT instance_id,data_epoch,cursor FROM native_sync_state WHERE singleton=1', []);
    return state?.instance_id === this.session.nativeInstanceId && state?.data_epoch === this.session.nativeDataEpoch;
  }
  /** Shared UI queries must never see a predecessor generation's cache. */
  prepare(): Promise<void> {
    return this.atomic(async () => {
      if (await this.sameGeneration()) return;
      for (const table of ['salons','abonnements','messages','sortie','televersements','brouillons','native_positions','native_sync_state','etat_synchro','utilisateurs','native_room_creations','native_commands','native_star_states','native_meeting_intents','native_room_operations','native_profile_operations','native_emoji_catalog','native_upload_intents','native_room_access','native_read_states','native_read_intents','native_favorite_intents','native_quote_references','native_quote_sources','native_outbox_quotes','native_thread_states','native_thread_read_intents']) await this.db.runAsync(`DELETE FROM ${table}`, []);
    });
  }
  private async membershipMatches(rid:string,membership:string|null):Promise<boolean> {
    return await this.sameGeneration() && !!await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?',[rid]) && ((await this.readStateIn(rid))?.membership_version??null)===membership;
  }
  drafts(scope?:{room:string;membership:string|null}): DepotBrouillons {
    const room=(key:string)=>key.split(':')[0];
    const bound=async(key:string)=>!scope || scope.room===room(key) && await this.membershipMatches(scope.room,scope.membership);
    return {
      lire:rid => this.queue(async () => {
        if (!await this.sameGeneration() || !await bound(rid)) return null;
        return (await this.db.getFirstAsync<{texte:string}>('SELECT texte FROM brouillons WHERE cle=?',[rid]))?.texte ?? null;
      }),
      ecrire:(rid,text) => this.atomic(async () => {
        if (!await this.sameGeneration() || !await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?',[room(rid)]) || !await bound(rid)) return;
        await this.db.runAsync('INSERT INTO brouillons(cle,texte,mis_a_jour_le) VALUES(?,?,?) ON CONFLICT(cle) DO UPDATE SET texte=excluded.texte,mis_a_jour_le=excluded.mis_a_jour_le',[rid,text,Date.now()]);
      }),
      supprimer:rid => this.atomic(async () => {
        if (await this.sameGeneration() && await bound(rid)) await this.db.runAsync('DELETE FROM brouillons WHERE cle=?',[rid]);
      }),
    };
  }
  private async cursor(cursor: string): Promise<void> {
    await this.db.runAsync('INSERT INTO native_sync_state(singleton,instance_id,data_epoch,cursor) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,data_epoch=excluded.data_epoch,cursor=excluded.cursor', [this.session.nativeInstanceId!, this.session.nativeDataEpoch!, cursor]);
  }
  private async readStateIn(rid:string):Promise<ReadState|null> {
    const row=await this.db.getFirstAsync<{payload:string}>('SELECT payload FROM native_read_states WHERE rid=?',[rid]);
    return row?readState(JSON.parse(row.payload),rid):null;
  }
  private async personalRoom(room:Room,known:boolean):Promise<boolean> {
    if(!room.read_state)return false;
    const state=readState(room.read_state,room.id),old=await this.readStateIn(room.id);
    const order=old?readOrder(state,old):null;
    if(order==='older')return false;
    const reset=order==='reset' || !old && known && state.membership_version!=null;
    if(reset)await this.remove(room.id,true);
    await this.db.runAsync('INSERT INTO native_read_states(rid,payload) VALUES(?,?) ON CONFLICT(rid) DO UPDATE SET payload=excluded.payload',[room.id,JSON.stringify(state)]);
    await this.satisfyReadIntents(state);
    return reset;
  }
  private async room(room: Room): Promise<boolean> {
    if(!/^(0|[1-9]\d*)$/.test(room.revision))throw new Error('Invalid native room version');
    const previous=await this.db.getFirstAsync<NativeRoomAccess>('SELECT * FROM native_room_access WHERE rid=?',[room.id]);
    const known=!!await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?',[room.id]);
    const reset=await this.personalRoom(room,known);
    const personal=await this.readStateIn(room.id),favori=personal?.favorite??false,badges=readBadges(personal);
    await this.projectReadState(room.id,personal);
    if(previous && BigInt(previous.revision)>BigInt(room.revision)){
      if(reset){
        await this.db.runAsync('INSERT INTO native_room_access(rid,revision) VALUES(?,?)',[room.id,previous.revision]);
        await this.db.runAsync(UPSERT_ABONNEMENT,paramsAbonnement({rid:room.id,subId:null,...badges,ouvert:true,favori,luJusquA:null,e2eKey:null,e2eKeyId:null,roles:null,misAJourLe:Date.now()}));
        await this.preview(room.id);
      }
      return reset;
    }
    await this.db.runAsync('INSERT INTO native_room_access(rid,revision) VALUES(?,?) ON CONFLICT(rid) DO UPDATE SET revision=excluded.revision,read_only=NULL,can_send=NULL,role=NULL WHERE revision<>excluded.revision',[room.id,room.revision]);
    const access=await this.db.getFirstAsync<NativeRoomAccess>('SELECT * FROM native_room_access WHERE rid=?',[room.id]);
    await this.db.runAsync(UPSERT_SALON, paramsSalon({
      rid: room.id, type: room.kind === 'direct' ? 'd' : room.kind === 'private' ? 'p' : 'c',
      nom: room.name, nomAffiche: room.name, chiffre: false, lectureSeule: access?.can_send===0,
      dmAutreUid: null, dmAutreUsername: null, dernierMessage: null, dernierMessageType: null,
      horodatageDernierMessage: null, avatarEtag: null, misAJourLe: Date.now(),
    }));
    await this.db.runAsync(UPSERT_ABONNEMENT, paramsAbonnement({
      rid: room.id, subId: null, ...badges,
      ouvert: true, favori, luJusquA: null, e2eKey: null, e2eKeyId: null,
      roles: null, misAJourLe: Date.now(),
    }));
    await this.preview(room.id);
    return reset;
  }
  private async preview(rid: string): Promise<void> {
    const last = await this.db.getFirstAsync<{texte:string;horodatage:number;type_systeme:string|null}>('SELECT m.texte,m.horodatage,m.type_systeme FROM messages m JOIN native_positions p ON p.id=m.id WHERE m.rid=? ORDER BY length(p.position) DESC,p.position DESC LIMIT 1',[rid]);
    await this.db.runAsync('UPDATE salons SET dernier_message=?,horodatage_dernier_message=?,dernier_message_type=? WHERE rid=?',[last?.texte??null,last?.horodatage??null,last?.type_systeme??null,rid]);
  }
  private async message(message: Message): Promise<void> {
    // An HTTP echo/history response may arrive after a committed room_removed.
    if (!await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?', [message.room_id])) return;
    const existing = await this.db.getFirstAsync<{revision: string;rid:string}>('SELECT revision,rid FROM native_positions WHERE id=?', [message.id]);
    if(existing && existing.rid!==message.room_id)throw new Error('Mismatched native message room');
    const publicFresh=!existing || BigInt(existing.revision)<=BigInt(message.revision);
    if (!publicFresh && !await this.db.getFirstAsync('SELECT id FROM messages WHERE id=?',[message.id])) return;
    let personal=await this.db.getFirstAsync<{revision:string;present:number}>('SELECT revision,present FROM native_star_states WHERE id=?',[message.id]);
    if (!message.deleted && message.personal_star) {
      const next=message.personal_star;
      if (!/^(0|[1-9]\d*)$/.test(next.revision)) throw new Error('Invalid personal revision');
      if (!personal || BigInt(next.revision)>=BigInt(personal.revision)) {
        await this.db.runAsync('INSERT INTO native_star_states(id,rid,revision,present) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,present=excluded.present',[message.id,message.room_id,next.revision,Number(next.present)]);
        personal={revision:next.revision,present:Number(next.present)};
      }
    }
    const stars=personal?.present?JSON.stringify([this.session.userId]):null;
    if (!publicFresh) {
      await this.quotes.project(message,false);
      await this.db.runAsync('UPDATE messages SET etoiles=? WHERE id=?',[stars,message.id]);
      return;
    }
    const local = localMessage(message,this.session.userId);
    if((message.deleted || message.revision!==message.position) && existing?.revision!==message.revision)this.searchRevision++;
    local.etoiles=stars;
    if (message.deleted) {
      await this.db.runAsync('DELETE FROM messages WHERE id=?',[message.id]);
      await this.db.runAsync('DELETE FROM native_star_states WHERE id=?',[message.id]);
    } else await this.db.runAsync(NATIVE_UPSERT_MESSAGE, paramsMessage(local));
    await this.db.runAsync('INSERT INTO native_positions(id,rid,position,revision,reply_to) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,revision=excluded.revision,reply_to=excluded.reply_to', [message.id, message.room_id, message.position, message.revision,message.reply_to??null]);
    await this.quotes.project(message,true);
    await this.db.runAsync(SUPPRIMER_SORTIE, [message.id]);
    await this.db.runAsync('DELETE FROM native_outbox_quotes WHERE id=?',[message.id]);
    await this.preview(message.room_id);
  }
  private async remove(rid: string,keepMetadata=false): Promise<void> {
    for (const table of ['salons', 'abonnements', 'messages', 'sortie', 'televersements', 'native_positions','native_commands','native_star_states','native_meeting_intents','native_room_operations','native_upload_intents','native_room_access','native_read_states','native_read_intents','native_favorite_intents','native_quote_references','native_quote_sources','native_outbox_quotes','native_thread_states','native_thread_read_intents']) {
      if(keepMetadata && table==='salons')continue;
      await this.db.runAsync(`DELETE FROM ${table} WHERE rid=?`, [rid]);
    }
    if(keepMetadata)await this.db.runAsync('UPDATE salons SET lecture_seule=0 WHERE rid=?',[rid]);
    await this.db.runAsync(SUPPRIMER_BROUILLONS_SALON, [rid]);
    await this.db.runAsync("DELETE FROM etat_synchro WHERE portee=?", [rid]);
    await this.quotes.refreshOrigin(rid);
  }
  applySnapshot(snapshot: Snapshot): Promise<void> {
    return this.atomic(async () => {
      const old = await this.db.getFirstAsync<NativeState>('SELECT instance_id,data_epoch,cursor FROM native_sync_state WHERE singleton=1', []);
      if (!old || old.instance_id !== this.session.nativeInstanceId || old.data_epoch !== this.session.nativeDataEpoch) {
        // A fresh login to a different generation must never replay its predecessor's outbox.
        for (const table of ['salons', 'abonnements', 'messages', 'sortie', 'televersements', 'brouillons', 'native_positions', 'etat_synchro', 'utilisateurs', 'native_room_creations','native_commands','native_star_states','native_meeting_intents','native_room_operations','native_profile_operations','native_emoji_catalog','native_upload_intents','native_room_access','native_read_states','native_read_intents','native_favorite_intents','native_quote_references','native_quote_sources','native_outbox_quotes','native_thread_states','native_thread_read_intents']) await this.db.runAsync(`DELETE FROM ${table}`, []);
      } else {
        const live = new Set(snapshot.rooms.map(room => room.id));
        const known = await this.db.getAllAsync<{rid:string}>('SELECT rid FROM salons', []);
        for (const {rid} of known) if (!live.has(rid)) await this.remove(rid);
        await this.db.runAsync('DELETE FROM native_quote_references WHERE message_id IN (SELECT id FROM native_positions)',[]);
        await this.db.runAsync('DELETE FROM native_quote_sources',[]);
        await this.db.runAsync('DELETE FROM messages WHERE id IN (SELECT id FROM native_positions)',[]);
        await this.db.runAsync('DELETE FROM native_positions',[]);
        await this.db.runAsync('DELETE FROM native_star_states',[]);
      }
      for (const room of snapshot.rooms) await this.room(room);
      for (const message of snapshot.messages) await this.message(message);
      await this.cursor(snapshot.cursor);
    },true);
  }
  applyBatch(batch: SyncBatch): Promise<void> {
    let rotate=batch.changes.some(change=>change.type==='room_removed');
    return this.atomic(async () => {
      if (!await this.sameGeneration()) throw new Error('Native generation unavailable');
      for (const change of batch.changes) {
        switch (change.type) {
          case 'room_upsert': rotate=(await this.room(change.data)) || rotate; break;
          case 'message_upsert': await this.message(change.data); break;
          case 'room_removed': await this.remove(change.data.room_id); break;
        }
      }
      await this.cursor(batch.cursor);
    },()=>rotate);
  }
  ingest(messages: Message[], token=this.projectionToken()): Promise<boolean> {
    return this.atomic(async () => {
      if (!await this.sameGeneration()) throw new Error('Native generation unavailable');
      if (token!==this.projectionToken()) return false;
      for (const message of messages) await this.message(message);
      return true;
    });
  }
  cacheThread(page:import('./protocol.generated.ts').ThreadPage,token:number):Promise<boolean>{
    return this.atomic(async()=>{
      if(!await this.sameGeneration() || token!==this.projectionToken())return false;
      if(page.root.reply_to!=null || page.root.system!=null || page.read_state.root_id!==page.root.id || page.read_state.room_id!==page.root.room_id || page.messages.some(m=>m.room_id!==page.root.room_id || m.reply_to!==page.root.id || m.id===page.root.id))throw new Error('Invalid native thread page');
      await this.threads.save(page.read_state);
      for(const message of [page.root,...page.messages])await this.message(message);
      return true;
    });
  }
  stageThreadRead(root:string,id:string,membership:string):Promise<boolean>{
    return this.atomic(async()=>await this.sameGeneration()?this.threads.stage(root,id,membership):false);
  }
  pendingThreadReads():Promise<PendingThreadRead[]>{
    return this.atomic(async()=>await this.sameGeneration()?this.threads.pending():[]);
  }
  completeThreadRead(state:import('./protocol.generated.ts').ThreadReadState,token:number):Promise<boolean>{
    return this.atomic(async()=>{if(!await this.sameGeneration() || token!==this.projectionToken())return false;await this.threads.save(state);return true;});
  }
  rooms(): Promise<NativeRoomRow[]> {
    return this.queue(async () => await this.sameGeneration() ? this.db.getAllAsync<NativeRoomRow>('SELECT rid,COALESCE(nom_affiche,nom,rid) AS nom,type,dernier_message FROM salons ORDER BY COALESCE(horodatage_dernier_message,0) DESC,rid', []) : []);
  }
  roomAccess(rid:string):Promise<NativeRoomAccess|null> {
    return this.queue(async()=>await this.sameGeneration()?this.db.getFirstAsync<NativeRoomAccess>('SELECT * FROM native_room_access WHERE rid=?',[rid]):null);
  }
  readState(rid:string):Promise<ReadState|null> {
    return this.queue(async()=>await this.sameGeneration()?this.readStateIn(rid):null);
  }
  cacheReadState(value:ReadState,token:number):Promise<boolean> {
    const state=readState(value,value.room_id);
    return this.atomic(async()=>{
      if(!await this.sameGeneration() || token!==this.projectionToken())return false;
      const old=await this.readStateIn(state.room_id);
      if(!old || readOrder(state,old)!=='same')return false;
      if(state.revision===old.revision)return true;
      await this.db.runAsync('UPDATE native_read_states SET payload=? WHERE rid=?',[JSON.stringify(state),state.room_id]);
      await this.projectReadState(state.room_id,state);
      await this.satisfyReadIntents(state);
      return true;
    });
  }
  private async projectReadState(rid:string,state:ReadState|null):Promise<void> {
    const {nonLus,mentions,mentionsGroupe,alerte}=readBadges(state),favorite=Number(state?.favorite??false);
    await this.db.runAsync('UPDATE abonnements SET non_lus=?,mentions=?,mentions_groupe=?,alerte=?,favori=? WHERE rid=? AND (non_lus<>? OR mentions<>? OR mentions_groupe<>? OR alerte<>? OR favori<>?)',[nonLus,mentions,mentionsGroupe,Number(alerte),favorite,rid,nonLus,mentions,mentionsGroupe,Number(alerte),favorite]);
  }
  private async satisfyReadIntents(state:ReadState):Promise<void> {
    if(!state.membership_version)return;
    const root=await this.db.getFirstAsync<{root_position:string}>('SELECT root_position FROM native_read_intents WHERE rid=? AND membership=?',[state.room_id,state.membership_version]);
    if(root && readDecimal(root.root_position)<=readDecimal(state.root_position))await this.db.runAsync('DELETE FROM native_read_intents WHERE rid=? AND membership=?',[state.room_id,state.membership_version]);
    const saved=await this.db.getFirstAsync<FavoriteRow>(`${FAVORITE_SELECT} WHERE rid=? AND membership=? AND phase='confirmed'`,[state.room_id,state.membership_version]);
    if(saved){
      const intention=savedFavorite(saved);
      if(state.favorite_revision!=null && readDecimal(state.favorite_revision)>=readDecimal(intention.receiptRevision!))await this.db.runAsync('DELETE FROM native_favorite_intents WHERE id=?',[saved.id]);
    }
  }
  stageRead(rid:string,observed:string,membership?:string):Promise<boolean> {
    if(![rid,observed].every(roomIdentifier))throw new Error('Invalid observed native message');
    if(membership!==undefined && !roomIdentifier(membership))throw new Error('Invalid native membership');
    return this.atomic(async()=>{
      if(!await this.sameGeneration())throw new Error('Native generation unavailable');
      const state=await this.readStateIn(rid);
      if(membership!==undefined && !await this.membershipMatches(rid,membership))return false;
      if(!state?.membership_version)throw new Error('Native membership unavailable');
      const row=await this.db.getFirstAsync<{position:string}>('SELECT p.position FROM native_positions p JOIN messages m ON m.id=p.id WHERE p.id=? AND p.rid=? AND m.rid=?',[observed,rid,rid]);
      if(!row || readDecimal(row.position)<=readDecimal(state.root_position))return false;
      const previous=await this.db.getFirstAsync<{root_position:string}>('SELECT root_position FROM native_read_intents WHERE rid=? AND membership=?',[rid,state.membership_version]);
      if(previous && readDecimal(previous.root_position)>=readDecimal(row.position))return false;
      await this.db.runAsync('INSERT INTO native_read_intents(rid,membership,root_position) VALUES(?,?,?) ON CONFLICT(rid) DO UPDATE SET membership=excluded.membership,root_position=excluded.root_position',[rid,state.membership_version,row.position]);
      return true;
    });
  }
  pendingReads():Promise<PendingRead[]> {
    return this.queue(async()=>{
      if(!await this.sameGeneration())return [];
      const rows=await this.db.getAllAsync<{rid:string;membership:string;root_position:string}>("SELECT q.* FROM native_read_intents q JOIN native_read_states s ON s.rid=q.rid WHERE q.membership=json_extract(s.payload,'$.membership_version') ORDER BY q.rowid",[]);
      return rows.map(row=>{readDecimal(row.root_position);if(![row.rid,row.membership].every(roomIdentifier))throw new Error('Invalid saved read');return {room:row.rid,membership:row.membership,root_position:row.root_position};});
    });
  }
  favoriteIntent(rid:string):Promise<SavedFavorite|null> {
    return this.queue(async()=>{
      if(!await this.sameGeneration())return null;
      const row=await this.db.getFirstAsync<FavoriteRow>(`${FAVORITE_SELECT} WHERE rid=?`,[rid]);return row?savedFavorite(row):null;
    });
  }
  stageFavorite(rid:string,present:boolean,id:()=>string,observed?:{membership:string;revision:string}):Promise<SavedFavorite|null> {
    if(!roomIdentifier(rid))throw new Error('Invalid native room');
    return this.atomic(async()=>{
      if(!await this.sameGeneration())throw new Error('Native generation unavailable');
      const state=await this.readStateIn(rid);
      if(!state?.membership_version || state.favorite_revision==null)throw new Error('Native personal state unavailable');
      if(observed && (observed.membership!==state.membership_version || observed.revision!==state.favorite_revision))return null;
      const row=await this.db.getFirstAsync<FavoriteRow>(`${FAVORITE_SELECT} WHERE rid=?`,[rid]);
      if(row){const old=savedFavorite(row);return old.phase!=='failed' && old.membership===state.membership_version && old.input.present===present?old:null;}
      const input={operation_id:id(),expected_revision:state.favorite_revision,present};
      const saved=savedFavorite({id:input.operation_id,rid,membership:state.membership_version,payload:JSON.stringify(input),phase:'pending',receipt_revision:null,error:null});
      await this.db.runAsync('INSERT INTO native_favorite_intents(id,rid,membership,payload) VALUES(?,?,?,?)',[input.operation_id,rid,state.membership_version,JSON.stringify(input)]);
      return saved;
    });
  }
  pendingFavorites():Promise<SavedFavorite[]> {
    return this.queue(async()=>await this.sameGeneration()?(await this.db.getAllAsync<FavoriteRow>(`${FAVORITE_SELECT} WHERE phase IN ('pending','confirmed') ORDER BY rowid`,[])).map(savedFavorite):[]);
  }
  confirmFavoriteReceipt(value:import('./protocol.generated.ts').RoomCommandReceipt,token:number):Promise<boolean> {
    const receipt=decodeNative('RoomCommandReceipt',value);readDecimal(receipt.applied_revision);
    if(![receipt.operation_id,receipt.room_id].every(roomIdentifier))throw new Error('Invalid favorite receipt');
    return this.atomic(async()=>{
      if(!await this.sameGeneration() || token!==this.projectionToken())return false;
      const row=await this.db.getFirstAsync<FavoriteRow>(`${FAVORITE_SELECT} WHERE id=?`,[receipt.operation_id]);
      if(!row)return false;
      const saved=savedFavorite(row);
      if(saved.room!==receipt.room_id || readDecimal(receipt.applied_revision)<readDecimal(saved.input.expected_revision))throw new Error('Mismatched favorite receipt');
      const state=await this.readStateIn(saved.room);
      if(state?.membership_version!==saved.membership)return false;
      await this.db.runAsync("UPDATE native_favorite_intents SET phase='confirmed',receipt_revision=?,error=NULL WHERE id=?",[receipt.applied_revision,receipt.operation_id]);
      await this.satisfyReadIntents(state);return true;
    });
  }
  failFavorite(rid:string,id:string,code:string):Promise<void> {
    if(!roomIdentifier(code))throw new Error('Invalid favorite failure');
    return this.atomic(async()=>{if(await this.sameGeneration())await this.db.runAsync("UPDATE native_favorite_intents SET phase='failed',error=? WHERE rid=? AND id=? AND phase='pending'",[code,rid,id]);});
  }
  dismissFailedFavorite(rid:string,id:string):Promise<boolean> {
    return this.atomic(async()=>{
      if(!await this.sameGeneration() || !await this.db.getFirstAsync("SELECT id FROM native_favorite_intents WHERE rid=? AND id=? AND phase='failed'",[rid,id]))return false;
      await this.db.runAsync("DELETE FROM native_favorite_intents WHERE rid=? AND id=? AND phase='failed'",[rid,id]);return true;
    });
  }
  cacheRoomAccess(details:RoomDetails,token:number):Promise<boolean> {
    return this.atomic(async()=>{
      if(!await this.sameGeneration() || token!==this.projectionToken())return false;
      const current=await this.db.getFirstAsync<NativeRoomAccess>('SELECT * FROM native_room_access WHERE rid=?',[details.room.id]);
      if(current?.revision!==details.room.revision)return false;
      if(current.read_only===Number(details.read_only) && current.can_send===Number(details.permissions.send) && current.role===details.permissions.role)return true;
      await this.db.runAsync('UPDATE native_room_access SET read_only=?,can_send=?,role=? WHERE rid=? AND revision=?',[Number(details.read_only),Number(details.permissions.send),details.permissions.role,details.room.id,details.room.revision]);
      // Shared room rows express effective write access; the info panel reads the
      // actual room-wide read_only flag from RoomDetails.
      await this.db.runAsync('UPDATE salons SET lecture_seule=? WHERE rid=?',[Number(!details.permissions.send),details.room.id]);
      return true;
    });
  }
  roomOperation(rid:string):Promise<SavedRoomOperation|null> {
    return this.queue(async()=>{
      if(!await this.sameGeneration())return null;
      const row=await this.db.getFirstAsync<RoomOperationRow>('SELECT id,rid,payload,state,error FROM native_room_operations WHERE rid=?',[rid]);
      return row?savedRoomOperation(row):null;
    });
  }
  stageRoomOperation(rid:string,value:RoomOperation):Promise<SavedRoomOperation|null> {
    const command=roomOperation(value);
    if(!roomIdentifier(rid))throw new Error('Invalid room intention');
    return this.atomic(async()=>{
      if(!await this.sameGeneration() || !await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?',[rid]))throw new Error('Room unavailable in this generation');
      const row=await this.db.getFirstAsync<RoomOperationRow>('SELECT id,rid,payload,state,error FROM native_room_operations WHERE rid=?',[rid]);
      if(row){const saved=savedRoomOperation(row);return !saved.failed && sameRoomForm(saved.command,command)?saved:null;}
      await this.db.runAsync('INSERT INTO native_room_operations(id,rid,payload) VALUES(?,?,?)',[command.input.operation_id,rid,JSON.stringify(command)]);
      return {room:rid,command,failed:false,error:null};
    });
  }
  pendingRoomOperations():Promise<SavedRoomOperation[]> {
    return this.queue(async()=>await this.sameGeneration()?(await this.db.getAllAsync<RoomOperationRow>("SELECT id,rid,payload,state,error FROM native_room_operations WHERE state='pending' ORDER BY rowid",[])).map(savedRoomOperation):[]);
  }
  failRoomOperation(rid:string,id:string,error:string):Promise<void> {
    if(!roomIdentifier(error))throw new Error('Invalid room failure');
    return this.atomic(async()=>{if(await this.sameGeneration())await this.db.runAsync("UPDATE native_room_operations SET state='failed',error=? WHERE rid=? AND id=?",[error,rid,id]);});
  }
  dismissRoomOperation(rid:string,id:string):Promise<boolean> {
    return this.atomic(async()=>{
      if(!await this.sameGeneration())return false;
      const failed=await this.db.getFirstAsync("SELECT id FROM native_room_operations WHERE rid=? AND id=? AND state='failed'",[rid,id]);
      if(!failed)return false;
      await this.db.runAsync("DELETE FROM native_room_operations WHERE rid=? AND id=? AND state='failed'",[rid,id]);return true;
    });
  }
  confirmRoomOperation(value:import('./protocol.generated.ts').RoomCommandReceipt):Promise<boolean> {
    const receipt=decodeNative('RoomCommandReceipt',value);
    if(![receipt.operation_id,receipt.room_id,receipt.applied_revision].every(roomIdentifier))throw new Error('Invalid room acknowledgement');
    return this.atomic(async()=>{
      if(!await this.sameGeneration())return false;
      const row=await this.db.getFirstAsync<RoomOperationRow>('SELECT id,rid,payload,state,error FROM native_room_operations WHERE id=?',[receipt.operation_id]);
      if(!row)return false;
      if(savedRoomOperation(row).room!==receipt.room_id)throw new Error('Mismatched room acknowledgement');
      await this.db.runAsync('DELETE FROM native_room_operations WHERE id=?',[receipt.operation_id]);
      // A personal receipt never writes an old room payload into the projection.
      return true;
    });
  }
  async roomCreation(name: string, privateRoom: boolean, generateId: () => string): Promise<string> {
    let id='';
    await this.atomic(async () => {
      if (!await this.sameGeneration()) throw new Error('Native generation unavailable');
      const previous = await this.db.getFirstAsync<{id:string}>('SELECT id FROM native_room_creations WHERE name=? AND private=?',[name,privateRoom?1:0]);
      if (previous) { id=previous.id; return; }
      id=generateId();
      await this.db.runAsync('INSERT INTO native_room_creations(id,name,private) VALUES(?,?,?)',[id,name,privateRoom?1:0]);
    });
    return id;
  }
  completeRoomCreation(id: string): Promise<void> {
    return this.queue(async () => { await this.db.runAsync('DELETE FROM native_room_creations WHERE id=?',[id]); });
  }
  command(rid: string, message: string, revision: string, kind: NativeCommand['kind'], text: string, id: ()=>string): Promise<NativeCommand|null> {
    return this.atomic(async () => {
      if (!/^(0|[1-9]\d*)$/.test(revision) || !await this.sameGeneration()) throw new Error('Native command unavailable');
      const saved=await this.db.getFirstAsync<NativeCommandRow>("SELECT id,rid,message_id,kind,expected_revision,text,quotes FROM native_commands WHERE message_id=? AND state='pending'",[message]);
      const previous=saved?commandRow(saved):null;
      if (previous) return previous.rid===rid && previous.kind===kind && previous.text===text?previous:null;
      if (!await this.db.getFirstAsync('SELECT m.id FROM messages m JOIN native_positions p ON p.id=m.id WHERE m.id=? AND m.rid=?',[message,rid])) throw new Error('Message unavailable');
      let stale=false;
      if(kind==='edit'){
        const current=await this.db.getFirstAsync<{revision:string}>('SELECT revision FROM native_positions WHERE id=?',[message]);
        stale=current?.revision!==revision;
      }
      const quotes=stale?null:kind==='edit'?await this.quotes.references(message):[];
      await this.db.runAsync("DELETE FROM native_commands WHERE message_id=? AND state='failed'",[message]);
      const command: NativeCommand={id:id(),rid,message_id:message,kind,expected_revision:revision,text,quotes};
      await this.db.runAsync('INSERT INTO native_commands(id,rid,message_id,kind,expected_revision,text,quotes,state,error) VALUES(?,?,?,?,?,?,?,?,?)',[command.id,rid,message,kind,revision,text,quotes===null?null:JSON.stringify(quotes),stale?'failed':'pending',stale?'revision_conflict':null]);
      return stale?null:command;
    });
  }
  hasCommandRevisionConflict(id:string):Promise<boolean> {
    return this.queue(async()=>await this.sameGeneration() && await this.db.getFirstAsync("SELECT id FROM native_commands WHERE message_id=? AND state='failed' AND error='revision_conflict'",[id])!==null);
  }
  pendingCommands(): Promise<NativeCommand[]> {
    return this.queue(async () => {
      if (!await this.sameGeneration()) return [];
      const rows=await this.db.getAllAsync<NativeCommandRow>("SELECT id,rid,message_id,kind,expected_revision,text,quotes FROM native_commands WHERE state='pending' ORDER BY rowid",[]);
      const commands=rows.map(commandRow);
      if (commands.some(c => !['edit','delete','react','pin','star'].includes(c.kind))) throw new Error('Invalid native command');
      return commands;
    });
  }
  failCommand(id: string,code: string): Promise<void> {
    return this.queue(async () => {await this.db.runAsync("UPDATE native_commands SET state='failed',error=? WHERE id=?",[code,id]);});
  }
  commandDraft(id: string): Promise<string|null> {
    return this.queue(async () => {
      if (!await this.sameGeneration()) return null;
      return (await this.db.getFirstAsync<{text:string}>("SELECT text FROM native_commands WHERE message_id=? AND kind='edit'",[id]))?.text ?? null;
    });
  }
  confirmCommand(id: string,message: Message,token: number): Promise<boolean> {
    return this.atomic(async () => {
      if (!await this.sameGeneration()) throw new Error('Native generation unavailable');
      if (token!==this.projectionToken()) return false;
      const command=await this.db.getFirstAsync<{message_id:string;rid:string}>('SELECT message_id,rid FROM native_commands WHERE id=?',[id]);
      if (!command) return true;
      if (command.message_id!==message.id || command.rid!==message.room_id) throw new Error('Mismatched command acknowledgement');
      await this.message(message);
      await this.db.runAsync('DELETE FROM native_commands WHERE id=?',[id]);
      return true;
    });
  }
  messageRank(rid:string,id:string):Promise<number|null> {
    return this.queue(async()=>{
      if(!await this.sameGeneration())return null;
      const target=await this.db.getFirstAsync<{position:string}>('SELECT p.position FROM messages m JOIN native_positions p ON p.id=m.id WHERE m.id=? AND m.rid=? AND m.fil_id IS NULL',[id,rid]);
      if(!target)return null;
      const row=await this.db.getFirstAsync<{n:number}>('SELECT count(*) AS n FROM messages m LEFT JOIN native_positions p ON p.id=m.id WHERE m.rid=? AND m.fil_id IS NULL AND (p.position IS NULL OR length(p.position)>length(?) OR (length(p.position)=length(?) AND p.position>?))',[rid,target.position,target.position,target.position]);
      return row?.n??null;
    });
  }
  messages(rid: string, limit = 500): Promise<NativeMessageRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid message window');
    return this.queue(async () => await this.sameGeneration() ? this.db.getAllAsync<NativeMessageRow>('SELECT m.id,m.texte,m.auteur_nom,m.auteur_id,m.horodatage,s.statut FROM messages m LEFT JOIN sortie s ON s.id=m.id LEFT JOIN native_positions p ON p.id=m.id WHERE m.rid=? ORDER BY p.position IS NULL DESC,length(p.position) DESC,p.position DESC,m.horodatage DESC,m.id DESC LIMIT ?', [rid,limit]) : []);
  }
  oldestPosition(rid: string): Promise<string | undefined> {
    return this.queue(async () => (await this.db.getFirstAsync<{position:string}>('SELECT position FROM native_positions WHERE rid=? AND reply_to IS NULL ORDER BY length(position),position LIMIT 1', [rid]))?.position);
  }
  quoteSelection(rid:string,id:string):Promise<NativeQuoteSelection> {
    return this.queue(async()=>{if(!await this.sameGeneration())throw new Error('Native quote generation unavailable');return this.quotes.selection(rid,id);});
  }
  enqueue(id: string, rid: string, text: string,scope?:{membership:string|null},selected:readonly NativeQuoteSelection[]=[],replyTo?:string|null): Promise<void> {
    return this.atomic(async () => {
      if (!await this.sameGeneration() || !await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?', [rid])) throw new Error('Room unavailable in this generation');
      if(scope && !await this.membershipMatches(rid,scope.membership))throw new Error('Native membership changed');
      if(replyTo && !await this.db.getFirstAsync('SELECT m.id FROM messages m JOIN native_positions p ON p.id=m.id WHERE m.id=? AND m.rid=? AND m.fil_id IS NULL AND m.type_systeme IS NULL AND p.position<>\'0\'',[replyTo,rid]))throw new Error('Native thread root unavailable');
      const now = new Date().toISOString();
      const local = localMessage({id,room_id:rid,text,reply_to:replyTo??null,author:{id:this.session.userId,username:this.session.username,display_name:this.session.username},created_at:now,position:'0',revision:'0'});
      local.misAJourLe = 0;
      await this.db.runAsync(UPSERT_MESSAGE, paramsMessage(local));
      const refs=await this.quotes.enqueue(id,rid,selected);
      await this.db.runAsync(INSERER_SORTIE, [id,rid,text,replyTo??null,Date.now()]);
      await this.db.runAsync('INSERT INTO native_outbox_quotes(id,rid,payload) VALUES(?,?,?)',[id,rid,JSON.stringify(refs)]);
    });
  }
  pending(): Promise<NativePending[]> {
    return this.queue(async () => {
      if(!await this.sameGeneration())return [];
      const rows=await this.db.getAllAsync<{id:string;rid:string;texte:string;payload:string;fil_id:string|null}>("SELECT s.id,s.rid,s.texte,s.fil_id,coalesce(q.payload,'[]') AS payload FROM sortie s LEFT JOIN native_outbox_quotes q ON q.id=s.id WHERE s.statut='en-attente' ORDER BY s.cree_le,s.id",[]);
      return rows.map(({payload,fil_id,...row})=>{const raw:unknown=JSON.parse(payload);if(!Array.isArray(raw) || raw.length>8)throw new Error('Invalid native outbox references');return {...row,...(fil_id?{reply_to:fil_id}:{}),quotes:raw.map(r=>decodeNative('QuoteReference',r))};});
    });
  }
  fail(id: string, code: string): Promise<void> { return this.queue(async () => { await this.db.runAsync(MARQUER_SORTIE_ECHEC, [code,id]); }); }
  retry(id: string): Promise<void> { return this.queue(async () => { await this.db.runAsync("UPDATE sortie SET statut='en-attente',derniere_erreur=NULL WHERE id=?", [id]); }); }
  abandon(id: string): Promise<void> {
    return this.atomic(async () => {
      await this.db.runAsync('DELETE FROM native_quote_references WHERE message_id=? AND EXISTS(SELECT 1 FROM sortie WHERE id=?)',[id,id]);
      await this.db.runAsync('DELETE FROM native_outbox_quotes WHERE id=?',[id]);
      await this.db.runAsync('DELETE FROM messages WHERE id=? AND mis_a_jour_le=0', [id]);
      await this.db.runAsync(SUPPRIMER_SORTIE, [id]);
    });
  }
}
