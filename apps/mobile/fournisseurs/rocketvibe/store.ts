/** SQLite projection for the native protocol. Batches and their cursor commit together. */
import type { Session as AppSession } from '../../lib/auth.ts';
import type { FileEcritures } from '../../db/fileEcritures.ts';
import type { DepotBrouillons } from '../../db/depot.ts';
import { UPSERT_MESSAGE, UPSERT_SALON, UPSERT_ABONNEMENT, INSERER_SORTIE, SUPPRIMER_SORTIE, MARQUER_SORTIE_ECHEC, SUPPRIMER_BROUILLONS_SALON, paramsMessage, paramsSalon, paramsAbonnement } from '../../db/upserts.ts';
import type { MessageLocal } from '../../lib/normaliser.ts';
import type { Message, Room, Snapshot, SyncBatch } from './protocol.generated.ts';

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
export type NativePending = { id: string; rid: string; texte: string };
export type NativeCommand = {id:string;rid:string;message_id:string;kind:'edit'|'delete'|'react';expected_revision:string;text:string};

/** Projection consumed by the existing message renderer and action sheet. */
export function nativeReactions(reactions: Message['reactions']): string|null {
  return reactions?.length ? JSON.stringify(Object.fromEntries(reactions.map(reaction=>[
    `:${reaction.emoji}:`,{usernames:reaction.users.map(user=>user.username)},
  ]))) : null;
}

export function localMessage(message: Message): MessageLocal {
  const time = Date.parse(message.created_at);
  const edited=message.edited_at==null?null:Date.parse(message.edited_at);
  if ((edited!==null && !Number.isFinite(edited)) || (message.deleted && message.text!=='')) throw new Error('Invalid native message state');
  if (!Number.isFinite(time) || !/^\d+$/.test(message.position) || !/^\d+$/.test(message.revision)) throw new Error('Invalid native message ordering');
  return {
    id: message.id, rid: message.room_id, texte: message.text, horodatage: time,
    auteurId: message.author.id, auteurNom: message.author.username, typeSysteme: null,
    filId: null, filReponses: 0, filDernier: null, filAffiche: false, modifieLe: edited,
    md: null, piecesJointes: null, reactions: nativeReactions(message.reactions), urls: null, appelId: null,
    chiffreBrut: null, epingle: false, etoiles: null, misAJourLe: time,
  };
}

