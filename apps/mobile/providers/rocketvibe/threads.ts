/** Thread reads keep the observed reply, never a later cache watermark. */
import type {NativeDatabase} from './store.ts';
import type {ThreadReadState} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {readDecimal,readState} from './readStates.ts';
import {roomIdentifier} from './roomOperations.ts';
export type PendingThreadRead={root:string;rid:string;membership:string;position:string};
export class NativeThreadCache {
  private readonly db:NativeDatabase;
  constructor(db:NativeDatabase){this.db=db;}
  private async membership(rid:string):Promise<string|null>{
    const row=await this.db.getFirstAsync<{payload:string}>('SELECT payload FROM native_read_states WHERE rid=?',[rid]);
    return row?readState(JSON.parse(row.payload),rid).membership_version??null:null;
  }
  async state(root:string):Promise<ThreadReadState|null>{
    const row=await this.db.getFirstAsync<{rid:string;payload:string}>('SELECT rid,payload FROM native_thread_states WHERE root=?',[root]);
    if(!row)return null;
    const state=decodeNative('ThreadReadState',JSON.parse(row.payload));
    return state.membership_version===await this.membership(row.rid)?state:null;
  }
  async save(value:ThreadReadState):Promise<void>{
    const state=decodeNative('ThreadReadState',value);
    for(const id of [state.root_id,state.room_id,state.membership_version])if(!roomIdentifier(id))throw new Error('Invalid native thread identity');
    for(const n of [state.position,state.revision,state.unread])readDecimal(n);
    if(state.membership_version!==await this.membership(state.room_id))throw new Error('Native thread membership changed');
    const old=await this.state(state.root_id);
    if(old && old.room_id!==state.room_id)throw new Error('Native thread room changed');
    if(old && readDecimal(old.revision)>readDecimal(state.revision))return;
    if(old && readDecimal(old.position)>readDecimal(state.position))throw new Error('Native thread read regressed');
    await this.db.runAsync('INSERT INTO native_thread_states(root,rid,payload) VALUES(?,?,?) ON CONFLICT(root) DO UPDATE SET payload=excluded.payload',[state.root_id,state.room_id,JSON.stringify(state)]);
    await this.db.runAsync('DELETE FROM native_thread_read_intents WHERE root=? AND membership=? AND (length(position)<length(?) OR length(position)=length(?) AND position<=?)',[state.root_id,state.membership_version,state.position,state.position,state.position]);
  }
  async stage(root:string,id:string,membership:string):Promise<boolean>{
    const row=await this.db.getFirstAsync<{rid:string;position:string}>('SELECT m.rid,p.position FROM messages m JOIN native_positions p ON p.id=m.id WHERE m.id=? AND m.thread_id=?',[id,root]);
    if(!row || readDecimal(row.position)===0n || membership!==await this.membership(row.rid))return false;
    const old=await this.state(root);
    if(old && readDecimal(old.position)>=readDecimal(row.position))return false;
    const pending=await this.db.getFirstAsync<PendingThreadRead>('SELECT * FROM native_thread_read_intents WHERE root=?',[root]);
    if(pending && pending.membership===membership && readDecimal(pending.position)>=readDecimal(row.position))return false;
    await this.db.runAsync('INSERT INTO native_thread_read_intents(root,rid,membership,position) VALUES(?,?,?,?) ON CONFLICT(root) DO UPDATE SET rid=excluded.rid,membership=excluded.membership,position=excluded.position',[root,row.rid,membership,row.position]);return true;
  }
  async pending():Promise<PendingThreadRead[]>{
    const rows=await this.db.getAllAsync<PendingThreadRead>('SELECT * FROM native_thread_read_intents ORDER BY root',[]),valid:PendingThreadRead[]=[];
    for(const row of rows){
      if(row.membership===await this.membership(row.rid))valid.push(row);
      else await this.db.runAsync('DELETE FROM native_thread_read_intents WHERE root=?',[row.root]);
    }
    return valid;
  }
}