export class NativeStore {
  private readonly db: NativeDatabase;
  private readonly queue: FileEcritures;
  private readonly session: AppSession;
  private projection=0;
  constructor(db: NativeDatabase, queue: FileEcritures, session: AppSession) {
    this.db = db; this.queue = queue; this.session = session;
  }
  private atomic<T>(fn: () => Promise<T>, rotate=false): Promise<T> {
    return this.queue(async () => {
      let result!: T;
      await this.db.withTransactionAsync(async () => { result=await fn(); });
      if (rotate) this.projection++;
      return result;
    });
  }
  projectionToken(): number { return this.projection; }
  state(): Promise<NativeState | null> {
    return this.queue(() => this.db.getFirstAsync<NativeState>('SELECT instance_id,data_epoch,cursor FROM native_sync_state WHERE singleton=1', []));
  }
  private async sameGeneration(): Promise<boolean> {
    const state = await this.db.getFirstAsync<NativeState>('SELECT instance_id,data_epoch,cursor FROM native_sync_state WHERE singleton=1', []);
    return state?.instance_id === this.session.nativeInstanceId && state?.data_epoch === this.session.nativeDataEpoch;
  }
  /** Shared UI queries must never see a predecessor generation's cache. */
  prepare(): Promise<void> {
    return this.atomic(async () => {
      if (await this.sameGeneration()) return;
      for (const table of ['salons','abonnements','messages','sortie','televersements','brouillons','native_positions','native_sync_state','etat_synchro','utilisateurs','native_room_creations','native_commands']) await this.db.runAsync(`DELETE FROM ${table}`, []);
    });
  }
  drafts(): DepotBrouillons {
    return {
      lire:rid => this.queue(async () => {
        if (!await this.sameGeneration()) return null;
        return (await this.db.getFirstAsync<{texte:string}>('SELECT texte FROM brouillons WHERE cle=?',[rid]))?.texte ?? null;
      }),
      ecrire:(rid,text) => this.queue(async () => {
        if (!await this.sameGeneration() || !await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?',[rid])) return;
        await this.db.runAsync('INSERT INTO brouillons(cle,texte,mis_a_jour_le) VALUES(?,?,?) ON CONFLICT(cle) DO UPDATE SET texte=excluded.texte,mis_a_jour_le=excluded.mis_a_jour_le',[rid,text,Date.now()]);
      }),
      supprimer:rid => this.queue(async () => {
        if (await this.sameGeneration()) await this.db.runAsync('DELETE FROM brouillons WHERE cle=?',[rid]);
      }),
    };
  }
  private async cursor(cursor: string): Promise<void> {
    await this.db.runAsync('INSERT INTO native_sync_state(singleton,instance_id,data_epoch,cursor) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,data_epoch=excluded.data_epoch,cursor=excluded.cursor', [this.session.nativeInstanceId!, this.session.nativeDataEpoch!, cursor]);
  }
  private async room(room: Room): Promise<void> {
    await this.db.runAsync(UPSERT_SALON, paramsSalon({
      rid: room.id, type: room.kind === 'direct' ? 'd' : room.kind === 'private' ? 'p' : 'c',
      nom: room.name, nomAffiche: room.name, chiffre: false, lectureSeule: false,
      dmAutreUid: null, dmAutreUsername: null, dernierMessage: null, dernierMessageType: null,
      horodatageDernierMessage: null, avatarEtag: null, misAJourLe: Date.now(),
    }));
    await this.db.runAsync(UPSERT_ABONNEMENT, paramsAbonnement({
      rid: room.id, subId: null, nonLus: 0, mentions: 0, mentionsGroupe: 0, alerte: false,
      ouvert: true, favori: false, luJusquA: null, e2eKey: null, e2eKeyId: null,
      roles: null, misAJourLe: Date.now(),
    }));
    await this.preview(room.id);
  }
  private async preview(rid: string): Promise<void> {
    const last = await this.db.getFirstAsync<{texte:string;horodatage:number}>('SELECT m.texte,m.horodatage FROM messages m JOIN native_positions p ON p.id=m.id WHERE m.rid=? ORDER BY length(p.position) DESC,p.position DESC LIMIT 1',[rid]);
    await this.db.runAsync('UPDATE salons SET dernier_message=?,horodatage_dernier_message=? WHERE rid=?',[last?.texte??null,last?.horodatage??null,rid]);
  }
  private async message(message: Message): Promise<void> {
    // An HTTP echo/history response may arrive after a committed room_removed.
    if (!await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?', [message.room_id])) return;
    const existing = await this.db.getFirstAsync<{revision: string}>('SELECT revision FROM native_positions WHERE id=?', [message.id]);
    if (existing && BigInt(existing.revision) > BigInt(message.revision)) return;
    const local = localMessage(message);
    if (message.deleted) await this.db.runAsync('DELETE FROM messages WHERE id=?',[message.id]);
    else await this.db.runAsync(NATIVE_UPSERT_MESSAGE, paramsMessage(local));
    await this.db.runAsync('INSERT INTO native_positions(id,rid,position,revision) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,revision=excluded.revision', [message.id, message.room_id, message.position, message.revision]);
    await this.db.runAsync(SUPPRIMER_SORTIE, [message.id]);
    await this.preview(message.room_id);
  }
  private async remove(rid: string): Promise<void> {
    for (const table of ['salons', 'abonnements', 'messages', 'sortie', 'televersements', 'native_positions','native_commands']) await this.db.runAsync(`DELETE FROM ${table} WHERE rid=?`, [rid]);
    await this.db.runAsync(SUPPRIMER_BROUILLONS_SALON, [rid]);
    await this.db.runAsync("DELETE FROM etat_synchro WHERE portee=?", [rid]);
  }
  applySnapshot(snapshot: Snapshot): Promise<void> {
    return this.atomic(async () => {
      const old = await this.db.getFirstAsync<NativeState>('SELECT instance_id,data_epoch,cursor FROM native_sync_state WHERE singleton=1', []);
      if (!old || old.instance_id !== this.session.nativeInstanceId || old.data_epoch !== this.session.nativeDataEpoch) {
        // A fresh login to a different generation must never replay its predecessor's outbox.
        for (const table of ['salons', 'abonnements', 'messages', 'sortie', 'televersements', 'brouillons', 'native_positions', 'etat_synchro', 'utilisateurs', 'native_room_creations','native_commands']) await this.db.runAsync(`DELETE FROM ${table}`, []);
      } else {
        const live = new Set(snapshot.rooms.map(room => room.id));
        const known = await this.db.getAllAsync<{rid:string}>('SELECT rid FROM salons', []);
        for (const {rid} of known) if (!live.has(rid)) await this.remove(rid);
        await this.db.runAsync('DELETE FROM messages WHERE id IN (SELECT id FROM native_positions)',[]);
        await this.db.runAsync('DELETE FROM native_positions',[]);
      }
      for (const room of snapshot.rooms) await this.room(room);
      for (const message of snapshot.messages) await this.message(message);
      await this.cursor(snapshot.cursor);
    },true);
  }
  applyBatch(batch: SyncBatch): Promise<void> {
    return this.atomic(async () => {
      if (!await this.sameGeneration()) throw new Error('Native generation unavailable');
      for (const change of batch.changes) {
        switch (change.type) {
          case 'room_upsert': await this.room(change.data); break;
          case 'message_upsert': await this.message(change.data); break;
          case 'room_removed': await this.remove(change.data.room_id); break;
        }
      }
      await this.cursor(batch.cursor);
    },batch.changes.some(change => change.type==='room_removed'));
  }
  ingest(messages: Message[], token=this.projectionToken()): Promise<boolean> {
    return this.atomic(async () => {
      if (!await this.sameGeneration()) throw new Error('Native generation unavailable');
      if (token!==this.projectionToken()) return false;
      for (const message of messages) await this.message(message);
      return true;
    });
  }
  rooms(): Promise<NativeRoomRow[]> {
    return this.queue(async () => await this.sameGeneration() ? this.db.getAllAsync<NativeRoomRow>('SELECT rid,COALESCE(nom_affiche,nom,rid) AS nom,type,dernier_message FROM salons ORDER BY COALESCE(horodatage_dernier_message,0) DESC,rid', []) : []);
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
      const previous=await this.db.getFirstAsync<NativeCommand>("SELECT id,rid,message_id,kind,expected_revision,text FROM native_commands WHERE message_id=? AND state='pending'",[message]);
      if (previous) return previous.rid===rid && previous.kind===kind && previous.text===text?previous:null;
      if (!await this.db.getFirstAsync('SELECT m.id FROM messages m JOIN native_positions p ON p.id=m.id WHERE m.id=? AND m.rid=?',[message,rid])) throw new Error('Message unavailable');
      await this.db.runAsync("DELETE FROM native_commands WHERE message_id=? AND state='failed'",[message]);
      const command: NativeCommand={id:id(),rid,message_id:message,kind,expected_revision:revision,text};
      await this.db.runAsync('INSERT INTO native_commands(id,rid,message_id,kind,expected_revision,text) VALUES(?,?,?,?,?,?)',[command.id,rid,message,kind,revision,text]);
      return command;
    });
  }
  pendingCommands(): Promise<NativeCommand[]> {
    return this.queue(async () => {
      if (!await this.sameGeneration()) return [];
      const commands=await this.db.getAllAsync<NativeCommand>("SELECT id,rid,message_id,kind,expected_revision,text FROM native_commands WHERE state='pending' ORDER BY rowid",[]);
      if (commands.some(c => c.kind!=='edit' && c.kind!=='delete' && c.kind!=='react')) throw new Error('Invalid native command');
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
  messages(rid: string, limit = 500): Promise<NativeMessageRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid message window');
    return this.queue(async () => await this.sameGeneration() ? this.db.getAllAsync<NativeMessageRow>('SELECT m.id,m.texte,m.auteur_nom,m.auteur_id,m.horodatage,s.statut FROM messages m LEFT JOIN sortie s ON s.id=m.id LEFT JOIN native_positions p ON p.id=m.id WHERE m.rid=? ORDER BY p.position IS NULL DESC,length(p.position) DESC,p.position DESC,m.horodatage DESC,m.id DESC LIMIT ?', [rid,limit]) : []);
  }
  oldestPosition(rid: string): Promise<string | undefined> {
    return this.queue(async () => (await this.db.getFirstAsync<{position:string}>('SELECT position FROM native_positions WHERE rid=? ORDER BY length(position),position LIMIT 1', [rid]))?.position);
  }
  enqueue(id: string, rid: string, text: string): Promise<void> {
    return this.atomic(async () => {
      if (!await this.sameGeneration() || !await this.db.getFirstAsync('SELECT rid FROM salons WHERE rid=?', [rid])) throw new Error('Room unavailable in this generation');
      const now = new Date().toISOString();
      const local = localMessage({id,room_id:rid,text,author:{id:this.session.userId,username:this.session.username,display_name:this.session.username},created_at:now,position:'0',revision:'0'});
      local.misAJourLe = 0;
      await this.db.runAsync(UPSERT_MESSAGE, paramsMessage(local));
      await this.db.runAsync(INSERER_SORTIE, [id,rid,text,null,Date.now()]);
    });
  }
  pending(): Promise<NativePending[]> {
    return this.queue(async () => await this.sameGeneration() ? this.db.getAllAsync<NativePending>("SELECT id,rid,texte FROM sortie WHERE statut='en-attente' ORDER BY cree_le,id", []) : []);
  }
  fail(id: string, code: string): Promise<void> { return this.queue(async () => { await this.db.runAsync(MARQUER_SORTIE_ECHEC, [code,id]); }); }
  retry(id: string): Promise<void> { return this.queue(async () => { await this.db.runAsync("UPDATE sortie SET statut='en-attente',derniere_erreur=NULL WHERE id=?", [id]); }); }
  abandon(id: string): Promise<void> {
    return this.atomic(async () => {
      await this.db.runAsync('DELETE FROM messages WHERE id=? AND mis_a_jour_le=0', [id]);
      await this.db.runAsync(SUPPRIMER_SORTIE, [id]);
    });
  }
}
